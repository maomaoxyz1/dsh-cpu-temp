/**
 * dsh-cpu-temp —— 浏览器半侧（Client）。
 *
 * 在输入框工具栏（`conversation.input.left`）里挂一个小胶囊，显示 CPU 温度。
 * 「技能」按钮占 order 60，本插件用 order 70，于是排在它右边。
 *
 * 数据全部来自宿主半侧的同源相对路径 `GET /dsh-cpu-temp/snapshot`；
 * 页面不碰任何系统接口、不直接跑命令。每秒拉一次，与宿主采样节奏一致。
 *
 * 读数会分成三档颜色：正常 / 偏热 / 过热，鼠标悬停给出数据源与采样时刻。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cpu-temp',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    /** 本地化命名空间（与宿主插件名一致） */
    const NS = 'cpu-temp';
    /** 宿主半侧的快照端点 */
    const SNAPSHOT_ENDPOINT = '/dsh-cpu-temp/snapshot';
    /** 轮询间隔：用户要求每秒一次 */
    const POLL_MS = 1000;

    /** 偏热 / 过热阈值（摄氏度） */
    const WARM_C = 70;
    const HOT_C = 85;

    // ------------------------------------------------------------------
    // 文案：两套字典在 apply 里注册进 ctx.locale，切换语言后 label thunk 重新取值
    // ------------------------------------------------------------------
    const ZH = {
      'label.loading': '--',
      'label.unavailable': '--',
      'unit': '°C',
      'title.loading': '正在读取温度…',
      'title.value': '温度 {value}°C · 来源 {source}',
      'title.hot': '温度 {value}°C，超过 {hot}°C · 来源 {source}',
      'title.stale': '采样已 {age} 秒未更新，可能正在重启采样器',
      'title.error': '读不到温度：{message}',
      'source.lhm': 'LibreHardwareMonitor',
      'source.external': '外部采样器',
      'source.linux': 'Linux CPU 传感器',
      'source.acpi': 'ACPI 热区（非 CPU 专用）',
      'aria': '温度 {value} 摄氏度',
    };
    const EN = {
      'label.loading': '--',
      'label.unavailable': '--',
      'unit': '°C',
      'title.loading': 'Reading temperature…',
      'title.value': 'Temperature {value}°C · source {source}',
      'title.hot': 'Temperature {value}°C — above {hot}°C · source {source}',
      'title.stale': 'No update for {age}s — sampler may be restarting',
      'title.error': 'Temperature unavailable: {message}',
      'source.lhm': 'LibreHardwareMonitor',
      'source.external': 'External sampler',
      'source.linux': 'Linux CPU sensor',
      'source.acpi': 'ACPI thermal zone (not CPU-specific)',
      'aria': 'Temperature {value} degrees Celsius',
    };

    // ------------------------------------------------------------------
    // 样式：一次注入，跟着主题走
    // 尺寸与「技能」按钮（.sk-chip）对齐：26px 高、12px 字、13px 图标
    // ------------------------------------------------------------------
    const STYLE_ID = 'dsh-cpu-temp-style';
    const CSS = `
.cpu-temp-chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 7px;border-radius:8px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family);font-size:12px;line-height:1;white-space:nowrap;cursor:default;font-variant-numeric:tabular-nums}
.cpu-temp-chip svg{width:13px;height:13px;flex:none;display:block}
.cpu-temp-chip[data-tone="warm"]{color:var(--dsw-alias-label-warning,#e08c3b)}
.cpu-temp-chip[data-tone="hot"]{color:var(--dsw-alias-label-danger,#e05252)}
.cpu-temp-chip[data-tone="unknown"]{opacity:.55}
.cpu-temp-value{font-variant-numeric:tabular-nums}
`;

    function injectStyles() {
      if (typeof document === 'undefined') return () => {};
      if (document.getElementById(STYLE_ID) !== null) return () => {};
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => {
        try {
          style.remove();
        } catch {
          // 已被移除
        }
      };
    }

    /** Lucide `thermometer`（ISC）内联 SVG：与工具行其它线性图标同款描边 */
    function IconThermometer() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z' }),
      );
    }

    /** 按温度选色调 */
    function toneOf(celsius) {
      if (!Number.isFinite(celsius)) return 'unknown';
      if (celsius >= HOT_C) return 'hot';
      if (celsius >= WARM_C) return 'warm';
      return 'normal';
    }

    /** 把 {key} 占位符换成实参 */
    function format(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (_, key) => (vars[key] === undefined ? '' : String(vars[key])));
    }

    /**
     * 胶囊组件。
     * @param {{ __t: (key: string) => string, sessionId?: string }} props
     */
    function CpuTempChip(props) {
      const t = typeof props?.__t === 'function' ? props.__t : (key) => ZH[key] ?? key;
      /** @type {[{ ok?: boolean, celsius?: number, source?: string, zone?: string, ageMs?: number, stale?: boolean, message?: string } | null, Function]} */
      const [snap, setSnap] = useState(null);
      /** 挂载标记：组件卸载后别再 setState */
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        let timer;

        const tick = async () => {
          try {
            const response = await fetch(SNAPSHOT_ENDPOINT, {
              cache: 'no-store',
              headers: { accept: 'application/json' },
            });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const body = await response.json();
            if (alive.current) setSnap(body ?? null);
          } catch (error) {
            if (alive.current) {
              setSnap({ ok: false, message: error instanceof Error ? error.message : String(error) });
            }
          } finally {
            if (alive.current) timer = setTimeout(tick, POLL_MS);
          }
        };

        tick();
        return () => {
          alive.current = false;
          if (timer !== undefined) clearTimeout(timer);
        };
      }, []);

      const ready = snap !== null && snap.ok === true && Number.isFinite(snap.celsius);
      const source = ready ? t('source.' + (
        snap.source === 'lhm' ? 'lhm'
          : snap.source === 'external' ? 'external'
            : snap.source === 'linux-hwmon' ? 'linux'
              : 'acpi'
      )) : '';
      const tone = ready ? (snap.source === 'acpi' ? 'normal' : toneOf(snap.celsius)) : 'unknown';
      const value = ready ? snap.celsius.toFixed(1) + t('unit') : t('label.unavailable');

      // 悬停提示：温度 + 数据源 + 热区名；异常时给出原因
      let title;
      if (snap === null) {
        title = t('title.loading');
      } else if (!ready) {
        title = format(t('title.error'), { message: snap.message ?? 'n/a' });
      } else if (tone === 'hot') {
        title = format(t('title.hot'), { value: value, hot: HOT_C, source: source });
      } else {
        title = format(t('title.value'), { value: value, source: source });
        if (snap.zone) title += ' · ' + snap.zone;
        if (snap.stale === true) {
          title += '\n' + format(t('title.stale'), { age: Math.round((snap.ageMs ?? 0) / 1000) });
        }
      }

      return h(
        'div',
        {
          className: 'cpu-temp-chip',
          'data-tone': tone,
          title,
          role: 'status',
          'aria-label': format(t('aria'), { value: ready ? value : t('label.unavailable') }),
        },
        h(IconThermometer),
        h('span', { className: 'cpu-temp-value' }, value),
      );
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 字典：语言切换时 ctx.locale 重新投影 label thunk
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-cpu-temp: dictionaries');

        // 取词兜底：宿主没有该命名空间/语言时回退本插件字典，绝不把裸 key 显示给用户
        const translate = ctx.locale.bind(NS);
        const t = (key) => {
          const value = typeof translate === 'function' ? translate(key) : undefined;
          return typeof value === 'string' && value.length > 0 && value !== key ? value : ZH[key] ?? key;
        };

        ctx.effect(() => injectStyles(), 'dsh-cpu-temp: styles');

        // 输入框工具栏：技能按钮是 order 60，本插件 order 70 → 显示在它右边
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.input.left', () =>
              ctx.slots.register(
                {
                  name: 'conversation.input.left',
                  id: 'dsh-cpu-temp',
                  order: 70,
                  locale: NS,
                  label: () => t('label.unavailable'),
                  inject: () => ({ t }),
                },
                function CpuTempSlot(apiProps) {
                  return h(CpuTempChip, { __t: t, sessionId: apiProps?.sessionId });
                },
              ),
            ),
          'dsh-cpu-temp: input.left chip',
        );
      },
    };
  },
});
