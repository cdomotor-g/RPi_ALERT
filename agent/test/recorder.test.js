'use strict';
// Recordings (lib/recorder.js): every burst on a chosen channel kept as the
// channel's own 240 ksps IQ, end to end with the fake rtl_sdr — and the file
// is that burst: decoded offline, as MegaNet's tests decode their fixture, it
// says what the agent heard. Then MegaNet fetching one a piece at a time, and
// the newest kept within maxMb.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const stub = require('./helpers/meganet-stub');
const { AlertDsp } = require('../lib/meganet-codecs');
const { Recorder, toU8, MAX_CHUNK } = require('../lib/recorder');
const { VERBS } = require('../lib/remote');
const { Config } = require('../lib/config');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await wait(150); } return false; }
const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };

test('recording a channel: each burst kept as its own 240 ksps IQ, which decodes to what was heard; off again', { timeout: 120000 }, async (t) => {
  const m = await stub.start();
  t.after(() => m.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-rec-'));
  for (const d of ['dev', 'data', 'etc', 'bin']) fs.mkdirSync(path.join(dir, d));
  const usb = path.join(dir, 'sys', 'bus', 'usb', 'devices', '1-1.3');
  fs.mkdirSync(usb, { recursive: true });
  for (const [k, v] of Object.entries({ idVendor: '0bda', idProduct: '2838', serial: '00000001', manufacturer: 'RTLSDRBlog', product: 'Blog V4', busnum: '1', devnum: '4' })) fs.writeFileSync(path.join(usb, k), v + '\n');
  fs.symlinkSync(path.join(__dirname, 'helpers', 'fake-rtl_sdr'), path.join(dir, 'bin', 'rtl_sdr'));
  fs.writeFileSync(path.join(dir, 'bin', 'aplay'), '#!/bin/sh\ncat > /dev/null\n', { mode: 0o755 });
  const port = 18000 + Math.floor(Math.random() * 2000);
  fs.writeFileSync(path.join(dir, 'etc', 'config.json'), JSON.stringify({
    name: 'Recorder', web: { port },
    meganet: { token: 'mgn_test_token', endpoints: [m.url + '/rest/v1'], stationsUrls: [m.url + '/stations.json'] },
    location: { source: 'manual', lat: -27.47, lon: 153.02 },
    receivers: { sdr: { sampleRate: 960000, moreChannels: [] }, record: { freqHz: [151500000], maxMb: 64 } },
  }));
  const env = Object.assign({}, process.env, {
    PATH: path.join(dir, 'bin') + ':' + process.env.PATH, RPI_ALERT_CONFIG: path.join(dir, 'etc', 'config.json'), RPI_ALERT_DATA: path.join(dir, 'data'),
    RPI_ALERT_DEV: path.join(dir, 'dev'), RPI_ALERT_SYSFS: path.join(dir, 'sys'), RPI_ALERT_ASSUME_CLOCK: '1', RPI_ALERT_PRIV: '/nonexistent',
  });
  let out = '';
  const agent = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'rpi-alert'), 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  agent.stderr.on('data', (d) => { out += d; });
  t.after(() => new Promise((resolve) => { if (agent.exitCode !== null) return resolve(); agent.once('exit', resolve); agent.kill('SIGTERM'); }));
  const get = async (p) => { try { const r = await fetch('http://127.0.0.1:' + port + p); return r.ok ? r : null; } catch (_) { return null; } };
  const list = async () => { const r = await get('/api/recordings'); return r ? r.json() : null; };

  assert.ok(await until(async () => { const l = await list(); return l && l.files.some(f => f.decoded); }, 40000), 'a burst recorded:\n' + out.slice(-2000));
  const l = await list();
  assert.deepEqual(l.recordings.freqHz, [151500000]);
  const f = l.files.find(x => x.decoded);
  assert.match(f.name, /^\d{8}-\d{6}-\d{3}_151\.500_sdr1$/);
  assert.equal(f.freqHz, 151500000);
  assert.ok(f.ms > 100 && f.peakDb < 0, JSON.stringify(f));

  const meta = await (await get('/api/recordings/' + f.name + '.json')).json();
  assert.equal(meta.rate, 240000);
  assert.ok(meta.scale > 0, 'how much it was scaled by: ' + meta.scale);
  assert.equal(meta.stick.sampleRate, 960000);
  assert.ok(meta.decodedAs.readings.some(r => r.id === 2088 && r.value === 143), JSON.stringify(meta.decodedAs));
  const res = await get('/api/recordings/' + f.name + '.iq8');
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const iq = new Uint8Array(await res.arrayBuffer());
  assert.equal(iq.length, meta.samples * 2, 'u8 I and Q, as many samples as it says');
  assert.ok(Math.abs(meta.samples / 240000 - meta.seconds) < 0.001, 'at 240 ksps');
  // The channel itself, centred: what the website's own offline decoder reads from it.
  const dec = AlertDsp.decodeU8(iq, { format: AlertDsp.BINARY });
  assert.ok(dec.readings.some(r => r.sensorId === 2088 && r.value === 143), 'the recording decodes: ' + JSON.stringify(dec.readings));
  assert.equal(await get('/api/recordings/..%2Fconfig.json'), null, 'nothing but a recording');

  const s = await (await get('/api/status')).json();
  assert.equal(s.devices.sdrs[0].channels[0].recording, true);

  // Off: the channel says so, and nothing more is kept.
  const put = await fetch('http://127.0.0.1:' + port + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { receivers: { record: { freqHz: [] } } } }) });
  assert.equal(put.status, 200);
  assert.ok(await until(async () => { const st = await (await get('/api/status')).json(); return st.devices.sdrs[0].channels[0].recording === false; }, 5000));
  const n = (await list()).files.length;
  await wait(8000);                                   // more than one of the fake's burst loops
  assert.equal((await list()).files.length, n, 'none kept once it is off');
});

test('a weak channel is recorded scaled to fill a byte: the burst stands out of the noise, where the pipeline\'s own u8 capture is all 127s and 128s', () => {
  // A burst as the decoder holds it (floats, in steps of the stick's 8 bits), heard ~60 dB down.
  const iq = AlertDsp.synthIq({ fs: 240000, seconds: 3, snrDb: 28, seed: 3, bursts: [{ startSec: 1, frames: [AlertDsp.encodeFrame(AlertDsp.BINARY, 2088, 143)], cfoHz: 0, amp: 40, polarity: 'NEG' }] });
  const n = iq.length >> 1, CAP = 240000 * 8;
  const re = new Float32Array(CAP), im = new Float32Array(CAP);
  for (let k = 0; k < n; k++) { re[k] = (iq[2 * k] - 127.5) * 0.002; im[k] = (iq[2 * k + 1] - 127.5) * 0.002; }
  // Power in dB over [a, b) seconds of u8 IQ.
  const pwr = (u8, a, b) => { let s = 0; const i0 = Math.round(a * 240000), i1 = Math.round(b * 240000); for (let k = i0; k < i1; k++) s += (u8[2 * k] - 127.5) ** 2 + (u8[2 * k + 1] - 127.5) ** 2; return 10 * Math.log10(s / (i1 - i0)); };
  // Unscaled, as the pipeline's capture rounds them: only each sample's sign is
  // left — the burst no louder than the noise either side of it.
  const raw = new Uint8Array(n * 2);
  for (let k = 0; k < n; k++) { raw[2 * k] = Math.round(re[k] + 127.5); raw[2 * k + 1] = Math.round(im[k] + 127.5); }
  assert.ok(raw.every(b => b === 127 || b === 128));
  assert.ok(Math.abs(pwr(raw, 1.05, 1.2) - pwr(raw, 0, 0.8)) < 0.1, 'no amplitude in it');
  const rec = toU8(re, im, n, n);
  assert.ok(rec.scale > 100, 'scaled up: ' + rec.scale);
  const u8 = new Uint8Array(rec.buf);
  assert.ok(pwr(u8, 1.05, 1.2) - pwr(u8, 0, 0.8) > 10, 'the burst well out of the noise (over the whole 240 kHz): ' + (pwr(u8, 1.05, 1.2) - pwr(u8, 0, 0.8)).toFixed(1) + ' dB');
  let lo = 255, hi = 0;
  for (const b of u8) { if (b < lo) lo = b; if (b > hi) hi = b; }
  assert.ok(hi <= 248 && lo >= 7 && hi - lo > 200, 'the loudest fills most of a byte, never clipped: ' + lo + '–' + hi);
  assert.ok(AlertDsp.decodeU8(u8, { format: AlertDsp.BINARY }).readings.some(r => r.sensorId === 2088 && r.value === 143), 'and it decodes');
  // A loud one is scaled down, not clipped; from anywhere in the ring.
  for (let k = 0; k < n; k++) { re[(k + CAP - 1000) % CAP] = (iq[2 * k] - 127.5) * 9; im[(k + CAP - 1000) % CAP] = (iq[2 * k + 1] - 127.5) * 9; }
  const loud = toU8(re, im, CAP - 1000 + n, n);
  assert.ok(loud.scale < 1);
  assert.ok(AlertDsp.decodeU8(new Uint8Array(loud.buf), { format: AlertDsp.BINARY }).readings.some(r => r.sensorId === 2088));
});

test('recordings: MegaNet fetches one a piece at a time, each piece fits a check-in, and the newest are kept within maxMb', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-recu-'));
  const config = new Config(path.join(dir, 'config.json')).load();
  config.update({ receivers: { record: { freqHz: [151537500], maxMb: 16 } } });
  const agent = { dataDir: dir, config, log, baseName: () => 'Bench' };
  const rec = new Recorder(agent).load();
  const stick = { key: 'sdr-port:1-1.3', model: 'Generic RTL2832U', tuner: 'Fitipower FC0013', stick: { serial: '1', busPath: '1-1.3' }, point: { n: 2 },
    cfg: () => ({ sampleRate: 960000, centerHz: 151881000, gainDb: 29.7, ppm: 0 }) };
  const ch = { spec: { freqHz: 151537500, offsetHz: -343500 }, stick, key: 'sdr-port:1-1.3@151.5375', point: { pointId: 'rpi-x-sdr2-151.5375' }, name: () => 'RTL-SDR 2 · 151.5375' };
  const burst = (t, mb) => {
    const buf = new Uint8Array(mb * 1048576);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 7 + t) & 255;
    rec.save(ch, { buf: buf.buffer, rate: 240000, seconds: buf.length / 480000, burst: { t, ms: 1900, peakDb: -44.2, nfDb: -61 }, format: 'BINARY', readings: [], all: 0, shadows: 0 });
    return buf;
  };
  const t0 = Date.parse('2026-10-19T00:17:39.216Z');
  const first = burst(t0, 6);
  // Another channel's burst is not kept.
  rec.save(Object.assign({}, ch, { spec: { freqHz: 151500000, offsetHz: 0 } }), { buf: new ArrayBuffer(16), rate: 240000, seconds: 0, burst: { t: t0 } });
  await until(() => rec.counts.saved === 1, 5000);
  const [f] = rec.list();
  assert.equal(f.name, '20261019-001739-216_151.5375_sdr2');
  assert.equal(f.decoded, 0);

  const r = { agent: { recorder: rec } };
  const listed = (await VERBS.recordings.run(r, {})).result;
  assert.equal(listed.files[0].name, f.name);
  // The pieces, as MegaNet would ask for them, put back together.
  const parts = [];
  let offset = 0, size = Infinity;
  while (offset < size) {
    const piece = (await VERBS['recording.get'].run(r, { file: f.name + '.iq8', offset })).result;
    assert.ok(JSON.stringify(piece).length <= 60000, 'one piece fits one check-in\'s answer');
    assert.ok(piece.length > 0 && piece.length <= MAX_CHUNK);
    parts.push(Buffer.from(piece.b64, 'base64'));
    size = piece.size; offset = piece.offset + piece.length;
  }
  assert.ok(Buffer.concat(parts).equals(Buffer.from(first)), 'the same bytes');
  await assert.rejects(VERBS['recording.get'].run(r, { file: '../config.json', offset: 0 }), /no recording/);

  // 16 MB: the newest two of three 6 MB recordings.
  burst(t0 + 60000, 6);
  burst(t0 + 120000, 6);
  await until(() => rec.counts.saved === 3, 5000);
  assert.deepEqual(rec.list().map(x => x.name), ['20261019-001939-216_151.5375_sdr2', '20261019-001839-216_151.5375_sdr2']);
  assert.ok(!fs.existsSync(path.join(dir, 'recordings', f.name + '.iq8')), 'the oldest deleted');
  assert.equal(new Recorder(agent).load().list().length, 2, 'and the list survives a restart');
  assert.equal(rec.clear(), 2);
  assert.equal(fs.readdirSync(path.join(dir, 'recordings')).length, 0);
});
