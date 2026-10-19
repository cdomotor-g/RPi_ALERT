'use strict';
// ALERT2 AirLink's forward error correction (NHWC AirLink Layer 1.1): what
// lib/devices/alert2-air.js undoes off the air, and the test transmitter
// (test/helpers/alert2-tx.js) does.
//
//   scrambler        x^17 + x^3 + 1, self-synchronising, preloaded with 1 and
//                    started afresh for each block
//   Reed–Solomon     over GF(256) of x^8+x^7+x^2+x+1 (0x187), 16 parity bytes a
//                    block (8 errors corrected), roots α^(11·(112+i)) — CCSDS's
//                    code, but in the conventional basis, not its dual
//   convolutional    rate ½, k = 7, polynomials 0x6d then 0x4f, the newest bit
//                    in the shift register's lowest place, neither output
//                    inverted; decoded by a soft-decision Viterbi
//
// None of these numbers is a guess: each was found on frames heard off the air
// at 18 Bateson on 151.5375 MHz (every block's parity checked, and the ALERT
// ids in them are the network's own sensors).

const POLYS = [0x6d, 0x4f];
const RS = { nroots: 16, fcr: 112, prim: 11, poly: 0x187 };

const parity = (x) => { x ^= x >> 4; x ^= x >> 2; x ^= x >> 1; return x & 1; };

// ── convolutional code ─────────────────────────────────────────────────────

// bits → two coded bits each (with the 6 zeros that bring it back to state 0
// appended by the caller: they are part of the frame).
function convEncode(bits) {
  const out = new Uint8Array(bits.length * 2);
  let sr = 0;
  for (let i = 0; i < bits.length; i++) {
    sr = ((sr << 1) | bits[i]) & 0x7f;
    out[2 * i] = parity(sr & POLYS[0]);
    out[2 * i + 1] = parity(sr & POLYS[1]);
  }
  return out;
}

// Each coded bit (as a ±1) for each 7-bit register: what the trellis compares against.
const EXPECT0 = new Float64Array(128), EXPECT1 = new Float64Array(128);
for (let st = 0; st < 128; st++) { EXPECT0[st] = parity(st & POLYS[0]) ? 1 : -1; EXPECT1[st] = parity(st & POLYS[1]) ? 1 : -1; }

// soft: two values a bit, positive for a 1, scaled about ±1. From state 0, and
// back to it when `terminated` (the encoder was flushed with zeros). → bits.
function viterbi(soft, terminated) {
  const S = 64, n = soft.length >> 1;
  let pm = new Float64Array(S).fill(-Infinity), nm = new Float64Array(S);
  pm[0] = 0;
  const from = new Uint8Array(n * S);      // the state each was reached from, its low bit the decoded one's predecessor
  const dec = new Uint8Array(n * S);
  for (let i = 0; i < n; i++) {
    const a = soft[2 * i], b = soft[2 * i + 1];
    nm.fill(-Infinity);
    for (let s = 0; s < S; s++) {
      const p = pm[s];
      if (p === -Infinity) continue;
      for (let bit = 0; bit < 2; bit++) {
        const full = ((s << 1) | bit) & 0x7f, ns = full & 0x3f;
        const m = p + a * EXPECT0[full] + b * EXPECT1[full];
        if (m > nm[ns]) { nm[ns] = m; from[i * S + ns] = s; dec[i * S + ns] = bit; }
      }
    }
    const t = pm; pm = nm; nm = t;
  }
  let s = 0;
  if (!terminated) for (let k = 1; k < S; k++) if (pm[k] > pm[s]) s = k;
  const bits = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) { bits[i] = dec[i * S + s]; s = from[i * S + s]; }
  return bits;
}

// ── GF(256) and Reed–Solomon ───────────────────────────────────────────────

const EXP = new Uint8Array(512), LOG = new Int16Array(256).fill(-1);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= RS.poly; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const inv = (a) => EXP[(255 - LOG[a]) % 255];
const pow = (a, e) => (a ? EXP[(((LOG[a] * e) % 255) + 255) % 255] : 0);
// β = α^prim: the code's roots are β^(fcr+i), and position `deg` its X = β^deg.
const beta = (e) => EXP[(((RS.prim * e) % 255) + 255) % 255];

// The generator, highest degree first: Π (x − β^(fcr+i)).
const GEN = (() => {
  let g = [1];
  for (let i = 0; i < RS.nroots; i++) {
    const r = beta(RS.fcr + i), out = new Array(g.length + 1).fill(0);
    for (let k = 0; k < g.length; k++) { out[k] ^= g[k]; out[k + 1] ^= mul(g[k], r); }
    g = out;
  }
  return g;
})();

// data (≤ 239 bytes) → its 16 parity bytes: the block on the air is data then parity.
function rsEncode(data) {
  const n = RS.nroots, par = new Uint8Array(n);
  for (const d of data) {
    const fb = d ^ par[0];
    for (let k = 0; k < n - 1; k++) par[k] = par[k + 1] ^ mul(fb, GEN[k + 1]);
    par[n - 1] = mul(fb, GEN[n]);
  }
  return par;
}

function syndromes(code) {
  const s = new Uint8Array(RS.nroots);
  for (let i = 0; i < RS.nroots; i++) {
    const root = beta(RS.fcr + i);
    let acc = 0;
    for (const c of code) acc = mul(acc, root) ^ c;
    s[i] = acc;
  }
  return s;
}

// A block (data then parity, the first byte the highest degree of a code
// shortened from 255) → { ok, data: the corrected block, errors }. Errors only:
// Berlekamp–Massey for the locator, a Chien search over the block's own
// positions, Forney for the values; checked again after correcting.
function rsDecode(block) {
  const n = block.length, c = Uint8Array.from(block), nroots = RS.nroots;
  const S = syndromes(c);
  if (S.every(v => v === 0)) return { ok: true, data: c, errors: 0 };
  let L = 0, C = [1], B = [1], b = 1, m = 1;
  for (let r = 0; r < nroots; r++) {
    let d = S[r];
    for (let i = 1; i <= L; i++) d ^= mul(C[i] || 0, S[r - i]);
    if (d === 0) { m++; continue; }
    const coef = mul(d, inv(b)), T = C.slice();
    while (C.length < B.length + m) C.push(0);
    for (let i = 0; i < B.length; i++) C[i + m] ^= mul(coef, B[i]);
    if (2 * L <= r) { L = r + 1 - L; B = T; b = d; m = 1; } else m++;
  }
  if (L === 0 || L > nroots / 2) return { ok: false, errors: L };
  const at = [];
  for (let j = 0; j < n; j++) {
    const xinv = inv(beta(n - 1 - j));
    let v = 0, p = 1;
    for (let i = 0; i < C.length; i++) { v ^= mul(C[i], p); p = mul(p, xinv); }
    if (v === 0) at.push(j);
  }
  if (at.length !== L) return { ok: false, errors: L };
  // Ω(x) = S(x)Λ(x) mod x^nroots; e = X^(1−fcr) Ω(X⁻¹) / Λ'(X⁻¹)
  const Om = new Uint8Array(nroots);
  for (let i = 0; i < nroots; i++) for (let k = 0; k <= i && k < C.length; k++) Om[i] ^= mul(C[k], S[i - k]);
  for (const j of at) {
    const X = beta(n - 1 - j), Xinv = inv(X);
    let om = 0, p = 1;
    for (let i = 0; i < nroots; i++) { om ^= mul(Om[i], p); p = mul(p, Xinv); }
    let lp = 0;
    for (let i = 1; i < C.length; i += 2) lp ^= mul(C[i], pow(Xinv, i - 1));
    if (lp === 0) return { ok: false, errors: L };
    c[j] ^= mul(mul(om, pow(X, 1 - RS.fcr)), inv(lp));
  }
  return syndromes(c).every(v => v === 0) ? { ok: true, data: c, errors: L } : { ok: false, errors: L };
}

// ── the scrambler ──────────────────────────────────────────────────────────

// out = in ⊕ s[3] ⊕ s[17], s the scrambled bits before it (s[1] the newest),
// which start as s[1] = 1 and the rest 0. Self-synchronising: the descrambler
// needs only the 17 bits it has just seen, so a bit error stays three errors.
function scramble(bits) {
  const out = new Uint8Array(bits.length);
  let reg = 1;
  for (let i = 0; i < bits.length; i++) {
    const y = bits[i] ^ ((reg >> 2) & 1) ^ ((reg >> 16) & 1);
    out[i] = y;
    reg = ((reg << 1) | y) & 0x1ffff;
  }
  return out;
}
function descramble(bits) {
  const out = new Uint8Array(bits.length);
  let reg = 1;
  for (let i = 0; i < bits.length; i++) {
    const y = bits[i];
    out[i] = y ^ ((reg >> 2) & 1) ^ ((reg >> 16) & 1);
    reg = ((reg << 1) | y) & 0x1ffff;
  }
  return out;
}

// Bytes ↔ bits, the most significant bit first (as they go on the air).
function toBits(bytes) {
  const out = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) for (let k = 0; k < 8; k++) out[8 * i + k] = (bytes[i] >> (7 - k)) & 1;
  return out;
}
function toBytes(bits) {
  const out = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < out.length; i++) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | bits[8 * i + k]; out[i] = v; }
  return out;
}

module.exports = { POLYS, RS, convEncode, viterbi, rsEncode, rsDecode, syndromes, scramble, descramble, toBits, toBytes };
