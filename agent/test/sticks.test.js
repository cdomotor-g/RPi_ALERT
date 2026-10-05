'use strict';
// Several RTL-SDR sticks on one Pi, end to end. The fake rtl_sdr plays
// librtlsdr over a fake sysfs holding two sticks that both say they are serial
// 00000001, as most sticks do — and numbers them the other way from libusb,
// so the agent's first guess at each stick's device number is wrong and it
// has to notice. What a base station with two sticks must get right:
// plugging in the second leaves the first alone; each listens on its own
// channel and opens its own stick; an unplugged stick stays listed until it
// is removed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const stub = require('./helpers/meganet-stub');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await wait(150); } return false; }

test('two sticks with one serial: the first keeps its name, each hears its own channel from its own stick, and an unplugged one can be removed', { timeout: 180000 }, async (t) => {
  const m = await stub.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-sticks-'));
  for (const d of ['dev', 'data', 'etc', 'bin']) fs.mkdirSync(path.join(dir, d));
  const usb = path.join(dir, 'sys', 'bus', 'usb', 'devices');
  fs.mkdirSync(usb, { recursive: true });
  const plug = (port, devnum) => {
    const d = path.join(usb, port);
    fs.mkdirSync(d);
    for (const [k, v] of Object.entries({ idVendor: '0bda', idProduct: '2838', serial: '00000001', manufacturer: 'RTLSDRBlog', product: 'Blog V4', busnum: '1', devnum: String(devnum) })) fs.writeFileSync(path.join(d, k), v + '\n');
  };
  fs.symlinkSync(path.join(__dirname, 'helpers', 'fake-rtl_sdr'), path.join(dir, 'bin', 'rtl_sdr'));
  fs.writeFileSync(path.join(dir, 'bin', 'aplay'), '#!/bin/sh\ncat > /dev/null\n', { mode: 0o755 });
  const port = 18000 + Math.floor(Math.random() * 2000);
  fs.writeFileSync(path.join(dir, 'etc', 'config.json'), JSON.stringify({
    name: 'Two sticks', web: { port },
    meganet: { token: 'mgn_test_token', endpoints: [m.url + '/rest/v1'], stationsUrls: [m.url + '/stations.json'] },
    location: { source: 'manual', lat: -27.47, lon: 153.02 },
    receivers: { sdr: { sampleRate: 240000 } },
  }));
  const env = Object.assign({}, process.env, {
    PATH: path.join(dir, 'bin') + ':' + process.env.PATH, RPI_ALERT_CONFIG: path.join(dir, 'etc', 'config.json'), RPI_ALERT_DATA: path.join(dir, 'data'),
    RPI_ALERT_DEV: path.join(dir, 'dev'), RPI_ALERT_SYSFS: path.join(dir, 'sys'), RPI_ALERT_ASSUME_CLOCK: '1', RPI_ALERT_PRIV: '/nonexistent',
    // The stick in port 1-1.3 hears one station on 151.5 MHz; the one in 1-1.4 another, on 151.6 MHz.
    RPI_ALERT_FAKE_STICKS: JSON.stringify({ '1-1.3': { frames: '2088:143,2089:12' }, '1-1.4': { channelHz: 151600000, frames: '3001:77,3002:5' } }),
    RPI_ALERT_FAKE_ORDER: 'forward',
  });
  let agent = null;
  let log = '';
  const start = () => {
    agent = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'rpi-alert'), 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    agent.stderr.on('data', (d) => { log += d; });
  };
  const stop = () => new Promise((resolve) => { if (!agent || agent.exitCode !== null) return resolve(); agent.once('exit', resolve); agent.kill('SIGTERM'); });
  t.after(async () => { await stop(); await m.close(); });
  const get = async (p) => { try { const r = await fetch('http://127.0.0.1:' + port + p); return await r.json(); } catch (_) { return null; } };
  const send = async (p, body, method) => {
    const r = await fetch('http://127.0.0.1:' + port + p, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const sdrs = async () => { const s = await get('/api/status'); return s ? s.devices.sdrs : []; };
  const heard = async (after) => { const r = await get('/api/readings?limit=500'); return r ? r.readings.filter(x => x.t > (after || 0)).map(x => x.alert_id + '@' + x.receiver) : []; };
  const posted = () => m.calls.filter(c => c.fn === 'ingest_http' && c.body).flatMap(c => c.body.payload.readings.map(r => r.alert_id + '@' + c.body.payload.path.split('-').pop()));

  // One stick: "RTL-SDR", hearing the station on its channel.
  plug('1-1.3', 4);
  start();
  assert.ok(await until(async () => (await sdrs()).some(d => d.state === 'running'), 15000), 'the stick runs:\n' + log);
  const [first] = await sdrs();
  assert.equal(first.name, 'RTL-SDR');
  assert.ok(await until(async () => (await heard()).includes('2088@RTL-SDR'), 20000), 'decoding:\n' + log.slice(-2000));

  // A second stick that says the same: the first carries on exactly as it was.
  plug('1-1.4', 5);
  assert.ok(await until(async () => { const l = await sdrs(); return l.length === 2 && l.every(d => d.state === 'running'); }, 20000), 'both run:\n' + log.slice(-3000));
  let [a, b] = await sdrs();
  assert.deepEqual([a.key, a.name, a.pointId, a.counts.restarts, a.startedAt], [first.key, 'RTL-SDR', first.pointId, 0, first.startedAt], 'the first stick was not touched');
  assert.equal(b.name, 'RTL-SDR 2');
  assert.notEqual(b.pointId, a.pointId);
  assert.equal(b.device.port, '1-1.4');

  // The second gets a channel of its own: only it restarts, and each hears its own network.
  const set = await send('/api/config', { config: { receivers: { sdrDevices: [{ key: b.key, freqHz: 151600000 }] } } }, 'PUT');
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.ok(await until(async () => (await heard()).includes('3001@RTL-SDR 2'), 30000), 'the second stick hears 151.6 MHz:\n' + log.slice(-3000));
  [a, b] = await sdrs();
  assert.equal(a.startedAt, first.startedAt, 'the first stick was not restarted');
  assert.deepEqual([a.freqHz, b.freqHz], [151500000, 151600000]);
  assert.deepEqual(b.own, ['freqHz']);
  let all = await heard();
  assert.ok(!all.includes('3001@RTL-SDR') && !all.includes('2088@RTL-SDR 2'), 'neither hears the other\'s station: ' + all.join(' '));
  const sdrN = (pid) => pid.split('-').pop();
  assert.ok(await until(() => posted().includes('3001@' + sdrN(b.pointId)) && posted().includes('2088@' + sdrN(a.pointId)), 15000), 'MegaNet has both, by receiver: ' + posted().join(' '));

  // Restarted with both plugged in: the same names, and each rtl_sdr ends up
  // on its own stick, though the device numbers first tried are the other's.
  await stop();
  const t1 = Date.now();
  log = '';
  start();
  assert.ok(await until(async () => { const h = await heard(t1); return h.includes('2088@RTL-SDR') && h.includes('3001@RTL-SDR 2'); }, 40000), 'each hears its own again:\n' + log.slice(-3000));
  [a, b] = await sdrs();
  assert.deepEqual([a.name, a.key, b.name, b.key], ['RTL-SDR', first.key, 'RTL-SDR 2', b.key]);
  assert.match(log, /reopening/, 'the wrong stick was noticed');
  assert.ok(a.opened.checked && b.opened.checked, 'each was seen to open its own stick: ' + JSON.stringify([a.opened, b.opened]));
  all = await heard(t1);
  assert.ok(!all.includes('3001@RTL-SDR') && !all.includes('2088@RTL-SDR 2'), all.join(' '));

  // Unplug the first: it stays listed, as unplugged, until removed. One that
  // is plugged in cannot be removed.
  fs.rmSync(path.join(usb, '1-1.3'), { recursive: true });
  assert.ok(await until(async () => (await sdrs()).find(d => d.key === a.key).state === 'unplugged', 10000), 'unplugged:\n' + log.slice(-2000));
  assert.equal((await send('/api/devices/forget', { key: b.key })).status, 409);
  assert.equal((await send('/api/devices/restart', { key: a.key })).status, 409);
  const gone = await send('/api/devices/forget', { key: a.key });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.deepEqual((await sdrs()).map(d => d.name), ['RTL-SDR 2']);
  const stateFile = path.join(dir, 'data', 'state.json');
  assert.ok(await until(() => { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return !s.sdrs[a.key] && !s.points['sdr|' + a.key]; }, 5000), 'forgotten in state.json');
  assert.deepEqual((await get('/api/config')).config.receivers.sdrDevices, [{ key: b.key, freqHz: 151600000 }], 'the other stick keeps its settings');

  // Plugged in again, it is found as a new receiver — given the free name.
  plug('1-1.3', 6);
  assert.ok(await until(async () => { const l = await sdrs(); return l.length === 2 && l.every(d => d.state === 'running'); }, 20000), 'back:\n' + log.slice(-2000));
  assert.deepEqual((await sdrs()).map(d => d.name), ['RTL-SDR', 'RTL-SDR 2']);
});
