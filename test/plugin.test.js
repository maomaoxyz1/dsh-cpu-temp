import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { splitCsvLine, deciKelvinToCelsius, parseTypeperfHeader, readLinuxCpuTemperature } from '../lib/index.js';

test('splits typeperf CSV fields', () => {
  assert.deepEqual(splitCsvLine('"16:44:03.573","3010.000000"'), ['16:44:03.573', '3010.000000']);
});

test('converts deci-Kelvin to Celsius and rejects implausible readings', () => {
  assert.equal(deciKelvinToCelsius(3010), 27.9);
  assert.equal(deciKelvinToCelsius(0), undefined);
  assert.equal(deciKelvinToCelsius(Number.NaN), undefined);
});

test('prefers the high-precision counter and preserves the zone', () => {
  const header = '"(PDH-CSV 4.0)","\\\\HOST\\Thermal Zone Information(\\_TZ.TZ00)\\Temperature","\\\\HOST\\Thermal Zone Information(\\_TZ.TZ01)\\High Precision Temperature"';
  assert.deepEqual(parseTypeperfHeader(header), {
    index: 2,
    counter: '\\Thermal Zone Information(*)\\High Precision Temperature',
    zone: '\\_TZ.TZ01',
  });
});

test('returns undefined when no supported counter is present', () => {
  assert.equal(parseTypeperfHeader('"(PDH-CSV 4.0)","\\\\HOST\\Processor(_Total)\\% Processor Time"'), undefined);
});

test('Linux hwmon accepts a labeled CPU package sensor and ignores generic ACPI zones', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hwmon-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cpu = join(root, 'hwmon0');
  const acpi = join(root, 'hwmon1');
  await mkdir(cpu);
  await mkdir(acpi);
  await writeFile(join(cpu, 'name'), 'coretemp\n');
  await writeFile(join(cpu, 'temp1_input'), '52750\n');
  await writeFile(join(cpu, 'temp1_label'), 'Package id 0\n');
  await writeFile(join(acpi, 'name'), 'acpitz\n');
  await writeFile(join(acpi, 'temp1_input'), '42000\n');
  await writeFile(join(acpi, 'temp1_label'), 'temp1\n');

  const result = await readLinuxCpuTemperature(root);
  assert.equal(result.reading.celsius, 52.8);
  assert.equal(result.reading.source, 'linux-hwmon');
  assert.equal(result.reading.zone, 'Package id 0');
});

test('Linux hwmon refuses unknown chip names and unlabeled temperatures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hwmon-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const device = join(root, 'hwmon0');
  await mkdir(device);
  await writeFile(join(device, 'name'), 'acpitz\n');
  await writeFile(join(device, 'temp1_input'), '52000\n');
  await writeFile(join(device, 'temp1_label'), 'temp1\n');
  assert.equal((await readLinuxCpuTemperature(root)).reading, undefined);
});

test('GET snapshot route serves a fresh compatible external snapshot', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cpu-temp-'));
  const snapshotPath = join(dir, 'snapshot.json');
  const oldPath = process.env.DSH_CPU_TEMP_SNAPSHOT_FILE;
  process.env.DSH_CPU_TEMP_SNAPSHOT_FILE = snapshotPath;
  t.after(async () => {
    if (oldPath === undefined) delete process.env.DSH_CPU_TEMP_SNAPSHOT_FILE;
    else process.env.DSH_CPU_TEMP_SNAPSHOT_FILE = oldPath;
    await rm(dir, { recursive: true, force: true });
  });

  const { apply } = await import('../lib/index.js?route-test');
  let handler;
  const cleanups = [];
  const ctx = {
    logger: {},
    webServer: { register: ({ path, handler: fn }) => { assert.equal(path, '/dsh-cpu-temp'); handler = fn; return () => {}; } },
    effect: (setup) => { const cleanup = setup(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
  };
  apply(ctx);
  t.after(() => cleanups.forEach((cleanup) => cleanup()));

  const errorResponse = () => {
    const response = { status: 0, body: '', writeHead(status) { this.status = status; }, end(value) { this.body = value; } };
    return response;
  };
  const missingRoute = errorResponse();
  await handler({ url: '/not-this-route', method: 'GET' }, missingRoute);
  assert.equal(missingRoute.status, 404);
  const wrongMethod = errorResponse();
  await handler({ url: '/dsh-cpu-temp/snapshot', method: 'POST' }, wrongMethod);
  assert.equal(wrongMethod.status, 405);

  await writeFile(snapshotPath, JSON.stringify({ ok: true, celsius: 52.04, sampledAt: new Date().toISOString() }));
  const headers = {};
  let body = '';
  const response = {
    writeHead(status, values = {}) { this.status = status; Object.assign(headers, values); },
    end(value) { body = value; },
  };
  await handler({ url: '/dsh-cpu-temp/snapshot', method: 'GET' }, response);
  assert.equal(response.status, 200);
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(body).celsius, 52);
  assert.equal(JSON.parse(body).source, 'external');

  await writeFile(snapshotPath, JSON.stringify({
    ok: true,
    celsius: 52,
    sampledAt: new Date(Date.now() + 3_600_000).toISOString(),
  }));
  const future = { writeHead(status) { this.status = status; }, end(value) { this.body = value; } };
  await handler({ url: '/dsh-cpu-temp/snapshot', method: 'GET' }, future);
  assert.equal(future.status, 200);
  assert.equal(JSON.parse(future.body).ok, false);
});
