'use strict';
// ALERT2 on an SDR channel (alert2-readings.js, sdr-worker.js, sdr.js): a
// record's time from its PDU's stamp, a relayed copy one reading, a test PDU
// none — and end to end, the fake rtl_sdr's ALERT2 frame on a legacy channel
// becomes an "alert2" reading in MegaNet beside the channel's ALERT Binary.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const stub = require('./helpers/meganet-stub');
const { Alert2Reader, stampTime } = require('../lib/devices/alert2-readings');

const T0 = Date.UTC(2026, 9, 19, 2, 13, 2, 599);          // 02:13:02.599 UTC: 7982 s into the half day

test('a stamp is seconds since 00:00 or 12:00 UTC, on the half day nearest its arrival', () => {
  assert.deepEqual(stampTime(7941, T0), { t: Date.UTC(2026, 9, 19, 2, 12, 21), clock: 'utc' });
  // Just after noon UTC, a stamp from just before it.
  const noon = Date.UTC(2026, 9, 19, 12, 0, 30);
  assert.deepEqual(stampTime(43190, noon), { t: Date.UTC(2026, 9, 19, 11, 59, 50), clock: 'utc' });
  assert.deepEqual(stampTime(10, Date.UTC(2026, 9, 19, 23, 59, 55)), { t: Date.UTC(2026, 9, 20, 0, 0, 10), clock: 'utc' });
  assert.equal(stampTime(7941 + 3600, T0), null, 'an hour out is not this half day');
  assert.equal(stampTime(null, T0), null);
  assert.equal(stampTime(50000, T0), null, 'no half day has that many seconds');
});

const res = (pdus, more) => ({ frames: [Object.assign({ ok: true, len: 40, cfoHz: 2900, baud: 4800, sync: 0.9, fixed: 1, pdus }, more || {})] });
const pdu = (source, path, stamp, records, more) => Object.assign({ source, port: 1, path, hopLimit: 1, error: null,
  app: { stamp, test: false, apdu: 0, records: records.map(([id, value, before]) => ({ id, value, before, hex: 'AABBCCDD' })) } }, more || {});

test('a record relayed by several paths is one reading and a reception for each; a test PDU only receptions', () => {
  const rd = new Alert2Reader();
  const a = rd.take(res([
    pdu(11762, [10115, 11056, 10019], 7907, [[7182, 18, 11], [7171, 13, 4]]),
    pdu(11762, [10115, 11056, 33300, 10019], 7907, [[7182, 18, 11], [7171, 13, 4]]),
    pdu(33300, [10019], 7941, [[1909, 38, 52]]),
    Object.assign(pdu(10019, [], 7950, [[1234, 5, 0]]), { app: { stamp: 7950, test: true, apdu: 0, records: [{ id: 1234, value: 5, before: 0, hex: '00' }] } }),
  ]), T0, true);
  assert.deepEqual(a.readings.map(r => [r.alert_id, r.value_raw, new Date(r.ts).toISOString()]), [
    [7182, 18, '2026-10-19T02:11:36.000Z'], [7171, 13, '2026-10-19T02:11:43.000Z'], [1909, 38, '2026-10-19T02:11:29.000Z']]);
  assert.equal(a.receptions.length, 6);
  assert.deepEqual(a.receptions.map(x => [x.alert_id, x.ok, x.fault, x.detail.duplicate]),
    [[7182, true, null, false], [7171, true, null, false], [7182, true, null, true], [7171, true, null, true], [1909, true, null, false], [1234, false, 'test', false]]);
  assert.deepEqual(a.receptions[4].detail.path, [10019]);
  assert.equal(a.receptions[4].detail.clock, 'utc');
  // The next frame relays 1909 again, by another path: still the one reading.
  const b = rd.take(res([pdu(33300, [11056, 10019], 7941, [[1909, 38, 52]])]), T0 + 30000, true);
  assert.deepEqual(b.readings, []);
  assert.equal(b.receptions[0].detail.duplicate, true);
  // A new value from the same sensor is a new reading.
  assert.equal(rd.take(res([pdu(33300, [10019], 8001, [[1909, 39, 2]])]), T0 + 60000, true).readings.length, 1);
  assert.deepEqual(rd.status().counts, { frames: 3, bad: 0, pdus: 6, records: 8, readings: 4, duplicates: 3 });
});

test('a frame that would not decode is a reception with its error; an untrusted clock leaves the time to the agent', () => {
  const rd = new Alert2Reader();
  const bad = rd.take({ frames: [{ ok: false, error: 'block 2 of 3: more errors than its parity corrects', len: 74, cfoHz: 2900, baud: 4800, sync: 0.7, fixed: 0, pdus: [] }] }, T0, true);
  assert.deepEqual(bad.readings, []);
  assert.deepEqual([bad.receptions[0].alert_id, bad.receptions[0].ok, bad.receptions[0].fault, bad.receptions[0].detail.len], [null, false, 'frame', 74]);
  assert.match(bad.receptions[0].detail.error, /block 2 of 3/);
  const early = rd.take(res([pdu(33300, [10019], 7941, [[1909, 38, 52]])]), T0, false);
  assert.equal(early.readings[0].ts, null);
});

test('a network clock far from the Pi\'s: timed by arrival, and said once', () => {
  const rd = new Alert2Reader();
  const a = rd.take(res([pdu(33300, [10019], 20000, [[1909, 38, 52]])]), T0, true);
  assert.equal(a.readings[0].ts, T0 - 52000);
  assert.equal(a.receptions[0].detail.clock, 'arrival');
  assert.equal(a.notes.length, 1);
  assert.equal(rd.take(res([pdu(33300, [10019], 20000, [[1909, 40, 52]])]), T0 + 1000, true).notes.length, 0, 'once');
});

test('an ALERT2 frame on a legacy channel, off the air: an "alert2" reading in MegaNet, once, beside the ALERT Binary ones', { timeout: 120000 }, async (t) => {
  const m = await stub.start();
  t.after(() => m.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-a2-'));
  for (const d of ['dev', 'data', 'etc', 'bin']) fs.mkdirSync(path.join(dir, d));
  const usb = path.join(dir, 'sys', 'bus', 'usb', 'devices', '1-1.3');
  fs.mkdirSync(usb, { recursive: true });
  for (const [k, v] of Object.entries({ idVendor: '0bda', idProduct: '2838', serial: '00000001', manufacturer: 'RTLSDRBlog', product: 'Blog V4', busnum: '1', devnum: '4' })) fs.writeFileSync(path.join(usb, k), v + '\n');
  fs.symlinkSync(path.join(__dirname, 'helpers', 'fake-rtl_sdr'), path.join(dir, 'bin', 'rtl_sdr'));
  fs.writeFileSync(path.join(dir, 'bin', 'aplay'), '#!/bin/sh\ncat > /dev/null\n', { mode: 0o755 });
  const port = 18000 + Math.floor(Math.random() * 2000);
  fs.writeFileSync(path.join(dir, 'etc', 'config.json'), JSON.stringify({
    name: 'ALERT2', web: { port },
    meganet: { token: 'mgn_test_token', endpoints: [m.url + '/rest/v1'], stationsUrls: [m.url + '/stations.json'] },
    location: { source: 'manual', lat: -27.47, lon: 153.02 },
    receivers: { sdr: { sampleRate: 960000, moreChannels: [] } },
  }));
  const env = Object.assign({}, process.env, {
    PATH: path.join(dir, 'bin') + ':' + process.env.PATH, RPI_ALERT_CONFIG: path.join(dir, 'etc', 'config.json'), RPI_ALERT_DATA: path.join(dir, 'data'),
    RPI_ALERT_DEV: path.join(dir, 'dev'), RPI_ALERT_SYSFS: path.join(dir, 'sys'), RPI_ALERT_ASSUME_CLOCK: '1', RPI_ALERT_PRIV: '/nonexistent',
    // The ALERT Binary burst at 2 s (the fake's own), an ALERT2 frame at 4 s:
    // one record by two paths, and a test PDU.
    RPI_ALERT_FAKE_ALERT2: JSON.stringify([{ channelHz: 151500000, startSec: 4, cfoHz: 1800, inverted: true, pdus: [
      { source: 33300, path: [11056, 10019], stamp: 'now', records: [{ id: 1909, value: 38, before: 52 }] },
      { source: 33300, path: [10019], stamp: 'now', records: [{ id: 1909, value: 38, before: 52 }] },
      { source: 10019, stamp: 'now', test: true, records: [{ id: 1234, value: 5, before: 0 }] },
    ] }]),
  });
  let log = '';
  const t0 = Date.now();
  const agent = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'rpi-alert'), 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  agent.stderr.on('data', (d) => { log += d; });
  t.after(() => new Promise((resolve) => { if (agent.exitCode !== null) return resolve(); agent.once('exit', resolve); agent.kill('SIGTERM'); }));
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms) => { const s = Date.now(); while (Date.now() - s < ms) { if (await fn()) return true; await wait(200); } return false; };
  const get = async (p) => { try { return await (await fetch('http://127.0.0.1:' + port + p)).json(); } catch (_) { return null; } };
  const posted = () => m.calls.filter(c => c.fn === 'ingest_http' && c.body).flatMap(c => c.body.payload.readings.map(r => Object.assign({ protocol: c.body.payload.protocol }, r)));
  const a2 = () => posted().filter(r => r.protocol === 'alert2');

  assert.ok(await until(() => a2().length && posted().some(r => r.protocol === 'alert' && r.alert_id === 2088), 60000), 'both kinds posted:\n' + JSON.stringify(posted()) + '\n' + log.slice(-3000));
  const r = a2()[0];
  assert.deepEqual([r.alert_id, r.value_raw], [1909, 38]);
  const ts = typeof r.reading_ts === 'number' ? r.reading_ts : Date.parse(r.reading_ts);
  // Stamped (to the second) when the fake started, a moment after the agent, and 52 s before that.
  assert.ok(ts <= t0 - 40000 && ts >= t0 - 54000, 'timed from its stamp: ' + new Date(ts).toISOString() + ' for a start at ' + new Date(t0).toISOString());
  const frames = m.calls.filter(c => c.fn === 'ingest_http' && c.body && c.body.payload.protocol === 'alert2').map(c => c.body.payload.frame).join('\n');
  assert.match(frames, /^SDR,ALERT2,1909,38,src=33300,path=11056-10019,stamp=\d+,before=52,mhz=151\.5$/m);
  assert.equal(r.freq_mhz, 151.5);

  const s = await get('/api/status');
  const ch = s.devices.sdrs[0].channels[0];
  assert.ok(ch.counts.alert2 >= 1, JSON.stringify(ch.counts));
  assert.deepEqual(ch.alert2.sources.sort(), [10019, 33300]);
  await until(() => m.stored.receptions.some(x => x.protocol === 'alert2' && x.fault === 'test'), 15000);
  const rx = m.stored.receptions.filter(x => x.protocol === 'alert2');
  assert.ok(rx.some(x => x.alert_id === 1909 && x.ok && x.detail.duplicate === false && x.detail.source === 33300), JSON.stringify(rx));
  assert.ok(rx.some(x => x.alert_id === 1909 && x.detail.duplicate === true), 'the relayed copy is a reception');
  assert.ok(rx.some(x => x.alert_id === 1234 && !x.ok && x.fault === 'test'), 'the test PDU is a reception only');
  assert.ok(!a2().some(x => x.alert_id === 1234), 'and never a reading');
  assert.ok(!m.stored.receptions.some(x => x.protocol === 'alert' && x.fault === 'undecoded' && x.detail && x.detail.burst_ms > 150 && x.detail.burst_ms < 400),
    'the ALERT2 burst is not an undecoded legacy one');

  // Its next time round the fake's loop it is the same reading: never posted twice.
  await wait(7000);
  assert.equal(a2().filter(x => x.alert_id === 1909).length, 1, JSON.stringify(a2()));
});
