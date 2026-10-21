'use strict';
// A legacy ALERT burst's carrier offset, sent to MegaNet for transmitter drift
// (#217): measured as one steady carrier or not at all (lib/devices/carrier.js),
// a repeater's copy of a reading kept as a reception on its own carrier rather
// than thrown away (vendor/meganet/alert-dsp.js, sdr.js) — and end to end, the
// fake rtl_sdr's station and its repeater both arriving with their offsets.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const stub = require('./helpers/meganet-stub');
const { AlertDsp } = require('../lib/meganet-codecs');
const { CarrierMeter, measure, STEP_HZ } = require('../lib/devices/carrier');

const FS = AlertDsp.FS_BB;
const noise = (n, mean, seed) => { let x = seed; return Array.from({ length: n }, () => { x = (x * 1103515245 + 12345) % 2147483648; return mean + (x / 2147483648 - 0.5) * 3000; }); };

test('one carrier: its offset; two in one burst: split, with no offset', () => {
  const one = measure(noise(Math.round(0.4 * FS), 240, 7), FS, 0);
  assert.equal(one.steady, true);
  assert.ok(Math.abs(one.hz - 240) <= 25, 'measured ' + one.hz);
  const half = Math.round(0.2 * FS);
  const two = measure([...noise(half, 300, 3), ...noise(half, -400, 5)], FS, 0);
  assert.equal(two.steady, false);
  assert.equal(two.hz, null);
  assert.ok(two.head > 150 && two.tail < -200, JSON.stringify(two));
  assert.ok(STEP_HZ >= 40 && STEP_HZ <= 100);
  assert.equal(measure(noise(Math.round(0.1 * FS), 0, 1), FS, 0), null, 'too short to say');
});

// Through the decoder: a station's burst and its repeater's copy.
function hear(bursts, seconds) {
  const got = [];
  let meter;
  const p = new AlertDsp.Pipeline((m) => {
    if (m.type === 'decode' && (m.readings.length || (m.copies || []).length)) {
      got.push({ ids: m.readings.map(r => r.sensorId), own: m.readings.map(r => r.own), copies: (m.copies || []).map(r => [r.sensorId, r.copy]),
        cfo: meter.take(m.burst && m.burst.t) });
    }
  });
  p.configure({ deviceRate: 240000, channelOffsetHz: 0, format: AlertDsp.BINARY, gate: true, squelchDb: 8, specHz: 1, scopeHz: 1 });
  meter = new CarrierMeter(p, FS);
  const iq = AlertDsp.synthIq({ fs: 240000, seconds, snrDb: 22, seed: 11, bursts });
  for (let o = 0; o < iq.length; o += 32768) { const c = iq.subarray(o, o + 32768); p.feed(c); meter.after(c.length / 2 * FS / 240000); }
  return got;
}
const FRAME = [AlertDsp.encodeFrame(AlertDsp.BINARY, 2088, 143)];
const LEN_S = (Math.round(0.12 * AlertDsp.BAUD) + 40 + Math.round(0.05 * AlertDsp.BAUD)) / AlertDsp.BAUD;

test('a repeater\'s copy a second later is reported as a copy, each burst with its own carrier', () => {
  const got = hear([{ startSec: 1.0, frames: FRAME, cfoHz: 350, amp: 40, polarity: 'NEG' },
    { startSec: 2.2, frames: FRAME, cfoHz: -650, amp: 40, polarity: 'NEG' }], 4);
  assert.equal(got.length, 2, JSON.stringify(got));
  assert.deepEqual([got[0].ids, got[0].copies], [[2088], []]);
  assert.deepEqual([got[1].ids, got[1].copies], [[], [[2088, 1]]]);
  assert.ok(got[0].cfo.steady && Math.abs(got[0].cfo.hz - 350) <= 40, 'station: ' + JSON.stringify(got[0].cfo));
  assert.ok(got[1].cfo.steady && Math.abs(got[1].cfo.hz + 650) <= 40, 'repeater: ' + JSON.stringify(got[1].cfo));
});

test('two stations keying up 170 ms apart: no copies, and the burst\'s carrier only on the reading it carried', () => {
  const got = hear([{ startSec: 1.0, frames: FRAME, cfoHz: 350, amp: 40, polarity: 'NEG' },
    { startSec: 1.0 + LEN_S + 0.17, frames: [AlertDsp.encodeFrame(AlertDsp.BINARY, 2443, 142)], cfoHz: -650, amp: 40, polarity: 'NEG' }], 4);
  assert.ok(got.every(g => !g.copies.length), JSON.stringify(got));
  const first = got[0];
  assert.equal(first.own[first.ids.indexOf(2088)], true);
  if (first.ids.includes(2443)) assert.equal(first.own[first.ids.indexOf(2443)], false, 'read from its neighbour: not this burst\'s');
  assert.ok(first.cfo.steady && Math.abs(first.cfo.hz - 350) <= 40, JSON.stringify(first.cfo));
});

test('a repeater keying up as the station lets go: one burst, two carriers — no offset, and why', () => {
  const got = hear([{ startSec: 1.0, frames: FRAME, cfoHz: 350, amp: 40, polarity: 'NEG' },
    { startSec: 1.0 + LEN_S, frames: FRAME, cfoHz: -650, amp: 40, polarity: 'NEG' }], 3.5);
  assert.ok(got.length >= 1, 'decoded');
  const c = got[0].cfo;
  assert.ok(c && c.steady === false && c.hz == null, JSON.stringify(c));
  assert.ok(c.head > 150 && c.tail < -350, JSON.stringify(c));
});

test('end to end: the station\'s reception carries cfo_hz, the repeater\'s copy is a reception marked duplicate with its own, the reading once', { timeout: 120000 }, async (t) => {
  const m = await stub.start();
  t.after(() => m.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-cfo-'));
  for (const d of ['dev', 'data', 'etc', 'bin']) fs.mkdirSync(path.join(dir, d));
  const usb = path.join(dir, 'sys', 'bus', 'usb', 'devices', '1-1.3');
  fs.mkdirSync(usb, { recursive: true });
  for (const [k, v] of Object.entries({ idVendor: '0bda', idProduct: '2838', serial: '00000001', manufacturer: 'RTLSDRBlog', product: 'Blog V4', busnum: '1', devnum: '4' })) fs.writeFileSync(path.join(usb, k), v + '\n');
  fs.symlinkSync(path.join(__dirname, 'helpers', 'fake-rtl_sdr'), path.join(dir, 'bin', 'rtl_sdr'));
  fs.writeFileSync(path.join(dir, 'bin', 'aplay'), '#!/bin/sh\ncat > /dev/null\n', { mode: 0o755 });
  const port = 18000 + Math.floor(Math.random() * 2000);
  fs.writeFileSync(path.join(dir, 'etc', 'config.json'), JSON.stringify({
    name: 'Carrier', web: { port },
    meganet: { token: 'mgn_test_token', endpoints: [m.url + '/rest/v1'], stationsUrls: [m.url + '/stations.json'] },
    location: { source: 'manual', lat: -27.47, lon: 153.02 },
    receivers: { sdr: { sampleRate: 960000, moreChannels: [] } },
  }));
  const env = Object.assign({}, process.env, {
    PATH: path.join(dir, 'bin') + ':' + process.env.PATH, RPI_ALERT_CONFIG: path.join(dir, 'etc', 'config.json'), RPI_ALERT_DATA: path.join(dir, 'data'),
    RPI_ALERT_DEV: path.join(dir, 'dev'), RPI_ALERT_SYSFS: path.join(dir, 'sys'), RPI_ALERT_ASSUME_CLOCK: '1', RPI_ALERT_PRIV: '/nonexistent',
    // 2088 = 143 from the station, 400 Hz high; 1.2 s later its repeater's copy, 600 Hz low.
    RPI_ALERT_FAKE_BURSTS: JSON.stringify([
      { channelHz: 151500000, frames: '2088:143', startSec: 2.0, offsetHz: 400 },
      { channelHz: 151500000, frames: '2088:143', startSec: 3.2, offsetHz: -600 }]),
  });
  let log = '';
  const agent = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'rpi-alert'), 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  agent.stderr.on('data', (d) => { log += d; });
  t.after(() => new Promise((resolve) => { if (agent.exitCode !== null) return resolve(); agent.once('exit', resolve); agent.kill('SIGTERM'); }));
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms) => { const s = Date.now(); while (Date.now() - s < ms) { if (await fn()) return true; await wait(200); } return false; };
  const rx = () => m.stored.receptions.filter(x => x.protocol === 'alert' && x.alert_id === 2088);
  assert.ok(await until(() => rx().some(x => x.detail && x.detail.duplicate), 60000), 'both receptions:\n' + JSON.stringify(rx()) + '\n' + log.slice(-3000));
  const own = rx().find(x => !x.detail.duplicate), copy = rx().find(x => x.detail.duplicate);
  assert.ok(own.ok && Math.abs(own.detail.cfo_hz - 400) <= 50, 'the station: ' + JSON.stringify(own.detail));
  assert.ok(copy.ok && copy.detail.copy === 1 && Math.abs(copy.detail.cfo_hz + 600) <= 50, 'the repeater: ' + JSON.stringify(copy.detail));
  const readings = m.calls.filter(c => c.fn === 'ingest_http' && c.body).flatMap(c => c.body.payload.readings).filter(r => r.alert_id === 2088);
  assert.equal(readings.length, 1, 'one reading: ' + JSON.stringify(readings));
});
