'use strict';
// The queue to MegaNet against a stand-in that holds the database's contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const stub = require('./helpers/meganet-stub');
const { Config, merge } = require('../lib/config');
const { Uplink } = require('../lib/uplink');

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 5000)) { if (fn()) return true; await wait(25); } return false; }

function rig(m, over) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-up-'));
  const cfg = new Config(path.join(dir, 'config.json')).load();
  // Deep merge: a test's overrides must never drop the stub's endpoint and reach the real MegaNet.
  cfg.update(merge({ meganet: { token: 'mgn_test_token', endpoints: [m.url + '/rest/v1'] } }, over || {}));
  const clock = Object.assign(new EventEmitter(), { ok: true, trusted() { return this.ok; }, now: () => Date.now(), mono: () => Number(process.hrtime.bigint() / 1000000n), bootId: () => 'boot-a',
    wallOf(mono) { return Date.now() - (this.mono() - mono); } });
  const up = new Uplink({ config: cfg, clock, log: quiet, dataDir: dir });
  return { dir, cfg, clock, up };
}

test('readings go as one batch per receiver and protocol, in MegaNet\'s shape', async () => {
  const m = await stub.start();
  const { up } = rig(m);
  up.load().start();
  const t = Date.now();
  up.addReading({ point: 'rpi-abc-qs1', protocol: 'alert', alert_id: 6129, value_raw: 1599, ts: t, line: 'DEC,…' });
  up.addReading({ point: 'rpi-abc-qs1', protocol: 'alert', alert_id: 6130, value_raw: 134, ts: t });
  up.addReading({ point: 'rpi-abc-ert1', protocol: 'alert2', alert_id: 4909, value_raw: 138, ts: t });
  up.sendNow();
  assert.ok(await until(() => up.status().accepted === 3));
  const ing = m.calls.filter(c => c.fn === 'ingest_http');
  assert.equal(ing.length, 2);
  const p = ing[0].body.payload;
  assert.deepEqual([p.source, p.protocol, p.path], ['serial', 'alert', 'serial-monitor/rpi-abc-qs1']);
  assert.deepEqual(p.readings, [{ alert_id: 6129, reading_ts: t, value_raw: 1599 }, { alert_id: 6130, reading_ts: t, value_raw: 134 }]);
  assert.equal(p.frame, 'DEC,…');
  assert.equal(ing[0].headers['content-profile'], 'meganet');
  assert.ok(ing[0].headers.apikey.startsWith('sb_publishable_'));
  assert.equal(ing[1].body.payload.protocol, 'alert2');
  up.stop(); await m.close();
});

test('a refused token stops sending and keeps everything; a new token sends it', async () => {
  const m = await stub.start();
  const { up, cfg } = rig(m, { meganet: { token: 'mgn_wrong' } });
  up.load().start();
  up.addReading({ point: 'rpi-abc-qs1', protocol: 'alert', alert_id: 1, value_raw: 2, ts: Date.now() });
  up.sendNow();
  assert.ok(await until(() => up.status().tokenRefused));
  assert.equal(up.status().queued, 1);
  cfg.update({ meganet: { token: 'mgn_test_token' } });
  assert.ok(await until(() => up.status().accepted === 1));
  assert.equal(up.status().tokenRefused, false);
  up.stop(); await m.close();
});

test('the second endpoint is used when the first cannot be reached, and remembered', async () => {
  const m = await stub.start();
  const { up } = rig(m, { meganet: { endpoints: ['http://127.0.0.1:9/rest/v1', m.url + '/rest/v1'] } });
  up.load().start();
  up.addReading({ point: 'rpi-abc-sdr1', protocol: 'alert', alert_id: 3, value_raw: 4, ts: Date.now() });
  up.sendNow();
  assert.ok(await until(() => up.status().accepted === 1));
  assert.equal(up.api.good, 1);
  up.stop(); await m.close();
});

test('readings heard before the clock is trusted are held, then timed from the monotonic clock', async () => {
  const m = await stub.start();
  const { up, clock } = rig(m);
  clock.ok = false;
  up.load().start();
  up.addReading({ point: 'rpi-abc-qs1', protocol: 'alert', alert_id: 9, value_raw: 9, ts: null });
  assert.equal(up.status().waitingForClock, 1);
  await wait(300);
  clock.ok = true;
  clock.emit('trusted');
  assert.ok(await until(() => up.status().accepted === 1));
  const ts = m.calls.find(c => c.fn === 'ingest_http').body.payload.readings[0].reading_ts;
  assert.ok(Math.abs(Date.now() - 300 - ts) < 1000, 'timed to when it was heard, not when it was sent');
  up.stop(); await m.close();
});

test('held readings from an earlier boot cannot be timed and are dropped', async () => {
  const m = await stub.start();
  const { up, clock, dir } = rig(m);
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ readings: [], receptions: [], pending: [{ kind: 'reading', item: { point: 'p', protocol: 'alert', alert_id: 1, value_raw: 1 }, mono: 5, boot: 'boot-old' }] }));
  up.load().start();
  clock.emit('trusted');
  assert.equal(up.status().untimedDropped, 1);
  assert.equal(up.status().queued, 0);
  up.stop(); await m.close();
});

test('the queue survives a restart', async () => {
  const m = await stub.start({ down: true });
  const a = rig(m);
  a.up.load().start();
  a.up.addReading({ point: 'rpi-abc-qs1', protocol: 'alert', alert_id: 5, value_raw: 6, ts: Date.now() });
  a.up.stop();
  const cfg = new Config(path.join(a.dir, 'config.json')).load();
  const b = new Uplink({ config: cfg, clock: a.clock, log: quiet, dataDir: a.dir }).load();
  assert.equal(b.status().queued, 1);
  await m.close();
});

test('receptions go to report_receptions; a database without it keeps them', async () => {
  const m = await stub.start({ noReceptions: true });
  const { up } = rig(m);
  up.load().start();
  up.addReception('rpi-abc-qs1', 'quansheng', { heard_at: Date.now(), protocol: 'alert', alert_id: 1, value_raw: 2, ok: true, location_source: 'none', detail: {} });
  up.scheduleRx(0);
  assert.ok(await until(() => up.status().rxMissing));
  assert.equal(up.status().receptionsQueued, 1);
  up.stop(); await m.close();
});

test('a receiver reports itself with its point id, kind and approximate location', async () => {
  const m = await stub.start();
  const { up } = rig(m);
  up.load().start();
  up.registerPoint('rpi-abc-qs1', () => ({ point_id: 'rpi-abc-qs1', name: 'Bench — Quansheng radio', receiver: 'quansheng', detail: { app: 'RPi ALERT' },
    location_source: 'manual', lat: -27.4, lon: 153.0, location_note: 'Approximate' }));
  assert.ok(await until(() => up.status().label === 'Stub base'));
  const r = m.calls.find(c => c.fn === 'report_ingest_point').body.payload;
  assert.equal(r.receiver, 'quansheng');
  up.stop(); await m.close();
});
