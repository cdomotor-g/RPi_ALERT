'use strict';
// ALERT2 off the air: the NHWC AirLink layer (1.1) on an RTL-SDR channel.
//
// A burst the legacy decoder (alert-dsp.js) cannot read may be ALERT2 — 4800
// bits a second of NRZ, root-raised-cosine shaped (β 0.96), on FM; TDMA, so a
// station's frame comes in its own slot. This takes the pipeline's own window
// of the burst (240 ksps, centred on the channel, 0.4 s either side) and finds
// the frames in it:
//
//   where the burst's power is, against the quiet around it → its carrier
//   mixed down, ±7 kHz, 48 kHz → FM discriminator → matched RRC filter
//   the 80-bit sync, 0xEB90B433AAAA then 0x352EF853, either polarity (an
//     FC0013's channel arrives upside down)
//   the bit clock: the period and phase that open the eye widest, over the
//     sync and first block, and then finely over the whole frame (a clock
//     0.3 % fast is still read; a crystal is within 0.01 %)
//   the first block: 24 bytes and 16 of Reed–Solomon parity, convolutionally
//     coded on its own → its header (2 bits version, 4 reserved, 10 bits LEN)
//   LEN − 22 more bytes in follow-on blocks of 32 (16 parity each), one coded
//     stream; each block descrambled from scratch (alert2-fec.js)
//   the MANT PDUs in those LEN bytes, and in each one's application payload
//     (port 1, ALERT concentration) its 4-byte records: a 13-bit ALERT id, an
//     11-bit value and how many seconds before the PDU's time stamp it was
//
// Every block is checked by its parity: a frame decodes or it does not, so a
// frame from here is as good as one from a hardware ALERT2 receiver.

const F = require('./alert2-fec');

const FS_IN = 240000, DEC = 5, FS = FS_IN / DEC, BAUD = 4800, SPS = FS / BAUD;   // 48 kHz: 10 samples a bit
const SYNC_HEX = 'EB90B433AAAA352EF853';
const SYNC = Uint8Array.from([...SYNC_HEX].flatMap(h => { const v = parseInt(h, 16); return [3, 2, 1, 0].map(b => (v >> b) & 1); }));
const FIRST_BYTES = 24, BLOCK_BYTES = 32, PARITY = F.RS.nroots;
const FIRST_CODED = 656;            // (40 bytes + a 7-bit tail) × 2 = 654, and two spare bits
const HEAD_BITS = SYNC.length + FIRST_CODED;
const SYNC_MIN = 0.6;               // normalised correlation for a sync worth trying
const SYNC_ERRS = 10;               // of its 80 bits, once clocked: noise gets ~40

// ── filters ────────────────────────────────────────────────────────────────

function lowpass(numTaps, cutoff) {           // Blackman-windowed sinc, cutoff a fraction of the rate
  const h = new Float64Array(numTaps), M = numTaps - 1;
  let s = 0;
  for (let n = 0; n < numTaps; n++) {
    const x = n - M / 2;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    h[n] = sinc * (0.42 - 0.5 * Math.cos(2 * Math.PI * n / M) + 0.08 * Math.cos(4 * Math.PI * n / M));
    s += h[n];
  }
  return h.map(v => v / s);
}

function rrc(beta, span, sps) {               // unit energy, `span` symbols either side
  const n = 2 * span * sps + 1, h = new Float64Array(n);
  let e = 0;
  for (let i = 0; i < n; i++) {
    const t = (i - (n - 1) / 2) / sps;
    let v;
    if (Math.abs(t) < 1e-12) v = 1 - beta + 4 * beta / Math.PI;
    else if (Math.abs(Math.abs(4 * beta * t) - 1) < 1e-9) v = beta / Math.SQRT2 * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * beta)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * beta)));
    else v = (Math.sin(Math.PI * t * (1 - beta)) + 4 * beta * t * Math.cos(Math.PI * t * (1 + beta))) / (Math.PI * t * (1 - (4 * beta * t) ** 2));
    h[i] = v; e += v * v;
  }
  return h.map(v => v / Math.sqrt(e));
}

function fir(x, h) {                          // same length out, centred
  const y = new Float64Array(x.length), L = h.length, half = (L - 1) >> 1, n = x.length;
  for (let i = 0; i < n; i++) {
    let a = 0;
    const k0 = Math.max(0, i + half - n + 1), k1 = Math.min(L - 1, i + half);
    for (let k = k0; k <= k1; k++) a += x[i + half - k] * h[k];
    y[i] = a;
  }
  return y;
}

function fft(re, im) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len, h = len >> 1;
    for (let k = 0; k < h; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
      for (let i = k; i < N; i += len) {
        const b = i + h, vr = re[b] * wr - im[b] * wi, vi = re[b] * wi + im[b] * wr;
        re[b] = re[i] - vr; im[b] = im[i] - vi; re[i] += vr; im[i] += vi;
      }
    }
  }
}

const LPF_IN = lowpass(121, 12500 / FS_IN);  // 240k → 48k: ±12.5 kHz, room for any carrier
const LPF_CH = lowpass(63, 7000 / FS);        // at 48k, mixed down: the signal's own ±7 kHz
const MATCHED = rrc(0.96, 6, SPS);
const MATCHED_DC = MATCHED.reduce((a, v) => a + v, 0);   // its gain at 0 Hz: y's dc ÷ this is Hz

// 240 ksps → 48 kHz, ±12.5 kHz about the channel. Output o is input sample 5·o.
function decimate(re, im) {
  const L = LPF_IN.length, half = (L - 1) >> 1, n = re.length, m = Math.floor(n / DEC);
  const br = new Float64Array(m), bi = new Float64Array(m);
  for (let o = 0; o < m; o++) {
    const c = o * DEC;
    let sr = 0, si = 0;
    const k0 = Math.max(0, c + half - n + 1), k1 = Math.min(L - 1, c + half);
    for (let k = k0; k <= k1; k++) { const j = c + half - k; sr += re[j] * LPF_IN[k]; si += im[j] * LPF_IN[k]; }
    br[o] = sr; bi[o] = si;
  }
  return { re: br, im: bi };
}

// ── the burst and its carrier ──────────────────────────────────────────────

const BLOCK = FS / 100;                       // 10 ms
const NFFT = 1024, FFT_MAX = 48, CARRIER_SPAN_HZ = 10000;

// Which 10 ms blocks of the window hold the burst (4 dB over the floor, the
// window's quietest fifth) and which are quiet (under 2 dB over it).
function burstSpan(bb) {
  const nb = Math.floor(bb.re.length / BLOCK);
  if (nb < 10) return null;
  const p = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let k = b * BLOCK, e = k + BLOCK; k < e; k++) s += bb.re[k] * bb.re[k] + bb.im[k] * bb.im[k];
    p[b] = s / BLOCK;
  }
  const floor = Array.from(p).sort((a, b) => a - b)[Math.floor(nb / 5)] || 1e-12;
  const hot = Array.from(p, v => v > floor * 2.5), quiet = Array.from(p, v => v < floor * 1.6);
  const first = hot.indexOf(true);
  return first < 0 ? null : { hot, quiet, first: first * BLOCK, last: (hot.lastIndexOf(true) + 1) * BLOCK };
}

// The carrier, Hz from the channel: the centroid of the power the burst adds
// to the quiet's spectrum, within ±10 kHz.
function carrier(bb, span) {
  const win = new Float64Array(NFFT);
  for (let k = 0; k < NFFT; k++) win[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (NFFT - 1));
  const per = Math.ceil(NFFT / BLOCK);
  const starts = (mark) => {
    const out = [];
    for (let b = 0; b + per <= mark.length; b++) {
      let all = true;
      for (let j = 0; j < per; j++) if (!mark[b + j]) { all = false; break; }
      if (all) out.push(b * BLOCK);
    }
    const step = Math.max(1, out.length / FFT_MAX);
    return out.filter((_, i) => Math.floor(i % step) === 0).slice(0, FFT_MAX);
  };
  const avg = (list) => {
    const acc = new Float64Array(NFFT), r = new Float64Array(NFFT), i = new Float64Array(NFFT);
    for (const s of list) {
      for (let k = 0; k < NFFT; k++) { r[k] = bb.re[s + k] * win[k]; i[k] = bb.im[s + k] * win[k]; }
      fft(r, i);
      for (let k = 0; k < NFFT; k++) acc[k] += r[k] * r[k] + i[k] * i[k];
    }
    if (list.length) for (let k = 0; k < NFFT; k++) acc[k] /= list.length;
    return acc;
  };
  const sig = starts(span.hot);
  if (!sig.length) return 0;
  const s = avg(sig), q = avg(starts(span.quiet));
  let num = 0, den = 0;
  for (let k = 0; k < NFFT; k++) {
    const f = (k < NFFT / 2 ? k : k - NFFT) * FS / NFFT;
    if (Math.abs(f) > CARRIER_SPAN_HZ) continue;
    const p = Math.max(0, s[k] - q[k]);
    num += p * f; den += p;
  }
  return den > 0 ? num / den : 0;
}

// The 48 kHz channel mixed down by `cfo`, ±7 kHz → the FM discriminator's output, Hz.
function discriminate(bb, cfo) {
  const n = bb.re.length, xr = new Float64Array(n), xi = new Float64Array(n);
  const w = -2 * Math.PI * cfo / FS, cs = Math.cos(w), sn = Math.sin(w);
  let pr = 1, pi = 0;
  for (let k = 0; k < n; k++) {
    const x = bb.re[k], y = bb.im[k];
    xr[k] = x * pr - y * pi; xi[k] = x * pi + y * pr;
    const t = pr * cs - pi * sn; pi = pr * sn + pi * cs; pr = t;
    if ((k & 1023) === 1023) { const g = 1 / Math.hypot(pr, pi); pr *= g; pi *= g; }
  }
  const cr = fir(xr, LPF_CH), ci = fir(xi, LPF_CH), f = new Float64Array(n);
  for (let k = 1; k < n; k++) f[k] = Math.atan2(ci[k] * cr[k - 1] - cr[k] * ci[k - 1], cr[k] * cr[k - 1] + ci[k] * ci[k - 1]) * FS / (2 * Math.PI);
  return f;
}

// ── sync and clock ─────────────────────────────────────────────────────────

const SYNC_PM = Float64Array.from(SYNC, b => (b ? 1 : -1));
const SYNC_SUM = SYNC_PM.reduce((a, v) => a + v, 0);
const SYNC_VAR = SYNC.length - SYNC_SUM * SYNC_SUM / SYNC.length;

// The sync's correlation with y at its 80 bit centres from i, each less their
// mean (the carrier's residue): +1 the sync, −1 the sync upside down.
function syncScore(y, i) {
  let c = 0, s1 = 0, s2 = 0;
  for (let k = 0, j = i; k < SYNC.length; k++, j += SPS) { const v = y[j]; c += v * SYNC_PM[k]; s1 += v; s2 += v * v; }
  const mean = s1 / SYNC.length, e = s2 - s1 * mean;
  return e > 0 ? (c - mean * SYNC_SUM) / Math.sqrt(e * SYNC_VAR) : 0;
}

// The next sync starting in [from, until): the first place it scores
// SYNC_MIN, and the best within a sync's length of that.
function nextSync(y, from, until) {
  const last = y.length - SYNC.length * SPS;
  for (let i = Math.max(0, from); i < Math.min(last, until); i++) {
    if (Math.abs(syncScore(y, i)) < SYNC_MIN) continue;
    let best = { at: i, score: syncScore(y, i) };
    for (let j = i + 1; j < Math.min(last, i + SYNC.length * SPS); j++) {
      const s = syncScore(y, j);
      if (Math.abs(s) > Math.abs(best.score)) best = { at: j, score: s };
    }
    return best;
  }
  return null;
}

// y at fractional sample t (linear), less dc, times sign.
function at(y, t, dc, sign) {
  const i = Math.floor(t);
  if (i < 0 || i + 1 >= y.length) return 0;
  const f = t - i;
  return (y[i] * (1 - f) + y[i + 1] * f - dc) * sign;
}

// One transmitter's bit clock does not wander within a frame: the period
// (within `pr` of p0, in steps of `ps`; first within 1 %, which is more than
// the sync search allows) and phase (within ±`dr` samples) that
// open the eye widest — the most |y| at the sampling instants — over bits
// [0, nbits) from `start`, every other one.
function clockFit(y, start, nbits, dc, p0, pr, ps, d0, dr, dstep) {
  let best = { m: -1, P: p0, d: d0 };
  for (let P = p0 - pr; P <= p0 + pr + 1e-12; P += ps) {
    for (let d = d0 - dr; d <= d0 + dr + 1e-12; d += dstep) {
      let m = 0;
      for (let k = 0; k < nbits; k += 2) m += Math.abs(at(y, start + d + k * P, dc, 1));
      if (m > best.m) best = { m, P, d };
    }
  }
  return best;
}

function sample(y, t0, P, count, dc, sign) {
  const out = new Float64Array(count);
  let s = 0;
  for (let k = 0; k < count; k++) { out[k] = at(y, t0 + k * P, dc, sign); s += Math.abs(out[k]); }
  s = s / Math.max(1, count) || 1;
  for (let k = 0; k < count; k++) out[k] /= s;          // about ±1, for the Viterbi
  return out;
}

// ── the frame ──────────────────────────────────────────────────────────────

// How many coded bits follow the first block for a frame of `len` bytes.
function followOn(len) {
  const D = Math.max(0, len - (FIRST_BYTES - 2));
  if (!D) return { D, blocks: 0, dataBits: 0, coded: 0 };
  const blocks = Math.ceil(D / BLOCK_BYTES), dataBits = 8 * (D + PARITY * blocks);
  return { D, blocks, dataBits, coded: 2 * (dataBits + 7) };
}

// The first block, from its 656 coded bits → { ok, header, fixed, bytes } (bytes descrambled).
function firstBlock(soft) {
  const bits = F.viterbi(soft.subarray(0, FIRST_CODED - 2), true);
  const rs = F.rsDecode(F.toBytes(bits.subarray(0, 8 * (FIRST_BYTES + PARITY))));
  if (!rs.ok) return { ok: false, fixed: rs.errors };
  const b = F.toBytes(F.descramble(F.toBits(rs.data.subarray(0, FIRST_BYTES))));
  const h = (b[0] << 8) | b[1];
  return { ok: true, fixed: rs.errors, bytes: b, version: h >> 14, reserved: (h >> 10) & 15, len: h & 1023 };
}

// The frame's soft bits after the sync → { ok, len, blocks, payload, error }.
function decodeFrame(soft) {
  const out = { ok: false, blocks: [] };
  if (soft.length < FIRST_CODED) return Object.assign(out, { error: 'too short for a first block' });
  const fb = firstBlock(soft);
  out.blocks.push({ bytes: FIRST_BYTES, ok: fb.ok, fixed: fb.fixed });
  if (!fb.ok) return Object.assign(out, { error: 'first block: more errors than its parity corrects' });
  out.len = fb.len;
  if (fb.version !== 0 || fb.reserved !== 0) return Object.assign(out, { error: 'AirLink header version ' + fb.version + ', reserved bits ' + fb.reserved });
  const payload = Array.from(fb.bytes.subarray(2, 2 + Math.min(FIRST_BYTES - 2, fb.len)));
  const fo = followOn(fb.len);
  if (fo.D) {
    const coded = soft.subarray(FIRST_CODED, FIRST_CODED + fo.coded);
    if (coded.length < fo.coded) return Object.assign(out, { error: 'the burst ends before its frame does' });
    const bytes = F.toBytes(F.viterbi(coded, true).subarray(0, fo.dataBits));
    for (let k = 0, p = 0; k < fo.blocks; k++) {
      const n = Math.min(BLOCK_BYTES, fo.D - BLOCK_BYTES * k);
      const rs = F.rsDecode(bytes.subarray(p, p + n + PARITY));
      p += n + PARITY;
      out.blocks.push({ bytes: n, ok: rs.ok, fixed: rs.errors });
      if (!rs.ok) return Object.assign(out, { error: 'block ' + (k + 2) + ' of ' + (fo.blocks + 1) + ': more errors than its parity corrects' });
      payload.push(...F.toBytes(F.descramble(F.toBits(rs.data.subarray(0, n)))));
    }
  }
  out.payload = Uint8Array.from(payload);
  out.ok = true;
  return out;
}

// LEN bytes → the bits after the sync, as a transmitter sends them (for the
// test transmitter and the fake rtl_sdr; the inverse of decodeFrame).
function encodeFrame(payload) {
  const len = payload.length;
  if (len > 1023) throw new Error('an AirLink frame carries at most 1023 bytes');
  const first = new Uint8Array(FIRST_BYTES).fill(0x55);
  first[0] = (len >> 8) & 3; first[1] = len & 255;
  first.set(payload.subarray(0, FIRST_BYTES - 2), 2);
  const block = (data) => { const s = F.toBytes(F.scramble(F.toBits(data))); return [...s, ...F.rsEncode(s)]; };
  const tail = (bits) => Uint8Array.from([...bits, 0, 0, 0, 0, 0, 0, 0]);
  const head = F.convEncode(tail(F.toBits(Uint8Array.from(block(first)))));
  const fo = followOn(len), rest = [];
  for (let k = 0; k < fo.blocks; k++) {
    const from = FIRST_BYTES - 2 + BLOCK_BYTES * k;
    rest.push(...block(payload.subarray(from, Math.min(len, from + BLOCK_BYTES))));
  }
  const coded = fo.blocks ? F.convEncode(tail(F.toBits(Uint8Array.from(rest)))) : new Uint8Array(0);
  return Uint8Array.from([...head, 0, 0, ...coded]);
}

// ── MANT and the application layer ─────────────────────────────────────────

const u16 = (v, i) => (v[i] << 8) | v[i + 1];

// The MANT PDUs in a frame's payload, one after another (MANT 1.2; MegaNet's
// alert2.js reads the same header off an ERT-A2): header, the optional fields
// it calls for, the application payload.
function mantPdus(b) {
  const pdus = [];
  let p0 = 0;
  while (p0 + 6 <= b.length) {
    const v = b.subarray(p0);
    const h = {
      version: v[0] >> 6, protoId: (v[0] >> 3) & 7, tsReq: (v[0] >> 2) & 1, pathReq: (v[0] >> 1) & 1, destInHdr: v[0] & 1,
      port: v[1] >> 4, ack: v[1] & 1, addedHdr: v[2] >> 7, hopLimit: (v[2] >> 4) & 7,
      payLen: ((v[2] & 0x0f) << 8) | v[3], source: u16(v, 4),
    };
    let p = 6;
    if (h.destInHdr) { h.dest = u16(v, p); p += 2; }
    if (h.protoId === 1) { h.pduId = v[p]; p += 1; }
    if (h.pathReq) { const n = v[p]; p += 1; h.path = []; for (let k = 0; k < n; k++, p += 2) h.path.push(u16(v, p)); }
    if (p + h.payLen > v.length) { h.error = 'runs past the end of the frame'; pdus.push(h); break; }
    h.bytes = v.subarray(0, p + h.payLen);
    h.app = appPayload(h.port, v.subarray(p, p + h.payLen));
    pdus.push(h);
    p0 += p + h.payLen;
  }
  return pdus;
}

// An application payload (ALERT2 Application Layer): its control byte, the
// time stamp it may carry (seconds since 00:00 or 12:00 UTC), then — on port
// 1, ALERT concentration — 4-byte records.
function appPayload(port, b) {
  if (!b.length) return null;
  const c = b[0];
  const app = { version: c & 3, stamped: !!(c & 4), test: !!(c & 8), apdu: (c >> 4) & 7, stamp: null, records: [] };
  let p = c & 0x80 ? 2 : 1;
  if (app.stamped) { app.stamp = u16(b, p); p += 2; }
  if (port === 1) {
    for (; p + 4 <= b.length; p += 4) {
      app.records.push({ alertId: ((b[p + 1] & 0x1f) << 8) | b[p], value: ((b[p + 1] >> 5) << 8) | b[p + 2], before: b[p + 3],
        bytes: b.subarray(p, p + 4) });
    }
    if (p !== b.length) app.leftover = b.length - p;
  }
  return app;
}

// ── a window ───────────────────────────────────────────────────────────────

// re, im: a window of the channel at 240 ksps (any scale); opts.syncFrom and
// syncTo (s), where in it a frame may start — the gated burst's own stretch,
// for the next station's slot may begin in the window's margin after it (and
// is read in its own burst's window). Without them, where the power is.
// → { frames, ms }.
// Each frame: { at (s into the window), cfoHz, inverted, sync, syncErrs, baud,
// ok, len, blocks, error, payload, pdus }. Only frames whose sync was clearly
// there are listed, decoded or not.
function receive(re, im, opts) {
  const t0 = Date.now(), o = opts || {};
  const res = { frames: [], ms: 0, cfoHz: null };
  if (re.length < 0.2 * FS_IN) { res.ms = Date.now() - t0; return res; }
  const bb = decimate(re, im);
  const span = burstSpan(bb);
  const cfo = span ? carrier(bb, span) : 0;
  res.cfoHz = Math.round(cfo);
  const y = fir(discriminate(bb, cfo), MATCHED);
  const maxFrames = o.maxFrames || 8;
  // A sync starts a burst: look from a little before the first hot block to the last.
  let next = span ? Math.max(0, span.first - Math.round(0.15 * FS)) : 0;
  let until = span ? span.last : y.length;
  if (o.syncFrom != null && o.syncTo != null) { next = Math.max(0, Math.round(o.syncFrom * FS)); until = Math.round(o.syncTo * FS); }
  while (res.frames.length < maxFrames) {
    const s = nextSync(y, next, until);
    if (!s) break;
    const fr = frameAt(y, s);
    if (!fr) { next = s.at + SYNC.length * SPS / 2; continue; }
    fr.at = Math.round(fr.start / FS * 1000) / 1000;
    fr.cfoHz = Math.round(cfo + fr.dc / MATCHED_DC);
    res.frames.push(fr);
    next = Math.ceil(fr.end);
  }
  res.ms = Date.now() - t0;
  return res;
}

// A sync at s → the frame there, or null if it was not a sync after all.
function frameAt(y, s) {
  const sign = s.score < 0 ? -1 : 1;
  // The carrier's residue: the mean over the first block (scrambled, so balanced).
  const a = s.at + SYNC.length * SPS, b = Math.min(y.length, a + Math.round(0.13 * FS));
  let dc = 0;
  for (let i = a; i < b; i++) dc += y[i];
  dc /= Math.max(1, b - a);
  // The clock over the sync and first block (every frame has them).
  let ck = clockFit(y, s.at, HEAD_BITS, dc, SPS, SPS * 0.01, SPS * 0.0005, 0, SPS / 2, 0.5);
  let soft = sample(y, s.at + ck.d, ck.P, HEAD_BITS, dc, sign);
  let syncErrs = 0;
  for (let k = 0; k < SYNC.length; k++) if ((soft[k] > 0 ? 1 : 0) !== SYNC[k]) syncErrs++;
  if (syncErrs > SYNC_ERRS) return null;
  const fr = { start: s.at, sign, dc, inverted: sign < 0, sync: Math.round(Math.abs(s.score) * 1000) / 1000, syncErrs };
  const fb = firstBlock(soft.subarray(SYNC.length));
  let total = HEAD_BITS;
  if (fb.ok && fb.version === 0 && fb.reserved === 0) {
    total = HEAD_BITS + followOn(fb.len).coded + 2;
    if (total > HEAD_BITS + 2) {
      // Over the whole frame now, finely: a clock off by 0.05 % slips a bit in 2000.
      const avail = Math.floor((y.length - s.at - ck.d) / ck.P) - 1;
      const n = Math.min(total, avail);
      ck = clockFit(y, s.at, n, dc, ck.P, SPS * 0.0006, SPS * 0.00002, ck.d, 1, 0.25);
      soft = sample(y, s.at + ck.d, ck.P, n, dc, sign);
    }
  }
  const d = decodeFrame(soft.subarray(SYNC.length));
  Object.assign(fr, { baud: Math.round(FS / ck.P * 10) / 10, ok: d.ok, len: d.len, blocks: d.blocks, error: d.error || null,
    end: s.at + ck.d + total * ck.P });
  if (d.ok) { fr.payload = d.payload; fr.pdus = mantPdus(d.payload); }
  return fr;
}

const hex = (b) => Buffer.from(b.buffer, b.byteOffset, b.length).toString('hex').toUpperCase();

// receive()'s result as plain data, for postMessage (bytes as hex): a typed
// array's view would carry its whole frame's buffer, once for each view.
function plain(res) {
  return {
    ms: res.ms, cfoHz: res.cfoHz,
    frames: res.frames.map(f => ({
      at: f.at, cfoHz: f.cfoHz, inverted: f.inverted, sync: f.sync, syncErrs: f.syncErrs, baud: f.baud, ok: f.ok, len: f.len,
      error: f.error, blocks: f.blocks.length, fixed: f.blocks.reduce((a, b) => a + (b.fixed || 0), 0),
      pdus: (f.pdus || []).map(p => ({
        source: p.source, port: p.port, path: p.path || [], hopLimit: p.hopLimit, dest: p.dest, pduId: p.pduId, error: p.error || null,
        hex: p.bytes ? hex(p.bytes) : null,
        app: p.app ? { stamp: p.app.stamp, test: p.app.test, apdu: p.app.apdu, leftover: p.app.leftover || 0,
          records: p.app.records.map(r => ({ id: r.alertId, value: r.value, before: r.before, hex: hex(r.bytes) })) } : null,
      })),
    })),
  };
}

module.exports = {
  receive, plain, decodeFrame, encodeFrame, mantPdus, appPayload, followOn,
  FS_IN, FS, BAUD, SPS, SYNC, FIRST_CODED, rrc,
};
