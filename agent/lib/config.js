'use strict';
// The agent's settings: /etc/rpi-alert/config.json, written only by the agent
// (the web page, the CLI and the boot-partition import all go through here).
//
// The file holds the ingest token, so it is 0600 and owned by the agent's own
// user. Nothing that reads settings for display gets the token back: redact()
// replaces it with its first and last few characters.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { MAX_CHANNELS, MAX_SPAN_HZ } = require('./devices/sdr-plan');
const { mhz } = require('../web/channels');

const CONFIG_PATH = process.env.RPI_ALERT_CONFIG || '/etc/rpi-alert/config.json';

// MegaNet's public project (docs/ingest-http.md in cdomotor-g/MegaNet). The
// publishable key is not a secret: it names the project and can do nothing on
// its own. The ingest token is the secret. floodwarning.net's /api/db route is
// tried first because some networks (the Bureau's among them) block the
// Supabase hostname; the direct URL is the fallback.
const MEGANET_ENDPOINTS = [
  'https://floodwarning.net/api/db/rest/v1',
  'https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1',
];
const MEGANET_APIKEY = 'sb_publishable_PV9VjCM8NQeGAJMuwa5TKA_yX9GWacY';

const SDR_FORMATS = ['BINARY', 'ENHANCED_IFLOWS', 'ASCII'];
const FORMAT_NAMES = { BINARY: 'ALERT Binary', ENHANCED_IFLOWS: 'Enhanced iFLOWS', ASCII: 'ALERT ASCII' };
// What one stick can set for itself (receivers.sdrDevices[]), besides its name.
const STICK_FIELDS = ['enabled', 'freqHz', 'format', 'moreChannels', 'gainDb', 'ppm', 'biasTee', 'squelchDb'];
const PORT_TYPES = ['auto', 'quansheng', 'ert-a2', 'gps', 'ignore'];
const AUDIO_MODES = ['auto', 'live', 'synth', 'beep', 'off'];
const KIOSK_MODES = ['auto', 'on', 'off'];
const LOC_SOURCES = ['none', 'manual', 'station', 'gps'];
const REMOTE_MODES = ['manage', 'report', 'off'];
const HOTSPOT_MODES = ['auto', 'on', 'off'];
const HOTSPOT_SSID = /^[A-Za-z0-9._ -]{1,32}$/, HOTSPOT_PASSWORD = /^[\x21-\x7e]{8,63}$/;

function defaults() {
  return {
    version: 1,
    // What this base station is called in MegaNet. Each receiver on it reports
    // as "<name> — <receiver>". Empty: "RPi ALERT <hostname>".
    name: '',
    meganet: {
      enabled: true,
      token: '',
      endpoints: MEGANET_ENDPOINTS.slice(),
      apikey: MEGANET_APIKEY,
      schema: 'meganet',
      // Also post every frame heard (good or bad) to report_receptions (0047),
      // the raw material of MegaNet's Reception Map.
      receptions: true,
      // How much of the SD card what is waiting to go may take (MB). It is
      // kept on disk, not in memory, so days with no network — a site survey,
      // a long outage — are fine on any Pi; past this (or with under 256 MB
      // of the card free) the oldest is dropped, and counted.
      queueMb: 1024,
      // With no token, ask MegaNet for one by itself (0048) and keep a request
      // open until an administrator approves it — for a Pi nobody will stand
      // at (request_token = yes on the SD card). Turns itself off once a token
      // is approved, or when an administrator turns a request down.
      autoRequest: false,
      // Station names for the dashboard and the "heard" location, refreshed daily.
      stationsUrls: ['https://floodwarning.net/stations.json', 'https://cdomotor-g.github.io/MegaNet/stations.json'],
    },
    // Where the receivers are. A GPS fix, when there is one and useGps is on,
    // wins and is the only location MegaNet records as exact.
    location: { source: 'none', lat: null, lon: null, accuracy_m: null, station: '', stationName: '', useGps: true },
    receivers: {
      autoDetect: true,
      // Per-port overrides, matched against a port's /dev/serial/by-id path,
      // its /dev name, or "vvvv:pppp" USB ids:
      //   { match, type: auto|quansheng|ert-a2|gps|ignore, baud: 0 (auto) | n, name }
      ports: [],
      // Ports that are not USB, to scan as well (e.g. "/dev/serial0", the GPIO UART).
      extraPorts: [],
      sdr: {
        enabled: true,
        freqHz: 151500000,
        // More channels for the same stick to hear at once, each a receiver of
        // its own (rpi-<host>-sdr<n>-<MHz>): [{ freqHz, format }] (format: the
        // one below when left out). One stick hears channels up to 1.89 MHz
        // apart (sdr-plan.js).
        moreChannels: [],
        sampleRate: 0,         // 0: 960 ksps on a 4-core Pi with 1 GB+, 240 ksps otherwise — or what the channels need
        offsetHz: 0,           // 0: tune off-centre by a quarter of the rate, away from the DC spike (one channel)
        gainDb: 29.7,          // null: tuner AGC
        ppm: 0,
        format: 'BINARY',      // one at a time, on purpose — see alert-dsp.js
        biasTee: false,
        gate: true,
        squelchDb: 8,
        minVotes: 4,
        minVotesCrc: 4,
      },
      // Each stick's own settings, by the key the Receivers page shows for it:
      //   { key, name, enabled, freqHz, format, moreChannels, gainDb, ppm, biasTee, squelchDb }
      // Anything left out is the shared setting above. (0.4 matched them by
      // { serial } alone, which every stick with that serial shares; still read.)
      sdrDevices: [],
    },
    audio: {
      enabled: true,
      // auto: an SDR's own demodulated audio while its squelch is open, and a
      // re-synthesised burst for each reading from a serial receiver.
      mode: 'auto',
      device: 'default',
      volume: 80,
    },
    web: { port: 80, passwordHash: '' },
    kiosk: { mode: 'auto' },
    system: { timezone: '' },
    // MegaNet's Base Stations tab (lib/remote.js). The base station checks in
    // with MegaNet — MegaNet never connects to it — saying how it is, and
    // collects anything an administrator asked of it:
    //   manage  health, and the fixed list of things MegaNet may ask (settings
    //           but never the token, the endpoints, the web password or this;
    //           restarts; updates; the log)
    //   report  health only; anything asked is refused
    //   off     nothing
    // Only this base station can change it: MegaNet cannot widen its own reach.
    remote: { mode: 'manage', idleS: 60 },
    // The Pi's own Wi-Fi network, for a phone to open the dashboard where there
    // is no other (lib/hotspot.js): auto — after three minutes with no network,
    // giving way to one the moment it appears; on; off. The name is
    // RPi-ALERT-<first four of the host id> when left empty; the password is made
    // on the Pi the first time and shown on its dashboard. Set on the Pi only.
    hotspot: { mode: 'auto', ssid: '', password: '' },
  };
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function merge(base, over) {
  if (!isObj(over)) return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isObj(base[k]) && isObj(over[k]) ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

function num(v, lo, hi) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
}
function isNum(v, lo, hi) { return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi; }

// The channels a stick hears besides its own: [{ freqHz, format? }], at most
// MAX_CHANNELS in all.
function moreOk(list) {
  return Array.isArray(list) && list.length <= MAX_CHANNELS - 1
    && list.every(m => isObj(m) && isNum(m.freqHz, 24e6, 1766e6) && (m.format === undefined || SDR_FORMATS.includes(m.format)));
}
const MORE_RULE = 'a list of up to ' + (MAX_CHANNELS - 1) + ' more channels, each { freqHz: 24–1766 MHz, format: '
  + SDR_FORMATS.join(' | ') + ' (or left out: the stick\'s own) }';

// One stick's own settings: which stick (its key; or a serial, as 0.4 wrote
// them), then any setting that differs from the shared ones.
function stickErrors(d) {
  if (!isObj(d)) return ['each stick\'s settings are an object'];
  const errs = [];
  const need = (ok, msg) => { if (!ok) errs.push(msg); };
  const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
  need(d.key !== undefined ? text(d.key, 120) : text(d.serial, 64), 'key: which stick (as the Receivers page shows it)');
  need(d.name === undefined || (typeof d.name === 'string' && d.name.length <= 60), 'name: at most 60 characters');
  need(d.enabled === undefined || typeof d.enabled === 'boolean', 'enabled: true or false');
  need(d.freqHz === undefined || isNum(d.freqHz, 24e6, 1766e6), 'freqHz: 24–1766 MHz');
  need(d.format === undefined || SDR_FORMATS.includes(d.format), 'format: one of ' + SDR_FORMATS.join(', '));
  need(d.moreChannels === undefined || moreOk(d.moreChannels), 'moreChannels: ' + MORE_RULE);
  need(d.gainDb === undefined || d.gainDb === null || isNum(d.gainDb, 0, 60), 'gainDb: 0–60 dB, or null for AGC');
  need(d.ppm === undefined || isNum(d.ppm, -200, 200), 'ppm: -200…200');
  need(d.biasTee === undefined || typeof d.biasTee === 'boolean', 'biasTee: true or false');
  need(d.squelchDb === undefined || isNum(d.squelchDb, 2, 40), 'squelchDb: 2–40 dB');
  return errs;
}

// Hold every field to its shape. A bad value is refused with a reason rather
// than stored, because a typo in a frequency or a token is far easier to fix
// at the moment it is typed than once the receiver has gone quiet.
function validate(c) {
  const errs = [];
  const need = (ok, msg) => { if (!ok) errs.push(msg); };
  need(typeof c.name === 'string' && c.name.length <= 80, 'name: at most 80 characters');
  const m = c.meganet || {};
  need(typeof m.token === 'string' && m.token.length <= 200 && !/\s/.test(m.token), 'meganet.token: no spaces, at most 200 characters');
  need(Array.isArray(m.endpoints) && m.endpoints.length > 0 && m.endpoints.every(u => /^https?:\/\/[^\s]+$/.test(u)), 'meganet.endpoints: one or more http(s) URLs');
  need(typeof m.autoRequest === 'boolean', 'meganet.autoRequest: true or false');
  need(num(m.queueMb, 16, 65536) !== undefined, 'meganet.queueMb: 16–65536 MB');
  const h = c.hotspot || {};
  need(HOTSPOT_MODES.includes(h.mode), 'hotspot.mode: one of ' + HOTSPOT_MODES.join(', '));
  need(h.ssid === '' || (typeof h.ssid === 'string' && HOTSPOT_SSID.test(h.ssid)), 'hotspot.ssid: 1–32 letters, digits, spaces, dots, dashes or underscores (or empty for RPi-ALERT-…)');
  need(h.password === '' || (typeof h.password === 'string' && HOTSPOT_PASSWORD.test(h.password)), 'hotspot.password: 8–63 characters, no spaces');
  const l = c.location || {};
  need(LOC_SOURCES.includes(l.source), 'location.source: one of ' + LOC_SOURCES.join(', '));
  if (l.source === 'manual' || l.source === 'station') {
    need(num(l.lat, -90, 90) !== undefined && num(l.lon, -180, 180) !== undefined, 'location: latitude -90…90 and longitude -180…180');
  }
  const r = c.receivers || {};
  need(Array.isArray(r.ports) && r.ports.every(p => isObj(p) && typeof p.match === 'string' && p.match && PORT_TYPES.includes(p.type || 'auto')),
    'receivers.ports: each needs a match and a type (' + PORT_TYPES.join(', ') + ')');
  need(Array.isArray(r.extraPorts) && r.extraPorts.every(p => typeof p === 'string' && /^\/dev\/[\w./-]+$/.test(p) && !p.includes('..')), 'receivers.extraPorts: /dev paths (no ".." segments)');
  const s = r.sdr || {};
  need(num(s.freqHz, 24e6, 1766e6) !== undefined, 'receivers.sdr.freqHz: 24–1766 MHz');
  need(moreOk(s.moreChannels), 'receivers.sdr.moreChannels: ' + MORE_RULE);
  need(s.sampleRate === 0 || [240000, 960000, 1200000, 1920000, 2400000].includes(s.sampleRate), 'receivers.sdr.sampleRate: 0 (auto), 240000, 960000, 1200000, 1920000 or 2400000');
  need(num(s.offsetHz, -1e6, 1e6) !== undefined, 'receivers.sdr.offsetHz: within ±1 MHz');
  need(s.gainDb === null || num(s.gainDb, 0, 60) !== undefined, 'receivers.sdr.gainDb: 0–60 dB, or null for AGC');
  need(num(s.ppm, -200, 200) !== undefined, 'receivers.sdr.ppm: -200…200');
  need(SDR_FORMATS.includes(s.format), 'receivers.sdr.format: one of ' + SDR_FORMATS.join(', '));
  need(num(s.squelchDb, 2, 40) !== undefined, 'receivers.sdr.squelchDb: 2–40 dB');
  need(num(s.minVotes, 1, 45) !== undefined && num(s.minVotesCrc, 1, 45) !== undefined, 'receivers.sdr.minVotes: 1–45');
  need(Array.isArray(r.sdrDevices), 'receivers.sdrDevices: a list');
  if (Array.isArray(r.sdrDevices)) {
    r.sdrDevices.forEach((d, i) => { const e = stickErrors(d); if (e.length) errs.push('receivers.sdrDevices[' + i + '] ' + e.join('; ')); });
    const keys = r.sdrDevices.filter(d => isObj(d) && d.key).map(d => d.key);
    need(new Set(keys).size === keys.length, 'receivers.sdrDevices: one entry per stick');
  }
  const a = c.audio || {};
  need(AUDIO_MODES.includes(a.mode), 'audio.mode: one of ' + AUDIO_MODES.join(', '));
  need(typeof a.device === 'string' && /^[\w:,=.-]+$/.test(a.device), 'audio.device: an ALSA device name such as default or plughw:CARD=Headphones');
  need(num(a.volume, 0, 100) !== undefined, 'audio.volume: 0–100');
  need(num((c.web || {}).port, 1, 65535) !== undefined, 'web.port: 1–65535');
  need(KIOSK_MODES.includes((c.kiosk || {}).mode), 'kiosk.mode: one of ' + KIOSK_MODES.join(', '));
  const tz = (c.system || {}).timezone;
  need(tz === '' || /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz), 'system.timezone: e.g. Australia/Brisbane');
  const rm = c.remote || {};
  need(REMOTE_MODES.includes(rm.mode), 'remote.mode: one of ' + REMOTE_MODES.join(', '));
  need(Number.isInteger(rm.idleS) && rm.idleS >= 30 && rm.idleS <= 900, 'remote.idleS: 30–900 seconds');
  return errs;
}

// A stick's channels, its own first: [{ freqHz, format }], each more channel
// in the stick's format unless it names one. own: the stick's entry in
// receivers.sdrDevices, or null for what every stick shares.
function channelsOf(sdr, own) {
  const pick = (f) => (own && own[f] !== undefined ? own[f] : sdr[f]);
  const format = pick('format');
  return [{ freqHz: pick('freqHz'), format }].concat((pick('moreChannels') || []).map(m => ({ freqHz: m.freqHz, format: m.format || format })));
}

// Every stick's channels — the shared ones, and each stick's own — must fit
// in what one stick hears, and no frequency may be listed twice, even in two
// formats: Enhanced iFLOWS read off a strong Binary burst makes CRC-valid
// ghosts (MegaNet's alert-dsp.js: there is no "both"). Not part of
// validate(): repair() tries one setting at a time against the defaults, and
// this is about settings together. A save is refused for it; a settings file
// that breaks it is loaded, and the stick decodes the channels that fit.
function channelErrors(c) {
  const r = (c && c.receivers) || {};
  const errs = [];
  const check = (where, list) => {
    const seen = new Set();
    for (const ch of list) {
      if (seen.has(ch.freqHz)) {
        errs.push(where + ': ' + mhz(ch.freqHz) + ' MHz is listed twice — each channel is decoded in one format: Enhanced iFLOWS read off a strong '
          + 'ALERT Binary burst makes ghosts with a valid CRC');
      }
      seen.add(ch.freqHz);
    }
    const freqs = list.map(ch => ch.freqHz), lo = Math.min(...freqs), hi = Math.max(...freqs);
    if (hi - lo > MAX_SPAN_HZ) {
      errs.push(where + ': ' + mhz(lo) + ' and ' + mhz(hi) + ' MHz are ' + ((hi - lo) / 1e6).toFixed(2) + ' MHz apart, and one stick hears channels up to '
        + (MAX_SPAN_HZ / 1e6).toFixed(2) + ' MHz apart — give the far ones a stick of their own');
    }
  };
  if (!isObj(r.sdr)) return errs;
  check('receivers.sdr', channelsOf(r.sdr, null));
  (r.sdrDevices || []).forEach((d, i) => { if (isObj(d)) check('receivers.sdrDevices[' + i + ']' + (d.key ? ' (' + d.key + ')' : ''), channelsOf(r.sdr, d)); });
  return errs;
}

function maskToken(t) {
  if (!t) return '';
  return t.length <= 12 ? '…' + t.slice(-2) : t.slice(0, 6) + '…' + t.slice(-4);
}

// ── web password ─────────────────────────────────────────────────────────────

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('hex') + '$' + key.toString('hex');
}
function checkPassword(pw, stored) {
  const m = /^scrypt\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(stored || '');
  if (!m) return false;
  const key = crypto.scryptSync(String(pw), Buffer.from(m[1], 'hex'), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(m[2], 'hex');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

// ── the store ────────────────────────────────────────────────────────────────

class Config extends EventEmitter {
  constructor(file) {
    super();
    this.file = file || CONFIG_PATH;
    this.data = defaults();
    this.loadError = null;
  }

  load() {
    let raw = null;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') this.loadError = e.message; }
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const merged = merge(defaults(), parsed);
        // Lists replace rather than merge, and a missing endpoint list means the default.
        if (!Array.isArray(merged.meganet.endpoints) || !merged.meganet.endpoints.length) merged.meganet.endpoints = MEGANET_ENDPOINTS.slice();
        const errs = validate(merged);
        if (errs.length) this.loadError = 'settings file has problems (defaults used for them): ' + errs.join('; ');
        this.data = errs.length ? repair(merged) : merged;
        const ch = channelErrors(this.data);
        if (ch.length) this.loadError = (this.loadError ? this.loadError + '; ' : '') + 'channels one stick cannot hear together (only those that fit are decoded): ' + ch.join('; ');
      } catch (e) {
        this.loadError = 'settings file is not valid JSON (' + e.message + '); starting from defaults, the file is kept as .bad';
        try { fs.copyFileSync(this.file, this.file + '.bad'); } catch (_) {}
      }
    }
    return this;
  }

  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get() { return this.data; }

  // Apply a partial update. Returns { ok, errors, changed: [top-level keys] }.
  update(patch) {
    const next = merge(this.data, patch);
    // Arrays given in a patch replace the stored ones whole (merge() already does that).
    let errors = validate(next);
    if (!errors.length) errors = channelErrors(next);
    if (errors.length) return { ok: false, errors, changed: [] };
    const changed = changedPaths(this.data, next);
    if (!changed.length) return { ok: true, errors: [], changed };
    this.data = next;
    this.save();
    this.emit('change', changed, this.data);
    return { ok: true, errors: [], changed };
  }

  redacted() {
    const c = JSON.parse(JSON.stringify(this.data));
    c.meganet.tokenSet = !!c.meganet.token;
    c.meganet.token = maskToken(c.meganet.token);
    c.web.passwordSet = !!c.web.passwordHash;
    delete c.web.passwordHash;
    return c;
  }
}

// Fields that fail validation go back to their defaults, one by one.
function repair(c) {
  const d = defaults();
  const out = JSON.parse(JSON.stringify(c));
  // One stick's bad settings cost that stick its own settings, not every stick theirs.
  if (out.receivers && Array.isArray(out.receivers.sdrDevices)) {
    const seen = new Set();
    out.receivers.sdrDevices = out.receivers.sdrDevices.filter(e => {
      if (stickErrors(e).length || (e.key && seen.has(e.key))) return false;
      if (e.key) seen.add(e.key);
      return true;
    });
  }
  const probe = (p) => {
    const trial = JSON.parse(JSON.stringify(d));
    setPath(trial, p, getPath(out, p));
    return validate(trial).length === 0;
  };
  for (const p of leafPaths(d)) if (!probe(p)) setPath(out, p, getPath(d, p));
  return validate(out).length ? d : out;
}
function leafPaths(o, pre) {
  const out = [];
  for (const k of Object.keys(o)) {
    const p = pre ? pre + '.' + k : k;
    if (isObj(o[k])) out.push(...leafPaths(o[k], p)); else out.push(p);
  }
  return out;
}
function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); }
function setPath(o, p, v) {
  const ks = p.split('.');
  let cur = o;
  for (let i = 0; i < ks.length - 1; i++) { if (!isObj(cur[ks[i]])) cur[ks[i]] = {}; cur = cur[ks[i]]; }
  cur[ks[ks.length - 1]] = v;
}
function changedPaths(a, b) {
  return leafPaths(merge(defaults(), b)).filter(p => JSON.stringify(getPath(a, p)) !== JSON.stringify(getPath(b, p)));
}

module.exports = {
  Config, defaults, validate, stickErrors, channelsOf, channelErrors, merge, maskToken, hashPassword, checkPassword, getPath, setPath,
  CONFIG_PATH, MEGANET_ENDPOINTS, MEGANET_APIKEY, SDR_FORMATS, FORMAT_NAMES, STICK_FIELDS, PORT_TYPES, AUDIO_MODES, KIOSK_MODES, LOC_SOURCES, REMOTE_MODES,
};
