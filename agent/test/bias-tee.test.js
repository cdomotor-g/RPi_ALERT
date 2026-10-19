'use strict';
// The bias tee, end to end. rtl_sdr has no bias-tee option — the fake one,
// like the real one, answers -T with its usage and exit 1 — so the agent
// switches it with rtl_biast before rtl_sdr opens the stick, and a stick whose
// bias tee cannot be switched still receives. With two sticks that share a
// serial, only the one asked for gets the volts, once it is known which
// device number it is.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const stub = require('./helpers/meganet-stub');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await wait(150); } return false; }

// A Pi with these sticks plugged in (USB ports), rtl_biast or not, and these settings.
async function pi(t, { ports, biast, receivers, order }) {
  const m = await stub.start();
  t.after(() => m.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-bias-'));
  for (const d of ['dev', 'data', 'etc', 'bin']) fs.mkdirSync(path.join(dir, d));
  const usb = path.join(dir, 'sys', 'bus', 'usb', 'devices');
  fs.mkdirSync(usb, { recursive: true });
  ports.forEach((port, i) => {
    const d = path.join(usb, port);
    fs.mkdirSync(d);
    for (const [k, v] of Object.entries({ idVendor: '0bda', idProduct: '2838', serial: '00000001', manufacturer: 'RTLSDRBlog', product: 'Blog V4', busnum: '1', devnum: String(4 + i) })) fs.writeFileSync(path.join(d, k), v + '\n');
  });
  const fake = path.join(__dirname, 'helpers', 'fake-rtl_sdr');
  fs.symlinkSync(fake, path.join(dir, 'bin', 'rtl_sdr'));
  if (biast) fs.symlinkSync(fake, path.join(dir, 'bin', 'rtl_biast'));
  fs.symlinkSync(process.execPath, path.join(dir, 'bin', 'node'));   // for the fakes' #!/usr/bin/env node
  fs.writeFileSync(path.join(dir, 'bin', 'aplay'), '#!/bin/sh\nexec /bin/cat > /dev/null\n', { mode: 0o755 });
  const port = 18000 + Math.floor(Math.random() * 2000);
  fs.writeFileSync(path.join(dir, 'etc', 'config.json'), JSON.stringify({
    name: 'Bias tee', web: { port },
    meganet: { token: 'mgn_test_token', endpoints: [m.url + '/rest/v1'], stationsUrls: [m.url + '/stations.json'] },
    location: { source: 'manual', lat: -27.47, lon: 153.02 },
    receivers,
  }));
  const biasLog = path.join(dir, 'biast.log');
  // Only these on the PATH: never the rtl_biast of a machine with rtl-sdr installed.
  const env = Object.assign({}, process.env, {
    PATH: path.join(dir, 'bin'), RPI_ALERT_CONFIG: path.join(dir, 'etc', 'config.json'), RPI_ALERT_DATA: path.join(dir, 'data'),
    RPI_ALERT_DEV: path.join(dir, 'dev'), RPI_ALERT_SYSFS: path.join(dir, 'sys'), RPI_ALERT_ASSUME_CLOCK: '1', RPI_ALERT_PRIV: '/nonexistent',
    RPI_ALERT_FAKE_BIAST_LOG: biasLog,
    RPI_ALERT_FAKE_STICKS: JSON.stringify({ '1-1.3': { frames: '2088:143,2089:12' }, '1-1.4': { channelHz: 151600000, frames: '3001:77,3002:5' } }),
  });
  if (order) env.RPI_ALERT_FAKE_ORDER = order;
  let log = '';
  const agent = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'rpi-alert'), 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  agent.stderr.on('data', (d) => { log += d; });
  t.after(() => new Promise((resolve) => { if (agent.exitCode !== null) return resolve(); agent.once('exit', resolve); agent.kill('SIGTERM'); }));
  const get = async (p) => { try { const r = await fetch('http://127.0.0.1:' + port + p); return await r.json(); } catch (_) { return null; } };
  return {
    log: () => log,
    switched: () => { try { return fs.readFileSync(biasLog, 'utf8').trim().split('\n').filter(Boolean); } catch (_) { return []; } },
    sdrs: async () => { const s = await get('/api/status'); return s ? s.devices.sdrs : []; },
    heard: async (after) => { const r = await get('/api/readings?limit=500'); return r ? r.readings.filter(x => x.t > (after || 0)).map(x => x.alert_id + '@' + x.receiver) : []; },
    set: async (config) => {
      const r = await fetch('http://127.0.0.1:' + port + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }) });
      return { status: r.status, body: await r.json() };
    },
  };
}

test('bias tee on: switched by rtl_biast before rtl_sdr opens the stick, never by rtl_sdr -T; off again when it is turned off', { timeout: 120000 }, async (t) => {
  const p = await pi(t, { ports: ['1-1.3'], biast: true, receivers: { sdr: { sampleRate: 240000, moreChannels: [], biasTee: true } } });
  assert.ok(await until(async () => (await p.sdrs()).some(d => d.state === 'running'), 15000), 'the stick runs:\n' + p.log());
  assert.ok(await until(async () => (await p.heard()).includes('2088@RTL-SDR'), 20000), 'decoding:\n' + p.log().slice(-2000));
  let [d] = await p.sdrs();
  assert.deepEqual([d.biasTee, d.biasOn, d.error, d.counts.restarts], [true, true, null, 0]);
  assert.deepEqual(p.switched(), ['1-1.3 1'], 'switched on once, on this stick');
  assert.doesNotMatch(p.log(), /rtl_sdr .* -T\b/, 'rtl_sdr is never told -T');

  // Off: rtl_sdr closed, rtl_biast -b 0, rtl_sdr opened again — and hearing.
  const t0 = Date.now();
  assert.equal((await p.set({ receivers: { sdr: { biasTee: false } } })).status, 200);
  assert.ok(await until(() => p.switched().length === 2, 15000), 'switched off:\n' + p.log().slice(-2000));
  assert.deepEqual(p.switched(), ['1-1.3 1', '1-1.3 0']);
  assert.ok(await until(async () => (await p.heard(t0)).includes('2088@RTL-SDR'), 25000), 'decoding again:\n' + p.log().slice(-2000));
  [d] = await p.sdrs();
  assert.deepEqual([d.state, d.biasTee, d.biasOn, d.error, d.counts.restarts], ['running', false, false, null, 0]);
});

test('bias tee on, but no rtl_biast: the stick receives without it, and says why', { timeout: 60000 }, async (t) => {
  const p = await pi(t, { ports: ['1-1.3'], biast: false, receivers: { sdr: { sampleRate: 240000, moreChannels: [], biasTee: true } } });
  assert.ok(await until(async () => (await p.heard()).includes('2088@RTL-SDR'), 25000), 'decoding:\n' + p.log().slice(-2000));
  const [d] = await p.sdrs();
  assert.deepEqual([d.state, d.biasOn, d.counts.restarts], ['running', false, 0]);
  assert.match(d.error || '', /bias tee could not be switched on — rtl_biast is not installed/);
  assert.match(p.log(), /bias tee could not be switched on — rtl_biast is not installed.*receiving without it/);
});

test('two sticks with one serial: only the one given the bias tee gets it, once its device number is known', { timeout: 120000 }, async (t) => {
  // Numbered the other way from libusb, so the agent's first guess at each device number is wrong.
  const p = await pi(t, { ports: ['1-1.3', '1-1.4'], biast: true, order: 'forward', receivers: { sdr: { sampleRate: 240000, moreChannels: [] },
    sdrDevices: [{ key: 'sdr-port:1-1.4', freqHz: 151600000, biasTee: true }] } });
  assert.ok(await until(async () => { const l = await p.sdrs(); return l.length === 2 && l.every(d => d.state === 'running'); }, 30000), 'both run:\n' + p.log().slice(-3000));
  assert.ok(await until(async () => { const h = await p.heard(); return h.includes('2088@RTL-SDR') && h.includes('3001@RTL-SDR 2'); }, 30000),
    'each hears its own:\n' + p.log().slice(-3000));
  const l = await p.sdrs();
  assert.deepEqual(l.map(d => [d.device.port, d.biasTee, d.biasOn, d.error]), [['1-1.3', false, false, null], ['1-1.4', true, true, null]]);
  assert.deepEqual(p.switched(), ['1-1.4 1'], 'never the other stick');
});
