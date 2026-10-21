'use strict';
// Tuning help (lib/devices/carrier.js, lib/devices/tune-help.js): each burst's
// carrier offset measured to tens of Hz, and the ppm and gain suggested from them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { AlertDsp } = require('../lib/meganet-codecs');
const { CarrierMeter } = require('../lib/devices/carrier');
const { TuneHelp, snapGain } = require('../lib/devices/tune-help');

function measure(rate, off, extra) {
  const got = [];
  let meter;
  const p = new AlertDsp.Pipeline((m) => { if (m.type === 'decode' && m.readings.length) got.push((meter.take(m.burst && m.burst.t) || {}).hz); });
  p.configure({ deviceRate: rate, channelOffsetHz: off, format: AlertDsp.BINARY, specHz: 1, scopeHz: 1 });
  meter = new CarrierMeter(p, AlertDsp.FS_BB);
  const iq = AlertDsp.synthIq({ fs: rate, seconds: 4, snrDb: 15, bursts: [{ startSec: 1.5, cfoHz: off + extra, amp: 40, polarity: 'NEG',
    frames: [AlertDsp.encodeFrame(AlertDsp.BINARY, 6129, 1599), AlertDsp.encodeFrame(AlertDsp.BINARY, 6130, 1)] }] });
  for (let o = 0; o < iq.length; o += 65536) { const c = iq.subarray(o, o + 65536); p.feed(c); meter.after(c.length / 2 * AlertDsp.FS_BB / rate); }
  return got;
}

test('a burst\'s carrier offset, to within a few tens of Hz', () => {
  for (const [rate, off, extra] of [[240000, 0, -450], [960000, 240000, 300], [960000, 240000, 0]]) {
    const got = measure(rate, off, extra);
    assert.equal(got.length, 1, 'one decoded burst');
    assert.ok(Math.abs(got[0] - extra) <= 40, rate + ' ksps, ' + extra + ' Hz off: measured ' + got[0]);
  }
});

test('ppm: a median for each station, then of the stations; heard high means the correction goes down', () => {
  const h = new TuneHelp();
  const f = 151.5e6;
  // The stick is 3 ppm slow (bursts heard 454 Hz high); stations are ±0.5 ppm.
  const hz = (stationPpm) => Math.round((3 + stationPpm) * f / 1e6);
  assert.equal(h.ppm(0).state, 'measuring');
  for (const [id, sp] of [[2088, 0.5], [2443, -0.4], [6129, 0.1], [4079, -0.2]]) for (let i = 0; i < 3; i++) h.carrier(id, hz(sp), f, 0);
  const p = h.ppm(0);
  assert.equal(p.state, 'change');
  assert.equal(p.suggest, -3);
  assert.equal(p.stations, 4);
  // Set to -3, the bursts now arrive near the channel: still -3, and it says so.
  for (const id of [2088, 2443, 6129]) for (let i = 0; i < 3; i++) h.carrier(id, 20, f, -3);
  assert.equal(h.ppm(-3).state, 'ok');
  assert.equal(h.ppm(-3).suggest, -3);
});

test('gain: down when bursts saturate or the ADC clips, up when the strongest are weak, else as it is', () => {
  const sat = new TuneHelp();
  for (let i = 0; i < 10; i++) sat.burst(i < 4 ? -1 : -20, 40.2);
  const g = sat.gain(40.2, 0);
  assert.equal(g.state, 'change');
  assert.equal(g.why, 'saturated');
  assert.ok(g.suggest <= 32.2 && g.suggest >= 25, 'at least 8 dB down: ' + g.suggest);

  const clip = new TuneHelp();
  assert.equal(clip.gain(null, 2).why, 'clipping', 'the tuner\'s AGC clipping: a fixed gain');

  const weak = new TuneHelp();
  for (let i = 0; i < 10; i++) weak.burst(-45 + i, 20.7);
  const w = weak.gain(20.7, 0);
  assert.equal(w.state, 'change');
  assert.equal(w.why, 'weak');
  assert.ok(w.suggest > 20.7 && w.suggest <= 33.8, 'up, by no more than about 12 dB: ' + w.suggest);

  const fine = new TuneHelp();
  for (let i = 0; i < 10; i++) fine.burst(-15 - i, 29.7);
  assert.equal(fine.gain(29.7, 0).state, 'ok');
  assert.equal(fine.gain(33.8, 0).state, 'measuring', 'bursts heard at another gain do not count');

  assert.equal(snapGain(30, -1), 29.7);
  assert.equal(snapGain(30, 1), 32.8);
});
