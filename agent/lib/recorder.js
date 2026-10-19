'use strict';
// Recordings: the IQ of every burst heard on chosen channels, kept on the SD
// card — to see what is on a channel nothing here decodes yet (ALERT2, another
// format, something else entirely), and to build the decoder that will.
//
// receivers.record: { freqHz: [151537500, …], maxMb: 256 }. Each burst the
// squelch opens on, on a channel of one of those frequencies (on any stick),
// is two files in <data>/recordings:
//
//   20261019-004644-082_151.5375_sdr2.iq8    the channel's own 240 ksps, u8 I then Q, centred on it:
//                                            the burst and 0.4 s either side, as the decoder read it
//   20261019-004644-082_151.5375_sdr2.json   what it was: the frequency, the stick and its tuning, the
//                                            burst's level and length, what (if anything) it decoded as
//
// An .iq8 is what MegaNet's SDR card captures and agent/test/fixtures holds, so
// the website and the tests read one as it is. It is the decoder's own samples
// (floats) scaled so the loudest fills most of a byte — `scale` in the .json:
// the pipeline's own u8 capture is not scaled, and a channel heard at -60 dBFS
// is a tenth of a step there, every byte 127 or 128. The newest are kept, maxMb of
// them in all; with under 512 MB of the card free none is written. The web
// page lists and downloads them (/api/recordings), and MegaNet's Base Stations
// tab can fetch them a piece at a time (lib/remote.js: recordings, recording.get).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const pkg = require('../package.json');
const { mhz } = require('../web/channels');

const MB = 1048576;
const MIN_FREE_MB = 512;
const LOW_WARN_MS = 3600 * 1000;
// A recording's name: when its squelch opened (UTC, to the ms), the channel, the stick.
const NAME = /^\d{8}-\d{6}-\d{3}_\d+\.\d+_sdr\d+(?:-\d+)?$/;
const FILE = /^(\d{8}-\d{6}-\d{3}_\d+\.\d+_sdr\d+(?:-\d+)?)\.(iq8|json)$/;
const MAX_CHUNK = 43000;    // base64 of this, and its envelope, fits one check-in's answer (60 KB)

class Recorder {
  constructor(agent) {
    this.agent = agent;
    this.dir = path.join(agent.dataDir, 'recordings');
    this.log = agent.log.child('record');
    this.files = [];        // oldest first: { name, bytes, brief }
    this.counts = { saved: 0, skipped: 0 };
    this.lowAt = 0;
    agent.config.on('change', (changed) => { if (changed.some(p => p.startsWith('receivers.record.'))) this.prune(); });
  }

  load() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (_) {}
    const by = new Map();
    for (const n of names) {
      const m = FILE.exec(n);
      if (!m) continue;
      let st;
      try { st = fs.statSync(path.join(this.dir, n)); } catch (_) { continue; }
      const f = by.get(m[1]) || { name: m[1], bytes: 0, brief: null };
      f.bytes += st.size;
      if (m[2] === 'json') { try { f.brief = brief(JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'))); } catch (_) {} }
      by.set(m[1], f);
    }
    this.files = [...by.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return this;
  }

  cfg() { return this.agent.config.get().receivers.record; }
  wants(freqHz) { return this.cfg().freqHz.some(f => Math.round(f) === Math.round(freqHz)); }
  bytes() { return this.files.reduce((a, f) => a + f.bytes, 0); }

  // A burst from a channel's decoder (sdr-worker.js, 'recording').
  save(ch, m) {
    if (!ch.spec || !this.wants(ch.spec.freqHz)) return;    // turned off since the decoder was told
    const free = freeMb(this.agent.dataDir);
    if (free != null && free < MIN_FREE_MB) {
      this.counts.skipped++;
      if (Date.now() - this.lowAt > LOW_WARN_MS) { this.lowAt = Date.now(); this.log.warn('not recording: under ' + MIN_FREE_MB + ' MB of the SD card is free'); }
      return;
    }
    const t = (m.burst && m.burst.t) || Date.now();
    const name = this.unique(stamp(t) + '_' + mhz(ch.spec.freqHz) + '_sdr' + ch.stick.point.n);
    const st = ch.stick, c = st.cfg();
    const meta = {
      file: name + '.iq8',
      what: 'u8 IQ, I then Q, ' + m.rate + ' samples a second, centred on the channel (127.5 is zero): the burst and 0.4 s either side, as the decoder read it,'
        + ' times scale (u8 = sample × scale + 127.5, a sample being in steps of the stick\'s own 8 bits)',
      rate: m.rate, samples: m.buf.byteLength >> 1, seconds: Math.round(m.seconds * 1000) / 1000, scale: m.scale != null ? Math.round(m.scale * 1000) / 1000 : 1,
      burstAt: new Date(t).toISOString(),
      freqHz: ch.spec.freqHz,
      burst: m.burst ? { ms: m.burst.ms, peakDb: r1(m.burst.peakDb), nfDb: r1(m.burst.nfDb) } : null,
      decodedAs: { format: m.format, readings: m.readings || [], all: m.all || 0, shadows: m.shadows || 0, alert2: m.alert2 || null },
      receiver: { name: ch.name(), key: ch.key, pointId: ch.point.pointId },
      stick: { key: st.key, model: st.model, tuner: st.tuner, serial: st.stick.serial || null, usbPort: st.stick.busPath || null,
        sampleRate: c.sampleRate, centerHz: c.centerHz, offsetHz: ch.spec.offsetHz, gainDb: c.gainDb, ppm: c.ppm || 0 },
      baseStation: this.agent.baseName ? this.agent.baseName() : os.hostname(), version: pkg.version,
    };
    const iq = Buffer.from(m.buf);
    const json = JSON.stringify(meta, null, 2) + '\n';
    const entry = { name, bytes: iq.length + Buffer.byteLength(json), brief: brief(meta), done: false };
    this.files.push(entry);
    // Written off the main thread (libuv's pool): rtl_sdr's samples keep coming meanwhile.
    const done = (e) => {
      entry.done = true;
      if (e) {
        this.counts.skipped++;
        this.files = this.files.filter(f => f !== entry);
        this.remove([name]);
        this.log.warn('could not save a recording: ' + e.message);
        return;
      }
      this.counts.saved++;
      if (this.counts.saved === 1) this.log.info('recording bursts on ' + this.cfg().freqHz.map(f => mhz(f)).join(', ') + ' MHz, in ' + this.dir);
      this.prune();
    };
    fs.mkdir(this.dir, { recursive: true }, (e0) => {
      if (e0) return done(e0);
      fs.writeFile(path.join(this.dir, name + '.iq8'), iq, (e1) => {
        if (e1) return done(e1);
        fs.writeFile(path.join(this.dir, name + '.json'), json, done);
      });
    });
  }

  unique(base) {
    const taken = new Set(this.files.map(f => f.name));
    let name = base;
    for (let n = 2; taken.has(name); n++) name = base + '-' + n;
    return name;
  }

  // The newest kept, maxMb in all (never one still being written).
  prune() {
    const cap = this.cfg().maxMb * MB;
    let total = this.bytes();
    while (this.files.length > 1 && total > cap && this.files[0].done !== false) {
      const f = this.files.shift();
      this.remove([f.name], true);
      total -= f.bytes;
    }
  }

  // names: recordings, as list() names them. → how many there were.
  remove(names, already) {
    let n = 0;
    for (const name of names) {
      if (!NAME.test(String(name))) continue;
      for (const ext of ['.iq8', '.json']) { try { fs.unlinkSync(path.join(this.dir, name + ext)); } catch (_) {} }
      if (!already) { const before = this.files.length; this.files = this.files.filter(f => f.name !== name); n += before - this.files.length; } else n++;
    }
    return n;
  }

  clear() { return this.remove(this.files.map(f => f.name)); }

  // Newest first.
  list(limit) {
    return this.files.slice(-(limit || 500)).reverse().map(f => Object.assign({ name: f.name, bytes: f.bytes }, f.brief || {}));
  }

  // One recording's file, whole, for a download: { path, type } or null.
  file(fileName) {
    const m = FILE.exec(String(fileName || ''));
    if (!m || !this.files.some(f => f.name === m[1])) return null;
    return { path: path.join(this.dir, fileName), type: m[2] === 'json' ? 'application/json' : 'application/octet-stream' };
  }

  // A piece of one, for MegaNet (a check-in's answer is at most 60 KB):
  // { file, size, offset, length, b64 }.
  chunk(fileName, offset, length) {
    const f = this.file(fileName);
    if (!f) throw new Error('no recording ' + String(fileName).slice(0, 80));
    const size = fs.statSync(f.path).size;
    const at = Math.max(0, Math.min(size, Math.floor(Number(offset) || 0)));
    const len = Math.max(0, Math.min(MAX_CHUNK, size - at, Math.floor(Number(length) || MAX_CHUNK)));
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(f.path, 'r');
    try { fs.readSync(fd, buf, 0, len, at); } finally { fs.closeSync(fd); }
    return { file: fileName, size, offset: at, length: len, b64: buf.toString('base64') };
  }

  status() {
    const c = this.cfg();
    return { freqHz: c.freqHz.slice(), maxMb: c.maxMb, files: this.files.length, mb: Math.round(this.bytes() / MB * 10) / 10,
      saved: this.counts.saved, skipped: this.counts.skipped, dir: this.dir };
  }
}

// What the list shows of one, from its .json.
function brief(meta) {
  if (!meta) return null;
  const d = meta.decodedAs || {};
  return { t: meta.burstAt ? Date.parse(meta.burstAt) : null, freqHz: meta.freqHz, receiver: meta.receiver && meta.receiver.name,
    ms: meta.burst && meta.burst.ms, peakDb: meta.burst && meta.burst.peakDb, seconds: meta.seconds, decoded: (d.readings || []).length,
    alert2: (d.alert2 || []).filter(f => f.ok).length };
}

// The last n samples of a ring of complex floats (the pipeline's ringR/ringI,
// `total` written so far) as u8 IQ, scaled so the loudest sample is PEAK from
// the middle — up for a weak channel, down for one that would clip: { buf, scale }.
const PEAK = 120;
function toU8(re, im, total, n) {
  const CAP = re.length, start = total - n;
  let peak = 0;
  for (let k = 0; k < n; k++) {
    const p = (start + k) % CAP;
    const a = Math.abs(re[p]), b = Math.abs(im[p]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const scale = peak > 0 ? PEAK / peak : 1;
  const out = new Uint8Array(n * 2);
  for (let k = 0; k < n; k++) {
    const p = (start + k) % CAP;
    out[2 * k] = Math.max(0, Math.min(255, Math.round(re[p] * scale + 127.5)));
    out[2 * k + 1] = Math.max(0, Math.min(255, Math.round(im[p] * scale + 127.5)));
  }
  return { buf: out.buffer, scale };
}

function stamp(t) {
  const s = new Date(t).toISOString();             // 2026-10-19T00:46:44.082Z
  return s.slice(0, 10).replace(/-/g, '') + '-' + s.slice(11, 19).replace(/:/g, '') + '-' + s.slice(20, 23);
}

function freeMb(dir) {
  try { const s = fs.statfsSync(dir); return Math.round(s.bavail * s.bsize / MB); } catch (_) { return null; }
}

function r1(v) { return v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10; }

module.exports = { Recorder, toU8, stamp, NAME, FILE, MAX_CHUNK };
