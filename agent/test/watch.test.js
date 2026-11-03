'use strict';
// receivers.sdr.watch (MegaNet #259 part 2): what a channel's decoder does
// between bursts — through the real SDR worker thread, as a stick runs it.
// Filtering only around bursts must read what filtering always reads; check
// must send always's readings and count, every 10 s of signal, that the two
// agreed.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { AlertDsp } = require('../lib/meganet-codecs');
const { Config } = require('../lib/config');

const WORKER = path.join(__dirname, '..', 'lib', 'devices', 'sdr-worker.js');

// 44 s of a stick: its noise ~10 counts either side of 127.5, a burst every
// 4 s from 2 dB under the squelch to 25 dB over, the channel `off` from the
// centre of the window.
function stream(rate, off) {
  const B = (id, v) => AlertDsp.encodeFrame(AlertDsp.BINARY, id, v);
  const amp0 = 10 * Math.sqrt(2 * Math.pow(10, 0.6) * 12000 / rate);
  const bursts = [];
  let t = 2.5, id = 3000;
  for (const rel of [0, 3, 6, 9, 12, 18, 25, 4, 8, 15]) {
    bursts.push({ startSec: t, frames: [B(id, id % 1000), B(id + 1, 12)], cfoHz: off + (id % 5 - 2) * 900, amp: amp0 * Math.pow(10, rel / 20) });
    id += 2; t += 4;
  }
  return AlertDsp.synthIq({ fs: rate, seconds: t + 2, snrDb: 6, amp: amp0, bursts, seed: 9 });
}
const STREAMS = {};
const streamOf = (rate, off) => STREAMS[rate + ':' + off] || (STREAMS[rate + ':' + off] = stream(rate, off));

// The stream through one worker, in 50 ms chunks; → every message. `midway`:
// a config message sent halfway through.
function run(rate, off, extra, midway) {
  const cfg = Object.assign({ deviceRate: rate, channelOffsetHz: off, format: 'BINARY', gate: true, squelchDb: 8, minVotes: 4, minVotesCrc: 4, alert2: false }, extra);
  const iq = streamOf(rate, off), STEP = 2 * rate / 20;
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { cfg, audio: false } });
    const all = [];
    let fed = 0, told = false;
    w.on('error', reject);
    w.on('message', (m) => {
      if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); return; }
      all.push(m);
      if (m.type === 'ready' || m.type === 'fed') {
        if (fed >= iq.length) { if (m.type === 'fed') { w.terminate(); resolve(all); } return; }
        if (midway && !told && fed >= iq.length / 2) { told = true; w.postMessage({ type: 'config', cfg: midway }); }
        const chunk = iq.slice(fed, Math.min(iq.length, fed + STEP));
        fed += STEP;
        w.postMessage({ type: 'iq', buf: chunk.buffer }, [chunk.buffer]);
      }
    });
  });
}
const readings = all => all.filter(m => m.type === 'decode').flatMap(m => m.readings.map(r => r.sensorId + '=' + r.value)).sort().join(' ');
const bursts = all => all.filter(m => m.type === 'burst').map(m => m.ms).join();

test('the between-bursts setting: always by default, bursts and check accepted, anything else refused', () => {
  const fs = require('node:fs'), os = require('node:os');
  const c = new Config(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ra-')), 'config.json'));
  c.load();
  assert.equal(c.get().receivers.sdr.watch, 'always');
  for (const v of ['bursts', 'check', 'always']) assert.ok(c.update({ receivers: { sdr: { watch: v } } }).ok, v);
  const bad = c.update({ receivers: { sdr: { watch: 'sometimes' } } });
  assert.ok(!bad.ok && /receivers\.sdr\.watch/.test(bad.errors.join()), JSON.stringify(bad));
});

for (const [rate, off] of [[240000, 0], [960000, -150000]]) {
  test(`around bursts reads what always reads, burst for burst (${rate / 1000}k, ${off / 1000} kHz off)`, async () => {
    const a = await run(rate, off, { watch: 'always' }), b = await run(rate, off, { watch: 'bursts' });
    assert.ok(readings(a).split(' ').length >= 14, readings(a));
    assert.equal(readings(b), readings(a));
    assert.equal(bursts(b), bursts(a));
    // …and the card still has its level and the stick's spectrum, asleep or not.
    const lv = x => x.filter(m => m.type === 'level').length, sp = x => x.filter(m => m.type === 'spectrum').length;
    assert.ok(lv(b) >= lv(a) - 2 && sp(b) >= sp(a) - 2, `levels ${lv(a)}/${lv(b)}, spectra ${sp(a)}/${sp(b)}`);
  });
}

test('check sends always\'s readings, and counts that around bursts got the same', async () => {
  const a = await run(240000, 0, { watch: 'always' }), c = await run(240000, 0, { watch: 'check' });
  assert.equal(readings(c), readings(a));
  const wc = c.filter(m => m.type === 'watchCheck');
  assert.ok(wc.length >= 3, 'a check every 10 s of signal');
  const sum = k => wc.reduce((s, m) => s + m[k], 0);
  assert.ok(sum('both') >= 10, 'matched: ' + sum('both'));
  assert.equal(sum('onlyAlways'), 0);
  assert.equal(sum('onlyWatch'), 0);
  assert.ok(sum('samples') > 0 && sum('awake') < sum('samples'), 'asleep some of the time');
  assert.ok(sum('msWatch') > 0 && sum('msAlways') > 0);
});

test('the setting changes under a running decoder: always, then around bursts, without a reading lost', async () => {
  const a = await run(240000, 0, { watch: 'always' }), m = await run(240000, 0, { watch: 'always' }, { watch: 'bursts' });
  assert.equal(readings(m), readings(a));
});
