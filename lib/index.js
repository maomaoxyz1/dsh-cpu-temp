/**
 * dsh-cpu-temp —— 宿主半侧（Host）。
 *
 * 职责：读取可用温度源，交给浏览器半侧每秒取一次。
 *
 * 数据源按优先级尝试：
 *   1. 可选外部采样快照（所有系统）：采样器负责硬件访问与权限；本插件只读 JSON。
 *   2. Windows：Windows ACPI thermal-zone 性能计数器（不是可靠的 CPU Package 传感器）。
 *   3. Linux：已知 CPU hwmon 驱动导出的、带有可识别 CPU 标签的温度传感器。
 *   macOS 没有通用的无特权 CPU 温度接口；未配置快照时显示不可用。
 *
 * 为什么不每个请求跑一次 Get-Counter：那样每秒起一个 PowerShell 进程，
 * 开销远超采样本身。这里常驻一个 `typeperf.exe -si 1` 子进程逐行吐 CSV，
 * 请求只读内存里的最新值；60 秒没人取数就把子进程收掉，不空转。
 *
 * 路由：
 *   GET /dsh-cpu-temp/snapshot   → 最新采样（JSON）
 */

import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** 插件名（cordis 插件名，也是客户端本地化命名空间） */
export const name = 'dsh-cpu-temp';

/** 硬依赖：没有 HTTP 载体就没有数据出口 */
export const inject = ['webServer'];

/** 本插件独占的路由前缀（与其它插件的路由不重叠） */
const ROUTE_PREFIX = '/dsh-cpu-temp';
const SNAPSHOT_PATH = ROUTE_PREFIX + '/snapshot';

/** 采样间隔（毫秒）：用户要的就是每秒一次 */
const SAMPLE_INTERVAL_MS = 1000;

/** Optional external sampler snapshot path; Windows default preserves local setup compatibility. */
const HELPER_SNAPSHOT_FILE = process.env.DSH_CPU_TEMP_SNAPSHOT_FILE
  || (process.platform === 'win32' ? 'C:\\Users\\Public\\dsh-cpu-temp\\snapshot.json' : undefined);

/** 快照超过这个年龄就当它不新鲜（仍会展示，但带 stale 标记） */
const HELPER_STALE_MS = 5_000;

/** 超过这个年龄就彻底不信它，回退到性能计数器 */
const HELPER_EXPIRE_MS = 30_000;

/** 计数器路径（按优先级排列） */
const COUNTERS = [
  '\\Thermal Zone Information(*)\\High Precision Temperature',
  '\\Thermal Zone Information(*)\\Temperature',
];

/** 多久没人来取数就把 typeperf 子进程收掉 */
const IDLE_STOP_MS = 60_000;

/** 子进程异常退出后的重启退避 */
const RESTART_DELAY_MS = 3_000;

/** 性能计数器原始值单位是 0.1 K */
const DECI_KELVIN_PER_CELSIUS = 10;
const KELVIN_OFFSET = 273.15;

/** 合理区间：越界视为解析噪声 */
const MIN_CELSIUS = -20;
const MAX_CELSIUS = 150;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 把 CSV 一行拆成字段：`"16:44:03.573","3010.000000"` */
export function splitCsvLine(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      const end = line.indexOf('"', i + 1);
      if (end < 0) {
        out.push(line.slice(i + 1));
        break;
      }
      out.push(line.slice(i + 1, end));
      i = end + 1;
      if (line[i] === ',') i += 1;
    } else {
      const end = line.indexOf(',', i);
      if (end < 0) {
        out.push(line.slice(i));
        break;
      }
      out.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return out;
}

/** 0.1 K → 摄氏度；越界返回 undefined */
export function deciKelvinToCelsius(raw) {
  const celsius = raw / DECI_KELVIN_PER_CELSIUS - KELVIN_OFFSET;
  if (!Number.isFinite(celsius) || celsius < MIN_CELSIUS || celsius > MAX_CELSIUS) return undefined;
  return Math.round(celsius * 10) / 10;
}

/** Parse a typeperf header and return the preferred counter column. */
export function parseTypeperfHeader(line) {
  const fields = splitCsvLine(line);
  const byPriority = [];
  for (let index = 1; index < fields.length; index += 1) {
    const normalized = fields[index].toLowerCase();
    for (let priority = 0; priority < COUNTERS.length; priority += 1) {
      const leaf = COUNTERS[priority].toLowerCase().split('\\').filter(Boolean).pop();
      if (leaf !== undefined && normalized.endsWith(leaf)) {
        const zone = /\(([^)]+)\)\\[^\\]+$/.exec(fields[index])?.[1] ?? '';
        byPriority.push({ index, counter: COUNTERS[priority], priority, zone });
        break;
      }
    }
  }
  byPriority.sort((a, b) => a.priority - b.priority);
  return byPriority[0] ? { index: byPriority[0].index, counter: byPriority[0].counter, zone: byPriority[0].zone } : undefined;
}

const LINUX_CPU_HWMON_NAMES = new Set(['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'cpu-thermal']);

/** Read CPU-specific Linux hwmon sensors; generic ACPI/GPU/disk zones are excluded. */
export async function readLinuxCpuTemperature(root = process.env.DSH_CPU_TEMP_HWMON_ROOT || '/sys/class/hwmon') {
  let devices;
  try {
    devices = await readdir(root);
  } catch (error) {
    return { error: 'Linux hwmon is unavailable: ' + errText(error) };
  }

  const candidates = [];
  for (const device of devices.filter((entry) => /^hwmon\d+$/i.test(entry)).sort()) {
    const base = join(root, device);
    let chip;
    try { chip = (await readFile(join(base, 'name'), 'utf8')).trim().toLowerCase(); } catch { continue; }
    if (!LINUX_CPU_HWMON_NAMES.has(chip)) continue;

    let files;
    try { files = await readdir(base); } catch { continue; }
    for (const file of files.filter((entry) => /^temp\d+_input$/i.test(entry)).sort()) {
      const index = /^temp(\d+)_input$/i.exec(file)?.[1];
      if (!index) continue;
      let raw;
      try { raw = Number((await readFile(join(base, file), 'utf8')).trim()); } catch { continue; }
      const celsius = raw / 1000;
      if (!Number.isFinite(celsius) || celsius < MIN_CELSIUS || celsius > MAX_CELSIUS) continue;

      let label = '';
      try { label = (await readFile(join(base, `temp${index}_label`), 'utf8')).trim(); } catch { }
      if (!label && chip === 'coretemp' && index === '1') label = 'Package id 0';
      if (!label && (chip === 'cpu_thermal' || chip === 'cpu-thermal')) label = 'CPU thermal';
      const normalized = label.toLowerCase();
      let priority;
      if (/^(package( id \d+)?|cpu package|tdie)$/.test(normalized)) priority = 0;
      else if (/^tctl$/.test(normalized)) priority = 1;
      else if (/^core \d+$/.test(normalized)) priority = 2;
      else if (/^cpu thermal$/.test(normalized)) priority = 3;
      else continue;
      candidates.push({ celsius: Math.round(celsius * 10) / 10, source: 'linux-hwmon', counter: `${chip}/${file}`, zone: label, sampledAt: Date.now(), priority });
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  if (!candidates.length) return { error: 'No recognized CPU hwmon sensor found' };
  const { priority, ...reading } = candidates[0];
  return { reading };
}

/** 把异常压成一行文本 */
function errText(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 提权采样器快照文件读取
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Reading
 * @property {number} celsius    摄氏度
 * @property {number} [raw]      计数器原始值（0.1 K），LHM 来源时缺省
 * @property {string} source     Reading provider: lhm | external | linux-hwmon | acpi
 * @property {string} [counter]  计数器路径或 WMI 属性名
 * @property {string} [zone]     热区/传感器名
 * @property {number} sampledAt  采样时刻（epoch ms）
 * @property {number} [package]  CPU Package 温度（LHM 来源）
 * @property {number} [coreMax]  Core Max 温度（LHM 来源）
 * @property {number} [coreAvg]  Core Average 温度（LHM 来源）
 * @property {string} [hardware] CPU 型号
 */

/**
 * Read a snapshot written by an optional external sampler.
 * The sampler should publish atomically; malformed or incomplete data is rejected.
 *
 * @returns {Promise<{ reading?: Reading, error?: string }>}
 */
async function readHelperSnapshot() {
  if (!HELPER_SNAPSHOT_FILE) return { error: '未配置外部采样快照文件' };
  let text;
  try {
    text = await readFile(HELPER_SNAPSHOT_FILE, 'utf8');
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code === 'ENOENT') return { error: '采样器快照文件不存在' };
    return { error: '读取采样器快照失败：' + errText(error) };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: '采样器快照不是合法 JSON（可能正在写入）' };
  }

  if (parsed?.ok !== true) {
    return { error: String(parsed?.error ?? '采样器报告失败') };
  }

  const celsius = Number(parsed.celsius);
  if (!Number.isFinite(celsius) || celsius < MIN_CELSIUS || celsius > MAX_CELSIUS) {
    return { error: '采样器快照温度越界：' + String(parsed.celsius) };
  }

  const sampledAt = Date.parse(String(parsed.sampledAt ?? ''));
  if (!Number.isFinite(sampledAt)) return { error: '采样器快照缺少有效采样时间' };
  if (sampledAt > Date.now() + 60_000) return { error: '采样器快照时间超前过多' };
  const stamp = Math.min(sampledAt, Date.now());

  return {
    reading: {
      celsius: Math.round(celsius * 10) / 10,
      source: 'external',
      counter: typeof parsed.source === 'string' ? parsed.source : 'external sampler',
      zone: typeof parsed.sensor === 'string' ? parsed.sensor : 'External sampler',
      sampledAt: stamp,
      package: Number.isFinite(Number(parsed.package)) ? Number(parsed.package) : undefined,
      coreMax: Number.isFinite(Number(parsed.coreMax)) ? Number(parsed.coreMax) : undefined,
      coreAvg: Number.isFinite(Number(parsed.coreAvg)) ? Number(parsed.coreAvg) : undefined,
      hardware: typeof parsed.hardware === 'string' ? parsed.hardware : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// 兜底采样器：常驻 typeperf 子进程 + 最新值
// ---------------------------------------------------------------------------

/**
 * 造一个 ACPI 性能计数器采样器。惰性启动：第一次有人取数时才开始采样，
 * 空闲超时或进程退出后自动停/重启。
 *
 * @param {{ logger?: { debug?: Function, info?: Function, warn?: Function } }} deps
 */
function createAcpiSampler(deps) {
  const { logger } = deps;

  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  /** @type {Reading | undefined} */
  let latest;
  /** @type {string | undefined} */
  let lastError;
  /** 当前生效的计数器下标 */
  let counterIndex = 0;
  /** @type {NodeJS.Timeout | undefined} */
  let idleTimer;
  /** @type {NodeJS.Timeout | undefined} */
  let restartTimer;
  /** 卸载标记：置位后不再重启子进程 */
  let disposed = false;
  /** 表头解析出的温度列 */
  /** @type {{ index: number, counter: string } | undefined} */
  let column;
  /** 行缓冲：stdout 可能把一行切成两半 */
  let buffer = '';

  /** 收掉子进程（不置 disposed，可被重启） */
  const killChild = () => {
    if (child === undefined) return;
    const target = child;
    child = undefined;
    column = undefined;
    buffer = '';
    try {
      target.kill();
    } catch {
      // 已经退出了
    }
  };

  /** 空闲超时：没人看就停采 */
  const armIdleTimer = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (child === undefined) return;
      logger?.debug?.('dsh-cpu-temp: idle for ' + IDLE_STOP_MS + 'ms — stopping sampler');
      killChild();
    }, IDLE_STOP_MS);
    idleTimer.unref?.();
  };

  /** Parse the CSV header and select the preferred thermal-zone column. */
  const parseHeader = (line) => parseTypeperfHeader(line);

  /** 处理一行完整输出 */
  const consumeLine = (rawLine) => {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim().length === 0) return;
    if (line.startsWith('"(PDH-CSV')) {
      column = parseHeader(line);
      return;
    }
    if (column === undefined) return;
    const fields = splitCsvLine(line);
    const raw = Number(fields[column.index]);
    if (!Number.isFinite(raw)) return;
    const celsius = deciKelvinToCelsius(raw);
    if (celsius === undefined) return;
    latest = {
      celsius,
      raw,
      source: 'acpi',
      counter: column.counter,
      // The zone name was parsed from the typeperf header.
      zone: column.zone || 'ACPI',
      sampledAt: Date.now(),
    };
    lastError = undefined;
  };

  /** 拉起 typeperf */
  const start = () => {
    if (disposed || child !== undefined) return;
    const counter = COUNTERS[counterIndex] ?? COUNTERS[0];
    let proc;
    try {
      proc = spawn('typeperf.exe', [counter, '-si', String(SAMPLE_INTERVAL_MS / 1000)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      lastError = 'typeperf 启动失败：' + errText(error);
      logger?.warn?.('dsh-cpu-temp: ' + lastError);
      return;
    }
    child = proc;

    proc.stdout?.setEncoding?.('latin1');
    proc.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          consumeLine(line);
        } catch (error) {
          logger?.debug?.('dsh-cpu-temp: parse error ' + errText(error));
        }
      }
    });

    proc.stderr?.setEncoding?.('latin1');
    proc.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text.length > 0) lastError = text.split('\n')[0];
    });

    proc.on('error', (error) => {
      lastError = 'typeperf 运行出错：' + errText(error);
      logger?.warn?.('dsh-cpu-temp: ' + lastError);
    });

    proc.on('exit', (code) => {
      if (child === proc) {
        child = undefined;
        column = undefined;
        buffer = '';
      }
      if (disposed) return;
      // 非 0 退出且此前没采到值 → 换下一个计数器
      if (code !== 0 && latest === undefined && counterIndex + 1 < COUNTERS.length) {
        counterIndex += 1;
        logger?.info?.('dsh-cpu-temp: 计数器不可用，改用 ' + COUNTERS[counterIndex]);
      }
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        restartTimer = undefined;
        start();
      }, RESTART_DELAY_MS);
      restartTimer.unref?.();
    });

    logger?.debug?.('dsh-cpu-temp: 开始采样 ' + counter);
  };

  /** 确保采样器在跑，并返回最近一次读数 */
  const poll = () => {
    armIdleTimer();
    start();
    return latest;
  };

  /** 卸载：停子进程、清定时器 */
  const dispose = () => {
    disposed = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (restartTimer !== undefined) clearTimeout(restartTimer);
    idleTimer = undefined;
    restartTimer = undefined;
    killChild();
  };

  return { poll, dispose };
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const logger = ctx.logger;
  const acpi = process.platform === 'win32' ? createAcpiSampler({ logger }) : undefined;

  /** 上一次成功读到外部采样快照时的告警抑制 */
  let warnedHelper = false;

  /**
   * Compose a snapshot: external sampler first, then the platform's built-in provider.
   */
  const snapshot = async () => {
    const now = Date.now();
    const helper = await readHelperSnapshot();

    if (helper.reading !== undefined) {
      if (warnedHelper) {
        warnedHelper = false;
        logger?.info?.('dsh-cpu-temp: external sampler recovered');
      }
      const age = now - helper.reading.sampledAt;
      if (age <= HELPER_EXPIRE_MS) {
        return {
          ok: true,
          celsius: helper.reading.celsius,
          package: helper.reading.package,
          coreMax: helper.reading.coreMax,
          coreAvg: helper.reading.coreAvg,
          hardware: helper.reading.hardware,
          source: 'external',
          counter: helper.reading.counter,
          zone: helper.reading.zone,
          sampledAt: helper.reading.sampledAt,
          ageMs: age,
          stale: age > HELPER_STALE_MS,
        };
      }
    }

    if (HELPER_SNAPSHOT_FILE && !warnedHelper) {
      warnedHelper = true;
      logger?.warn?.('dsh-cpu-temp: external sampler unavailable (' + (helper.error ?? 'snapshot expired') + ')');
    }

    if (process.platform === 'linux') {
      const result = await readLinuxCpuTemperature();
      if (!result.reading) return { ok: false, message: result.error ?? 'No CPU temperature sensor is available' };
      return { ok: true, ...result.reading, ageMs: now - result.reading.sampledAt, stale: false };
    }

    if (acpi !== undefined) {
      const acpiReading = acpi.poll();
      if (acpiReading === undefined) {
        return {
          ok: false,
          message: helper.error ?? 'Starting Windows thermal-zone sampler…',
          helperError: helper.error,
          counter: COUNTERS[0],
        };
      }
      return {
        ok: true,
        celsius: acpiReading.celsius,
        raw: acpiReading.raw,
        source: 'acpi',
        counter: acpiReading.counter,
        zone: acpiReading.zone,
        sampledAt: acpiReading.sampledAt,
        ageMs: now - acpiReading.sampledAt,
        stale: false,
        helperError: helper.error,
      };
    }

    return {
      ok: false,
      message: process.platform === 'darwin'
        ? 'macOS has no built-in unprivileged CPU-temperature provider; configure DSH_CPU_TEMP_SNAPSHOT_FILE.'
        : 'No built-in temperature provider for ' + process.platform,
      helperError: helper.error,
    };
  };

  /** 只认 GET /dsh-cpu-temp/snapshot；其余路径与方法显式报错 */
  const handle = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== SNAPSHOT_PATH) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, message: 'not found' }));
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET' });
      res.end(JSON.stringify({ ok: false, message: 'method not allowed' }));
      return;
    }
    try {
      const value = await snapshot();
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(value));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, message: errText(error) }));
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }),
    'dsh-cpu-temp: snapshot route',
  );

  ctx.effect(() => () => acpi?.dispose(), 'dsh-cpu-temp: sampler');
}
