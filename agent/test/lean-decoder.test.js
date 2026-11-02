'use strict';
// receivers.sdr.decoder (MegaNet #259): full, lean, or compare — through the
// real SDR worker thread, as a stick runs it. Lean must read what full reads;
// compare must send full's readings and say, for every burst, that lean agreed.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { AlertDsp } = require('../lib/meganet-codecs');
const { Config } = require('../lib/config');

const WORKER = path.join(__dirname, '..', 'lib', 'devices', 'sdr-worker.js');

// The demo band (five readings in three bursts) through one worker; → its decodes.
function run(extra) {
  const cfg = Object.assign({ deviceRate: 240000, channelOffsetHz: 0, format: 'BINARY', gate: true, squelchDb: 8, minVotes: 4, minVotesCrc: 4, alert2: false }, extra);
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { cfg, audio: false } });
    const decodes = [];
    let fed = 0;
    const band = AlertDsp.demoBand(), STEP = 32768;
    w.on('error', reject);
    w.on('message', (m) => {
      if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); return; }
      if (m.type === 'decode') decodes.push(m);
      if (m.type === 'ready' || m.type === 'fed') {
        if (fed >= band.length) { if (m.type === 'fed') { w.terminate(); resolve(decodes); } return; }
        const chunk = band.slice(fed, Math.min(band.length, fed + STEP));
        fed += STEP;
        w.postMessage({ type: 'iq', buf: chunk.buffer }, [chunk.buffer]);
      }
    });
  });
}
const keys = ds => ds.flatMap(m => m.readings.map(r => r.sensorId + '=' + r.value)).sort().join(' ');

test('the decoder setting: full by default, lean and compare accepted, anything else refused', () => {
  const fs = require('node:fs'), os = require('node:os');
  const c = new Config(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ra-')), 'config.json'));
  assert.equal(c.get().receivers.sdr.decoder, 'full');
  assert.ok(c.update({ receivers: { sdr: { decoder: 'compare' } } }).ok);
  assert.equal(c.get().receivers.sdr.decoder, 'compare');
  const bad = c.update({ receivers: { sdr: { decoder: 'fast' } } });
  assert.equal(bad.ok, false); assert.match(bad.errors[0], /decoder/);
  const boot = require('../lib/bootconf');
  assert.equal(boot.toPatch(boot.parse('sdr_decoder = Lean\n')).patch.receivers.sdr.decoder, 'lean');
});

test('lean and full read the demo band alike through the SDR worker', async () => {
  const full = await run({}), lean = await run({ lean: true });
  assert.equal(keys(full), '2088=143 2442=23 2443=142 4109=1290 4110=12');
  assert.equal(keys(lean), keys(full));
  assert.ok(full.every(m => m.compare == null), 'no comparison unless asked for');
});

test('compare sends the full decoder\'s readings and reports lean agreeing on every burst', async () => {
  const ds = await run({ compare: true });
  assert.equal(keys(ds), '2088=143 2442=23 2443=142 4109=1290 4110=12');
  const cmp = ds.filter(m => m.burst).map(m => m.compare);
  assert.ok(cmp.length >= 3 && cmp.every(c => c && c.same === true && c.msFull > 0 && c.msLean > 0), JSON.stringify(cmp));
});
