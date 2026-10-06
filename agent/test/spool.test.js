'use strict';
// The queue on disk (lib/spool.js): append-only, bounded by disk rather than
// memory, and safe across restarts and power cuts — so that days of a site
// survey with no network, then a backfill, fit on any Pi.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const stub = require('./helpers/meganet-stub');
const { Spool } = require('../lib/spool');
const { Config, merge } = require('../lib/config');
const { Uplink } = require('../lib/uplink');

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 5000)) { if (fn()) return true; await wait(25); } return false; }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-spool-'));

// A reception as an RTL-SDR channel sends one, at its real size (~450 bytes).
function rx(i, t0) {
  return { point: 'rpi-6dfef7f4-sdr1-151.525', receiver: 'rtl-sdr', rx: { heard_at: t0 + i * 9000, protocol: 'alert', alert_id: 1000 + (i % 700), value_raw: i % 2048,
    payload_hex: 'A1B2C3D4', ok: true, fault: null, rssi_dbm: null, level_dbfs: -31.5, nf_dbm: null, votes: 12, location_source: 'gps',
    detail: { app: 'RPi ALERT', fmt: 'ABF', polarity: 1, carrier_hz: 1200.5, crc: true, nf_dbfs: -58.2, snr_db: 24.1, freq_mhz: 151.525, survey: 's20261006-3fa1' },
    lat: -27.46981, lon: 153.02512, accuracy_m: 4.2 } };
}

test('items come back oldest first, across segments, and sent ones are forgotten', () => {
  const dir = tmp();
  const s = new Spool({ dir, segItems: 10 }).load();
  for (let i = 0; i < 35; i++) s.push({ i });
  s.flush();
  assert.equal(s.length, 35);
  const w = s.peek(15);
  assert.deepEqual(w.map(e => e.item.i), Array.from({ length: 15 }, (_, i) => i));
  s.ack(w);
  s.flush();
  assert.equal(s.length, 20);
  // The first segment is all sent: gone from the card. The second is half sent.
  const files = fs.readdirSync(dir).sort();
  assert.ok(!files.includes('0000000001.n10.jsonl'), files.join(' '));
  assert.ok(files.includes('0000000002.n10.jsonl') && files.includes('0000000002.ack'), files.join(' '));
  assert.deepEqual(s.peek(3).map(e => e.item.i), [15, 16, 17]);
});

test('sent out of order (one receiver\'s batch at a time), nothing is lost or sent twice', () => {
  const dir = tmp();
  const s = new Spool({ dir, segItems: 8 }).load();
  for (let i = 0; i < 40; i++) s.push({ i, p: i % 3 });
  const seen = [];
  for (let round = 0; round < 50 && s.length; round++) {
    const w = s.peek(12);
    const p = w[0].item.p;
    const pick = w.filter(e => e.item.p === p);
    seen.push(...pick.map(e => e.item.i));
    s.ack(pick);
    if (round % 3 === 0) s.flush();
  }
  assert.equal(s.length, 0);
  assert.deepEqual(seen.slice().sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i));
});

test('a restart carries on where it left off, and a line cut short by a power cut is skipped', () => {
  const dir = tmp();
  const a = new Spool({ dir, segItems: 10 }).load();
  for (let i = 0; i < 25; i++) a.push({ i });
  a.ack(a.peek(4));
  a.flush();
  // The power goes mid-line, in the newest segment.
  const open = fs.readdirSync(dir).find(f => /^\d{10}\.jsonl$/.test(f));
  fs.appendFileSync(path.join(dir, open), '{"i":25,"half');
  const b = new Spool({ dir, segItems: 10 }).load();
  assert.equal(b.length, 22, '25 written, 4 sent, plus the half line until it is read');
  const all = [];
  while (b.length) { const w = b.peek(7); if (!w.length) break; all.push(...w.map(e => e.item.i)); b.ack(w); }
  assert.deepEqual(all, Array.from({ length: 21 }, (_, i) => i + 4));
  assert.equal(b.bad, 1);
  b.push({ i: 99 });
  assert.deepEqual(b.peek(5).map(e => e.item.i), [99], 'appended to a new segment, never after the half line');
});

test('dropOldest makes room from the front and says how much went', () => {
  const s = new Spool({ dir: tmp(), segItems: 10 }).load();
  for (let i = 0; i < 30; i++) s.push({ i });
  s.ack(s.peek(3));
  assert.equal(s.dropOldest(), 7);
  assert.equal(s.length, 20);
  assert.equal(s.peek(1)[0].item.i, 10);
});

test('drain hands over every waiting item once and empties the queue', () => {
  const s = new Spool({ dir: tmp(), segItems: 10 }).load();
  for (let i = 0; i < 23; i++) s.push({ i });
  s.ack(s.peek(2));
  const got = [];
  s.drain(x => got.push(x.i));
  assert.deepEqual(got, Array.from({ length: 21 }, (_, i) => i + 2));
  assert.equal(s.length, 0);
});

test('three days of a busy four-channel survey queue on disk, not in memory', () => {
  const dir = tmp();
  const t0 = Date.UTC(2026, 9, 6);
  if (global.gc) global.gc();
  const h0 = process.memoryUsage().heapUsed;
  const s = new Spool({ dir }).load();
  const N = 150000;   // ~4 channels × 12,000 frames a day × 3 days, with a storm in it
  for (let i = 0; i < N; i++) { s.push(rx(i, t0)); if (i % 5000 === 0) s.flush(); }
  s.flush();
  if (global.gc) global.gc();
  const grew = (process.memoryUsage().heapUsed - h0) / 1048576;
  assert.equal(s.length, N);
  assert.ok(s.loadedItems() <= 3000, 'in memory: ' + s.loadedItems());
  // The all-in-memory queue held this as ~70 MB of heap; it must not grow with the backlog.
  if (global.gc) assert.ok(grew < 15, 'heap grew ' + grew.toFixed(1) + ' MB');
  const mb = s.bytes() / 1048576;
  assert.ok(mb > 50 && mb < 90, mb.toFixed(1) + ' MB on disk');
  const b = new Spool({ dir }).load();
  assert.equal(b.length, N);
  assert.equal(b.peek(1)[0].item.rx.heard_at, t0);
});

function rig(m, over) {
  const dir = tmp();
  const cfg = new Config(path.join(dir, 'config.json')).load();
  cfg.update(merge({ meganet: { token: 'mgn_test_token', endpoints: [m.url + '/rest/v1'] } }, over || {}));
  const clock = Object.assign(new EventEmitter(), { trusted: () => true, now: () => Date.now(), mono: () => Number(process.hrtime.bigint() / 1000000n), bootId: () => 'boot-a', wallOf: (x) => x });
  return { dir, cfg, up: new Uplink({ config: cfg, clock, log: quiet, dataDir: dir }) };
}

test('a backlog goes in full batches, every reception once, and the disk is given back', async () => {
  const m = await stub.start();
  const { up, dir } = rig(m);
  up.load();
  const t0 = Date.now() - 3 * 86400e3;
  for (let i = 0; i < 5200; i++) { const r = rx(i, t0); up.addReception(r.point, r.receiver, r.rx); }
  up.persistNow();
  up.start();
  // (The last part-batch would wait its ten seconds; nudged here.)
  assert.ok(await until(() => { if (!up.rxInflight) up.scheduleRx(0); return up.status().receptionsQueued === 0; }, 15000), 'left: ' + up.status().receptionsQueued);
  assert.equal(m.stored.receptions.length, 5200);
  assert.equal(new Set(m.stored.receptions.map(r => r.heard_at)).size, 5200);
  assert.ok(m.calls.filter(c => c.fn === 'report_receptions').every(c => c.body.payload.receptions.length <= 1000));
  up.persistNow();
  const left = fs.readdirSync(path.join(dir, 'queue', 'receptions')).filter(f => f.endsWith('.jsonl'));
  assert.ok(left.length <= 1, 'segments left: ' + left.join(' '));
  up.stop(); await m.close();
});

test('a batch that times out in the database is tried again smaller', async () => {
  const m = await stub.start({ timeoutOver: 300 });
  const { up } = rig(m);
  up.load();
  up.stopped = true;   // no timers: each try is made by hand below, without its backoff
  const t = Date.now() - 86400e3;
  for (let i = 0; i < 1200; i++) up.addReading({ point: 'rpi-abc-sdr1', protocol: 'alert', alert_id: 1000 + i, value_raw: i % 2048, ts: t + i * 1000 });
  const sizes = [];
  for (let k = 0; k < 12 && up.status().queued; k++) {
    const n = m.calls.length;
    await up.flush();
    if (m.calls.length > n) sizes.push(m.calls[m.calls.length - 1].body.payload.readings.length);
  }
  // 1000 and 500 meet the timeout; 250 goes, and the batch grows back from there.
  assert.deepEqual(sizes.slice(0, 3), [1000, 500, 250]);
  assert.equal(up.status().queued, 0);
  assert.equal(up.status().accepted, 1200);
  up.stop(); await m.close();
});

test('past meganet.queueMb the oldest is dropped and counted', async () => {
  const m = await stub.start({ down: true });
  const { up } = rig(m, { meganet: { queueMb: 16 } });
  up.load();
  const t0 = Date.now();
  for (let i = 0; i < 60000; i++) { const r = rx(i, t0); up.addReception(r.point, r.receiver, r.rx); if (i % 10000 === 0) up.persistNow(); }
  up.persistNow();
  assert.ok(up.queueBytes() <= 16 * 1048576, (up.queueBytes() / 1048576).toFixed(1) + ' MB');
  assert.ok(up.status().dropped > 0);
  assert.equal(up.status().receptionsQueued + up.status().dropped, 60000);
  up.stop(); await m.close();
});

test('the queue of 0.8 (one JSON file) is moved into the spool', async () => {
  const m = await stub.start({ down: true });
  const { up, dir } = rig(m);
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ readings: [{ point: 'p1', protocol: 'alert', alert_id: 1, value_raw: 2, reading_ts: 1 }],
    receptions: [rx(1, Date.now())], pending: [] }));
  up.load();
  assert.equal(up.status().queued, 1);
  assert.equal(up.status().receptionsQueued, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'queue.json')));
  up.stop(); await m.close();
});
