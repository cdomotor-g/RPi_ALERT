'use strict';
// The chirps. A speaker on the Pi's audio jack (or HDMI, or a USB sound card)
// plays every ALERT burst the base station hears:
//
//   live    an RTL-SDR's own FM-demodulated audio, only while its squelch is
//           open (plus a little either side) — the real burst, as a scanner
//           would play it.
//   synth   a burst re-synthesised from the decoded reading: the 300-baud AFSK
//           (1300.8 / 2109.4 Hz) an ALERT station transmits for that address
//           and value, with its preamble. For receivers that hand over only
//           the decode (a Quansheng radio, an ERT-A2), it is the next best
//           thing to the real sound. ALERT2 readings get a short fast-FSK
//           burst instead (ALERT2 is not AFSK, so this one is only indicative).
//   beep    a short tone per reading.
//   auto    live for SDRs, synth for everything else.
//
// Clips play one after another through aplay (alsa-utils), so two receivers
// never fight over the sound card; ALSA's plug layer resamples each to what
// the card wants.

const { spawn } = require('node:child_process');

const RATE = 24000;
const MARK = 1300.8, SPACE = 2109.4, BAUD = 300;
const MAX_QUEUE = 8;

// One ALERT frame's air bits, as alert-dsp.js's synthesiser lays them out:
// preamble, then each byte as start + 8 data bits (LSB first) + stop. NEG
// polarity (idle low, start 1) is what Australian ALERT hardware sends.
function airBits(frames, neg, leadSec, tailSec) {
  const bits = [];
  const lead = Math.round(leadSec * BAUD);
  for (let i = 0; i < lead; i++) bits.push(neg ? 0 : 1);
  for (const w of frames) {
    for (const b of w) {
      bits.push(neg ? 1 : 0);
      for (let j = 0; j < 8; j++) { const v = (b >> j) & 1; bits.push(neg ? 1 - v : v); }
      bits.push(neg ? 0 : 1);
    }
  }
  const tail = Math.round(tailSec * BAUD);
  for (let i = 0; i < tail; i++) bits.push(neg ? 0 : 1);
  return bits;
}

function fsk(bits, baud, f1, f0, amp) {
  const n = Math.round(bits.length * RATE / baud);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const bit = bits[Math.min(bits.length - 1, Math.floor(i * baud / RATE))];
    ph += 2 * Math.PI * (bit ? f1 : f0) / RATE;
    out[i] = amp * Math.sin(ph);
  }
  return fade(out, RATE);
}

function fade(x, rate) {
  const n = Math.min(x.length >> 1, Math.round(rate * 0.006));
  for (let i = 0; i < n; i++) { const g = i / n; x[i] *= g; x[x.length - 1 - i] *= g; }
  return x;
}

function silence(sec) { return new Float32Array(Math.round(sec * RATE)); }
function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ALERT Binary bytes for an address and value (alert-dsp.js encodeFrame, BINARY).
function binaryFrame(id, value) {
  return [(id & 63) | 0x40, ((id >> 6) & 63) | 0x40, ((id >> 12) & 1) | ((value & 31) << 1) | 0xc0, ((value >> 5) & 63) | 0xc0];
}

function alertBurst(readings) {
  const frames = readings.slice(0, 6).map(r => binaryFrame(r.alert_id & 8191, r.value_raw & 2047));
  return fsk(airBits(frames, true, 0.28, 0.06), BAUD, MARK, SPACE, 0.55);
}

function alert2Burst(readings) {
  // A short burst of 4800-baud two-tone FSK over the records' bytes, preceded
  // by a 50 ms sync tone: the buzz an ALERT2 transmission makes, not its waveform.
  const bytes = [];
  for (const r of readings.slice(0, 8)) bytes.push(r.alert_id & 0xff, ((r.alert_id >> 8) & 0x1f) | ((r.value_raw >> 8) << 5), r.value_raw & 0xff, 0);
  const bits = [];
  for (let i = 0; i < 240; i++) bits.push(i & 1);
  for (let k = 0; k < 6; k++) for (const b of bytes) for (let j = 0; j < 8; j++) bits.push((b >> j) & 1);
  return fsk(bits, 4800, 2400, 1200, 0.45);
}

function beep() {
  const n = Math.round(0.12 * RATE), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.4 * Math.sin(2 * Math.PI * 1000 * i / RATE);
  return fade(out, RATE);
}

function toS16(f32, gain) {
  const b = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(f32[i] * gain * 32767))), i * 2);
  return b;
}

class Audio {
  constructor(opts) {
    this.log = opts.log;
    this.getCfg = opts.getCfg;     // () => config.audio
    this.queue = [];
    this.playing = null;
    this.broken = 0;
    this.lastErr = '';
    this.played = 0;
    this.pendingGroups = new Map();
  }

  mode() { const c = this.getCfg(); return c.enabled ? c.mode : 'off'; }

  // A reading from any receiver. Readings that arrive together (one burst
  // carrying several frames) become one clip.
  reading(r, fromSdr) {
    const mode = this.mode();
    if (mode === 'off') return;
    if (fromSdr && (mode === 'auto' || mode === 'live')) return;   // its live audio already plays
    if (!fromSdr && mode === 'live') return;
    const key = (r.receiverKey || '') + '|' + (r.burstKey || Math.floor(Date.now() / 400));
    let g = this.pendingGroups.get(key);
    if (!g) {
      g = { list: [], protocol: r.protocol };
      this.pendingGroups.set(key, g);
      setTimeout(() => {
        this.pendingGroups.delete(key);
        if (mode === 'beep') this.play(beep(), RATE, 'beep');
        else this.play(g.protocol === 'alert2' ? alert2Burst(g.list) : alertBurst(g.list), RATE, g.protocol);
      }, 350);
    }
    g.list.push(r);
  }

  // A burst of an SDR's own audio (Float32 at `rate`), already gated.
  live(pcm, rate) {
    const mode = this.mode();
    if (mode !== 'auto' && mode !== 'live') return;
    this.play(fade(Float32Array.from(pcm), rate), rate, 'live');
  }

  test(kind) {
    if (kind === 'alert2') return this.play(alert2Burst([{ alert_id: 6129, value_raw: 1599 }]), RATE, 'test', true);
    if (kind === 'beep') return this.play(beep(), RATE, 'test', true);
    return this.play(alertBurst([{ alert_id: 2088, value_raw: 143 }, { alert_id: 2089, value_raw: 12 }]), RATE, 'test', true);
  }

  play(f32, rate, why, force) {
    if (!force && this.broken && Date.now() - this.broken < 60000) return;
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push({ f32, rate, why });
    this.next();
  }

  next() {
    if (this.playing || !this.queue.length) return;
    const clip = this.queue.shift();
    const cfg = this.getCfg();
    const gain = Math.max(0, Math.min(100, cfg.volume)) / 100;
    const args = ['-q', '-D', cfg.device || 'default', '-t', 'raw', '-f', 'S16_LE', '-r', String(Math.round(clip.rate)), '-c', '1'];
    let p;
    try { p = spawn('aplay', args, { stdio: ['pipe', 'ignore', 'pipe'] }); } catch (e) { this.fail(e.message); return; }
    this.playing = p;
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { err += e.message; });
    p.on('close', (code) => {
      this.playing = null;
      if (code) this.fail(err.trim() || 'aplay exited ' + code); else { this.played++; this.broken = 0; this.lastErr = ''; }
      setImmediate(() => this.next());
    });
    p.stdin.on('error', () => {});
    p.stdin.end(toS16(clip.f32, gain));
  }

  fail(msg) {
    if (msg !== this.lastErr) this.log.warn('audio: ' + msg + ' (check the speaker, or Settings → Audio → output)');
    this.lastErr = msg;
    this.broken = Date.now();
  }

  status() { return { mode: this.mode(), device: this.getCfg().device, played: this.played, error: this.lastErr || null, queued: this.queue.length }; }
}

module.exports = { Audio, airBits, alertBurst, alert2Burst, binaryFrame, toS16, RATE };
