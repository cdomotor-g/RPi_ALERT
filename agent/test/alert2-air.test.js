'use strict';
// ALERT2 off the air (lib/devices/alert2-air.js, alert2-fec.js): two real
// frames, recorded at 18 Bateson on 151.5375 MHz by an FC0013 stick, decode as
// they did when the decoder was worked out — their ALERT ids are the network's
// own sensors — and the test transmitter's frames come back through a carrier
// off the channel, upside down, in noise, two to a burst, and long.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Air = require('../lib/devices/alert2-air');
const F = require('../lib/devices/alert2-fec');
const Tx = require('./helpers/alert2-tx');
const { AlertDsp } = require('../lib/meganet-codecs');

const FIX = path.join(__dirname, 'fixtures');

function fixture(name) {
  const u8 = fs.readFileSync(path.join(FIX, name)), n = u8.length >> 1;
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) { re[i] = u8[2 * i] - 127.5; im[i] = u8[2 * i + 1] - 127.5; }
  return { re, im };
}

const brief = (p) => ({ source: p.source, port: p.port, path: p.path, hopLimit: p.hopLimit, stamp: p.app && p.app.stamp,
  records: p.app ? p.app.records.map(r => [r.id, r.value, r.before]) : null });

test('a real frame: three PDUs, one ALERT concentration record relayed by two paths', () => {
  const w = fixture('alert2_151.5375_3pdus.iq8');
  const r = Air.plain(Air.receive(w.re, w.im));
  assert.equal(r.frames.length, 1);
  const f = r.frames[0];
  assert.ok(f.ok, f.error);
  assert.equal(f.len, 74);
  assert.equal(f.blocks, 3);
  assert.equal(f.inverted, true, 'an FC0013 channel arrives upside down');
  assert.equal(f.baud, 4800);
  assert.ok(f.cfoHz > 2500 && f.cfoHz < 3300, 'carrier ' + f.cfoHz);
  assert.ok(f.at > 0.4 && f.at < 0.5, 'sync at ' + f.at + ' s: 0.4 s of window before the burst');
  assert.deepEqual(f.pdus.map(brief), [
    { source: 11762, port: 1, path: [10115, 11056, 10019], hopLimit: 1, stamp: 7907, records: [[7182, 18, 11], [7182, 18, 10], [7171, 13, 4]] },
    { source: 11762, port: 1, path: [10115, 11056, 33300, 10019], hopLimit: 0, stamp: 7907, records: [[7182, 18, 11], [7182, 18, 10], [7171, 13, 4]] },
    { source: 33300, port: 1, path: [10019], hopLimit: 4, stamp: 7941, records: [[1909, 38, 52]] },
  ]);
  assert.equal(f.pdus[2].app.records[0].hex, '75072634');
});

test('a real frame: a short one, with a PDU on another port', () => {
  const w = fixture('alert2_151.5375_2pdus.iq8');
  const f = Air.plain(Air.receive(w.re, w.im)).frames;
  assert.equal(f.length, 1);
  assert.ok(f[0].ok, f[0].error);
  assert.equal(f[0].len, 33);
  assert.deepEqual(f[0].pdus.map(brief), [
    { source: 33300, port: 1, path: [11056, 10019], hopLimit: 3, stamp: 7941, records: [[1909, 38, 52]] },
    { source: 10019, port: 0, path: [], hopLimit: 1, stamp: 7976, records: [] },
  ]);
  assert.equal(f[0].pdus[1].app.apdu, 6);
});

const PDUS = [
  { source: 11762, path: [10115, 11056], hopLimit: 2, stamp: 7907, records: [{ id: 7182, value: 18, before: 11 }, { id: 7171, value: 2047, before: 4 }] },
  { source: 33300, stamp: 7941, records: [{ id: 8191, value: 0, before: 255 }] },
];
const recs = (f) => f.pdus.map(p => p.source + ':' + p.app.records.map(r => r.id + '=' + r.value + '@' + r.before).join(','));

test('the test transmitter\'s frame: 3 kHz off, upside down, at 8 dB in a 12 kHz channel', () => {
  for (const [cfoHz, inverted] of [[3000, true], [-2500, false]]) {
    const w = Tx.window({ seconds: 1.3, snrDb: 8, seed: 3, frames: [{ startSec: 0.4, pdus: PDUS, cfoHz, inverted }] });
    const f = Air.plain(Air.receive(w.re, w.im)).frames;
    assert.equal(f.length, 1);
    assert.ok(f[0].ok, f[0].error);
    assert.equal(f[0].inverted, inverted);
    assert.ok(Math.abs(f[0].cfoHz - cfoHz) < 200, 'carrier ' + f[0].cfoHz);
    assert.ok(Math.abs(f[0].at - w.syncAt[0] / Air.FS_IN) < 0.001);
    assert.deepEqual(recs(f[0]), ['11762:7182=18@11,7171=2047@4', '33300:8191=0@255']);
  }
});

test('two stations\' frames in one burst, each on its own carrier, are both read', () => {
  const w = Tx.window({ seconds: 2, snrDb: 20, seed: 9, frames: [
    { startSec: 0.4, pdus: [PDUS[0]], cfoHz: 2900, inverted: true },
    { startSec: 0.75, pdus: [PDUS[1]], cfoHz: -1200, inverted: true },
  ] });
  const f = Air.plain(Air.receive(w.re, w.im)).frames;
  assert.deepEqual(f.map(x => [x.ok, x.pdus.map(p => p.source)]), [[true, [11762]], [true, [33300]]]);
});

test('only frames that start in the gated burst: the next slot\'s, in the window\'s margin after it, is left to its own burst', () => {
  // The window as the worker has it: 0.45 s of margin, a 0.3 s burst, the next station's frame 0.35 s after it.
  const w = Tx.window({ seconds: 1.5, snrDb: 20, seed: 6, frames: [
    { startSec: 0.43, pdus: [PDUS[1]], cfoHz: 2900, inverted: true },
    { startSec: 1.08, pdus: [PDUS[0]], cfoHz: 2900, inverted: true },
  ] });
  assert.equal(Air.receive(w.re, w.im).frames.length, 2, 'both, without the gate\'s bounds');
  const f = Air.plain(Air.receive(w.re, w.im, { syncFrom: 0.45 - 0.15, syncTo: 0.75 - 0.1 })).frames;
  assert.deepEqual(f.map(x => [x.ok, x.pdus.map(p => p.source)]), [[true, [33300]]]);
});

test('a long frame — 680 bytes, 22 blocks, 3.5 s — from a transmitter whose clock is 0.1 % fast', () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ source: 10000 + i, stamp: 100 + i, records: [{ id: i, value: i * 3, before: 1 }, { id: i + 100, value: 5, before: 2 }] });
  const w = Tx.window({ seconds: 4.6, snrDb: 15, seed: 5, frames: [{ startSec: 0.4, pdus: many, cfoHz: 1500, inverted: true, clockPpm: 1000 }] });
  const f = Air.plain(Air.receive(w.re, w.im)).frames;
  assert.equal(f.length, 1);
  assert.ok(f[0].ok, f[0].error);
  assert.equal(f[0].len, 680);
  assert.equal(f[0].blocks, 22);
  assert.ok(Math.abs(f[0].baud - 4804.8) < 1, 'baud ' + f[0].baud);
  assert.equal(f[0].pdus.length, 40);
  assert.deepEqual(f[0].pdus[39].app.records.map(r => [r.id, r.value]), [[39, 117], [139, 5]]);
});

test('a frame cut short by the end of the window is a sync and an error, not readings', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ source: 10000 + i, stamp: 1, records: [{ id: i, value: 1 }] }));
  const w = Tx.window({ seconds: 1.5, snrDb: 20, seed: 4, frames: [{ startSec: 0.4, pdus: many }] });
  const f = Air.plain(Air.receive(w.re, w.im)).frames;
  assert.equal(f.length, 1);
  assert.equal(f[0].ok, false);
  assert.match(f[0].error, /ends before its frame/);
  assert.deepEqual(f[0].pdus, []);
});

test('noise, and a legacy ALERT burst, are not ALERT2', () => {
  const quiet = Tx.window({ seconds: 1.5, snrDb: 10, seed: 11 });
  assert.deepEqual(Air.receive(quiet.re, quiet.im).frames, []);
  const u8 = AlertDsp.synthIq({ fs: AlertDsp.FS_IN, seconds: 1.5, startSec: 0.4, snrDb: 25, seed: 2, cfoHz: 2000,
    frames: [AlertDsp.encodeFrame(AlertDsp.BINARY, 2088, 143), AlertDsp.encodeFrame(AlertDsp.BINARY, 2089, 12)] });
  const n = u8.length >> 1, re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) { re[i] = u8[2 * i] - 127.5; im[i] = u8[2 * i + 1] - 127.5; }
  assert.deepEqual(Air.receive(re, im).frames, []);
});

test('every frame length codes and decodes, bit for bit, around the first block\'s edge', () => {
  for (const len of [0, 1, 21, 22, 23, 54, 55, 86, 300, 1023]) {
    const payload = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) & 255);
    const bits = Air.encodeFrame(payload);
    assert.equal(bits.length, Air.FIRST_CODED + Air.followOn(len).coded, 'len ' + len);
    const d = Air.decodeFrame(Float64Array.from(bits, b => (b ? 1 : -1)));
    assert.ok(d.ok, len + ': ' + d.error);
    assert.equal(d.len, len);
    assert.deepEqual(Array.from(d.payload), Array.from(payload));
  }
});

test('Reed–Solomon: 8 bad bytes in a block are put right; 9 are refused', () => {
  let seed = 1;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let trial = 0; trial < 20; trial++) {
    const data = Uint8Array.from({ length: 32 }, () => Math.floor(rand() * 256));
    const block = Uint8Array.from([...data, ...F.rsEncode(data)]);
    for (const errs of [1, 4, 8, 9]) {
      const bad = Uint8Array.from(block), at = new Set();
      while (at.size < errs) at.add(Math.floor(rand() * bad.length));
      for (const j of at) bad[j] ^= 1 + Math.floor(rand() * 255);
      const r = F.rsDecode(bad);
      if (errs <= 8) { assert.ok(r.ok, errs + ' errors'); assert.equal(r.errors, errs); assert.deepEqual(Array.from(r.data), Array.from(block)); }
      else assert.equal(r.ok, false, '9 errors are more than 16 parity bytes can correct');
    }
  }
});

test('the scrambler undoes itself, and one bit wrong on the air is three wrong after it', () => {
  const bits = Uint8Array.from({ length: 200 }, (_, i) => (i * 7) % 3 === 0 ? 1 : 0);
  const s = F.scramble(bits);
  assert.deepEqual(Array.from(F.descramble(s)), Array.from(bits));
  s[50] ^= 1;
  const d = F.descramble(s);
  assert.deepEqual(d.reduce((a, b, i) => (b !== bits[i] ? a.concat(i) : a), []), [50, 53, 67]);
});
