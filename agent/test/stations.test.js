'use strict';
// MegaNet's station register on the Pi (lib/stations.js): the frequencies its
// stations use, for a stick's channels to be offered from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Stations, buildIndex, NEAR_KM } = require('../lib/stations');

const DOC = { stations: [
  { id: 'a_rptr', name: 'A Repeater', lat: -27.33, lon: 152.76, repeater: { rx_mhz: 151.5, tx_mhz: 151.5 },
    frequencies: [{ rx_mhz: 151.5375, tx_mhz: 151.5375, label: 'Link to Ipswich' }, { rx_mhz: 152.25, tx_mhz: 152.25, label: 'Seqwater data' }] },
  { id: 'b_rptr', name: 'B Repeater', lat: -27.9, lon: 152.3, repeater: { rx_mhz: 151.5, tx_mhz: 151.95 } },
  { id: 'far_rptr', name: 'Far Repeater', lat: -19.25, lon: 146.8, repeater: { rx_mhz: 152.4, tx_mhz: 152.4 } },
  { id: 'far_two', name: 'Far Two', lat: -19.3, lon: 146.7, repeater: { rx_mhz: 152.4, tx_mhz: 152.4 } },
  { id: 'base', name: 'A Base', lat: -27.47, lon: 153.02, frequencies: [{ rx_mhz: 151.5, label: 'Heard on, per a map' }] },
  { id: 'odd', name: 'Odd', repeater: { rx_mhz: 'x', tx_mhz: 4000 } },
] };

test('the frequencies the stations use: who sends and who listens, what for, the nearest first', () => {
  const idx = buildIndex(DOC);
  assert.equal(idx.v, 2);
  assert.deepEqual(idx.freqs.map(f => f[0]), [151500000, 151537500, 151950000, 152250000, 152400000], 'every pair, and nothing that is not a frequency');
  const s = new Stations({ dataDir: os.tmpdir(), log: console, getUrls: () => [] });
  s.index = idx;
  let f = s.frequencies();
  assert.deepEqual(f.map(x => [x.freqHz, x.tx, x.rx, x.near]), [[151500000, 1, 3, null], [152400000, 2, 2, null], [151537500, 1, 1, null], [152250000, 1, 1, null], [151950000, 1, 0, null]],
    'with no location, the most used first');
  assert.deepEqual(f[0].labels, [], 'a pair only listened to says nothing of what it is for');
  assert.deepEqual(f.find(x => x.freqHz === 151537500).labels, ['Link to Ipswich']);
  // Near Brisbane: what is used within NEAR_KM first, then the nearest.
  f = s.frequencies({ lat: -27.47, lon: 153.02 });
  assert.equal(NEAR_KM, 150);
  assert.deepEqual(f.map(x => [x.freqHz, x.near]), [[151500000, 3], [151537500, 1], [152250000, 1], [151950000, 1], [152400000, 0]]);
  assert.deepEqual(f[0].stations.map(w => [w.name, w.km, w.tx, w.rx]), [['A Base', 0, false, true], ['A Repeater', 30, true, true], ['B Repeater', 86, false, true]]);
  assert.ok(f[4].km > 1000, 'Townsville\'s channel is a long way off');
});

test('an index from before it held the frequencies is used, and fetched again at once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-st-'));
  const old = buildIndex(DOC);
  delete old.v; delete old.freqs;
  fs.writeFileSync(path.join(dir, 'stations-index.json'), JSON.stringify(old));
  const s = new Stations({ dataDir: dir, log: console, getUrls: () => [] }).load();
  assert.equal(s.index.count, DOC.stations.length);
  assert.equal(s.fetchedAt, 0, 'due now');
  assert.deepEqual(s.frequencies(), []);
  fs.writeFileSync(path.join(dir, 'stations-index.json'), JSON.stringify(buildIndex(DOC)));
  assert.ok(new Stations({ dataDir: dir, log: console, getUrls: () => [] }).load().fetchedAt > 0);
});
