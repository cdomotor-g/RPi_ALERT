'use strict';
// The dashboard's graphs (lib/history.js): a minute at a time, per receiver,
// a day kept, and back after a restart.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { History, MINUTE, KEEP_MS } = require('../lib/history');

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };

function fakeAgent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-history-'));
  return Object.assign(new EventEmitter(), {
    dataDir: dir, log: quiet, board: { cores: 4 },
    devices: { status: () => ({
      sdrs: [
        { key: 'stick-a', name: 'RTL-SDR 1', level: { nfDb: -52.3 }, channels: [{ key: 'stick-a', name: 'RTL-SDR 1', level: { nfDb: -52.3 } }] },
        { key: 'stick-b', name: 'RTL-SDR 2', channels: [
          { key: 'stick-b', name: 'RTL-SDR 2 151.5', level: { nfDb: -60 } },
          { key: 'stick-b@151.95', name: 'RTL-SDR 2 151.95', level: { nfDb: -58 } }] },
      ],
      ports: [{ key: 'tty-1', kind: 'quansheng', name: 'Quansheng', state: 'running', detail: { nf_dbm: -121 } }],
    }) },
  });
}

test('bursts, readings and the noise floor, a minute at a time for each receiver', () => {
  const a = fakeAgent();
  let now = 100 * MINUTE + 5000;
  const h = new History(a, { now: () => now }).load();
  a.on('burst', h.onBurst); a.on('reading', h.onReading);
  a.emit('burst', { key: 'stick-b@151.95', receiver: 'RTL-SDR 2 151.95' });
  a.emit('burst', { key: 'stick-b@151.95', receiver: 'RTL-SDR 2 151.95' });
  a.emit('reading', { receiverKey: 'stick-b@151.95', receiver: 'RTL-SDR 2 151.95' });
  h.levels();
  now += 10000;
  a.devices.status = ((st) => () => { const s = st(); s.sdrs[0].level.nfDb = s.sdrs[0].channels[0].level.nfDb = -50.3; return s; })(a.devices.status);
  h.levels();
  now += MINUTE;
  a.emit('burst', { key: 'tty-1', receiver: 'Quansheng' });

  const g = h.get(0);
  const by = Object.fromEntries(g.rx.map(r => [r.key, r]));
  assert.deepEqual(by['stick-b@151.95'].rows, [[100 * MINUTE, 2, 1, -58]]);
  assert.equal(by['stick-a'].rows[0][3], -51.3, 'the minute\'s floor is the average of its samples');
  assert.equal(by['stick-a'].unit, 'dBFS');
  assert.equal(by['tty-1'].unit, 'dBm');
  assert.deepEqual(by['tty-1'].rows.map(r => r.slice(0, 3)), [[100 * MINUTE, 0, 0], [101 * MINUTE, 1, 0]]);
  assert.equal(g.cores, 4);

  const later = h.get(101 * MINUTE);
  assert.deepEqual(later.rx.map(r => r.key), ['tty-1'], 'asked from a minute on: only what has rows since');
  a.removeAllListeners();
});

test('a day is kept, and it is back after a restart', () => {
  const a = fakeAgent();
  let now = 2 * KEEP_MS;
  const h = new History(a, { now: () => now }).load();
  h.count('stick-a', 'RTL-SDR 1', 1, 0);
  now += KEEP_MS / 2;
  h.count('stick-a', 'RTL-SDR 1', 3, 2);
  h.sys.push([now - MINUTE, 51.2, 0.4, 30]);
  h.save();

  const again = new History(a, { now: () => now }).load();
  assert.equal(again.get(0).rx[0].rows.length, 2);
  assert.equal(again.get(0).sys.length, 1);
  now += KEEP_MS / 2 + MINUTE;
  const old = new History(a, { now: () => now }).load();
  assert.deepEqual(old.get(0).rx[0].rows.map(r => r[1]), [3], 'older than a day: gone');
});
