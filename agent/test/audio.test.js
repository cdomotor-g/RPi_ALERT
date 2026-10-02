'use strict';
// The re-synthesised chirp is a real ALERT burst: FM-modulate it onto a
// carrier, as a transmitter would, and MegaNet's own off-air decoder reads the
// same frames back.

const test = require('node:test');
const assert = require('node:assert/strict');
const { alertBurst, binaryFrame, RATE } = require('../lib/audio');
const { AlertDsp } = require('../lib/meganet-codecs');

test('the chirp encodes ALERT Binary exactly as alert-dsp.js does', () => {
  for (const [id, v] of [[2088, 143], [6129, 1599], [1, 0], [8191, 2047]]) {
    assert.deepEqual(binaryFrame(id, v), AlertDsp.encodeFrame(AlertDsp.BINARY, id, v));
  }
});

test('the chirp, put on air, decodes back to its readings', () => {
  const audio = alertBurst([{ alert_id: 2088, value_raw: 143 }, { alert_id: 6129, value_raw: 1599 }]);
  const fs = AlertDsp.FS_IN, dev = 3000, seconds = 2.2;
  const n = Math.round(seconds * fs);
  const iq = new Uint8Array(n * 2);
  const start = Math.round(0.6 * fs);
  let ph = 0, seed = 1;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff - 0.5) * 4; };
  for (let i = 0; i < n; i++) {
    const k = Math.floor((i - start) * RATE / fs);
    const a = i >= start && k < audio.length ? audio[k] / 0.55 : 0;
    ph += 2 * Math.PI * dev * a / fs;
    const on = i >= start - fs * 0.05 && k < audio.length + RATE * 0.05;
    iq[2 * i] = Math.round(127.5 + (on ? 40 * Math.cos(ph) : 0) + noise());
    iq[2 * i + 1] = Math.round(127.5 + (on ? 40 * Math.sin(ph) : 0) + noise());
  }
  const r = AlertDsp.decodeU8(iq, { format: AlertDsp.BINARY });
  const got = r.readings.map(x => x.sensorId + '=' + x.value).sort();
  assert.deepEqual(got, ['2088=143', '6129=1599']);
});
