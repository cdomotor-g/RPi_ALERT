'use strict';
// A test ALERT2 transmitter: MANT PDUs of ALERT concentration records → an
// AirLink frame (lib/devices/alert2-air.js encodeFrame) → NRZ, root-raised-
// cosine shaped, on FM → IQ at any rate, at any carrier offset, either way up.
// The decoder's tests send it, and the fake rtl_sdr puts it on the air.

const Air = require('../../lib/devices/alert2-air');

// { source, path, hopLimit, port, stamp, test, records: [{ id, value, before }] } → the PDU's bytes.
function mantPdu(o) {
  const app = [(o.stamp != null ? 4 : 0) | (o.test ? 8 : 0) | ((o.apdu || 0) << 4)];
  if (o.stamp != null) app.push(o.stamp >> 8, o.stamp & 255);
  for (const r of o.records || []) app.push(r.id & 255, ((r.value >> 8) << 5) | (r.id >> 8), r.value & 255, r.before || 0);
  if (o.payload) app.push(...o.payload);
  const path = o.path || null, port = o.port == null ? 1 : o.port;
  const h = [path ? 2 : 0, port << 4, ((o.hopLimit || 0) << 4) | (app.length >> 8), app.length & 255, o.source >> 8, o.source & 255];
  if (path) { h.push(path.length); for (const a of path) h.push(a >> 8, a & 255); }
  return [...h, ...app];
}

// Seconds since 00:00 or 12:00 UTC, as an ALERT2 time stamp counts them.
const stampOf = (ms) => Math.floor((ms % 43200000) / 1000);

// The bits on the air: a preamble, the sync, the coded frame.
function airBits(pdus) {
  const payload = Uint8Array.from(pdus.flatMap(mantPdu));
  const pre = Array.from({ length: 32 }, (_, i) => (i & 1) ^ 1);
  return Uint8Array.from([...pre, ...Air.SYNC, ...Air.encodeFrame(payload), 0, 1, 0, 1]);
}

// The frequency each 48 kHz sample is deviated by (×devHz): each bit ±1
// through the transmit RRC, scaled so that a long run of ones is +1.
function shaped(bits) {
  const sps = Air.SPS, p = Air.rrc(0.96, 6, sps), half = (p.length - 1) >> 1;
  let dc = 0;
  for (let i = half % sps; i < p.length; i += sps) dc += p[i];
  const out = new Float64Array(bits.length * sps + p.length);
  for (let k = 0; k < bits.length; k++) {
    const v = bits[k] ? 1 / dc : -1 / dc;
    for (let i = 0; i < p.length; i++) out[k * sps + i] += v * p[i];
  }
  return { f: out, lead: half };          // sample `lead` is bit 0's centre
}

// Adds a frame to re/im (at `fs`), starting `at` samples in: { pdus, cfoHz,
// amp, devHz, inverted, carrierS (unmodulated carrier first), clockPpm (its bit clock fast by) }. → the sample
// where the sync's first bit is.
function addFrame(re, im, fs, at, o) {
  const bits = airBits(o.pdus);
  const sh = shaped(bits), dev = (o.devHz || 2400) * (o.inverted ? -1 : 1);
  const amp = o.amp || 40, cfo = o.cfoHz || 0;
  const lead = Math.round((o.carrierS != null ? o.carrierS : 0.02) * fs);
  const per = fs / Air.FS / (1 + (o.clockPpm || 0) / 1e6);   // samples here a 48 kHz sample
  const n = lead + Math.round(sh.f.length * per);
  let ph = 0;
  for (let i = 0; i < n && at + i < re.length; i++) {
    let f = 0;
    if (i >= lead) {
      const t = (i - lead) / per, j = Math.floor(t), u = t - j;
      f = j + 1 < sh.f.length ? sh.f[j] * (1 - u) + sh.f[j + 1] * u : 0;
    }
    ph += 2 * Math.PI * (cfo + dev * f) / fs;
    if (at + i >= 0) { re[at + i] += amp * Math.cos(ph); im[at + i] += amp * Math.sin(ph); }
  }
  return at + lead + Math.round((sh.lead + 32 * Air.SPS) * per);
}

function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// A window as the SDR worker hands it over: { fs (240000), seconds, snrDb (in a
// 12 kHz channel, for amp 40), seed, frames: [{ startSec, …addFrame's }] } → { re, im, syncAt }.
function window(o) {
  const fs = o.fs || Air.FS_IN, n = Math.round((o.seconds || 1.5) * fs);
  const re = new Float32Array(n), im = new Float32Array(n);
  if (o.snrDb != null) {
    const rand = rng(o.seed || 7), sigma = 40 / Math.sqrt(2 * Math.pow(10, o.snrDb / 10) * (12000 / fs));
    for (let i = 0; i < n; i++) {
      const u = rand() || 1e-12, v = rand(), m = Math.sqrt(-2 * Math.log(u)) * sigma;
      re[i] = m * Math.cos(2 * Math.PI * v); im[i] = m * Math.sin(2 * Math.PI * v);
    }
  }
  const syncAt = (o.frames || []).map(f => addFrame(re, im, fs, Math.round((f.startSec || 0.4) * fs), f));
  return { re, im, syncAt };
}

module.exports = { mantPdu, stampOf, airBits, addFrame, window };
