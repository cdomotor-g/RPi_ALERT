'use strict';
// Asking MegaNet for this Pi's ingest token, instead of somebody carrying one
// to it — MegaNet's db/migrations/0048_ingest_token_requests.sql, and its
// docs/ingest-http.md, "A base station that asks for its token".
//
//   1. Request a token — the dashboard's button (on this Pi's screen, or the
//      web page from any computer on the network), `rpi-alert request-token`
//      over SSH, or request_token = yes on the SD card for a Pi nobody will be
//      standing at. The agent makes a token of its own — mgn_ and 64 hex
//      characters from the kernel's random number generator — and sends it to
//      request_ingest_token() in X-Ingest-Token, with this base station's name
//      and what is plugged in. MegaNet keeps only its hash and answers with a
//      code such as WDJB-MJHT.
//   2. The code is shown on the dashboard beside a QR code that opens MegaNet's
//      Admin tab on the request, and by `rpi-alert status`.
//   3. An administrator signed in to MegaNet anywhere — their phone — checks
//      the code and presses Approve. ingest_token_request_status() is asked
//      every five seconds; on "approved" the token becomes meganet.token and
//      the uplink sends everything it kept while it waited.
//
// Nothing secret is ever shown or typed: the token never leaves this Pi except
// as the header it always travels in, and the code only says which request is
// this one. The token being asked about lives in token-request.json in the data
// directory, mode 0600, so a restart or a power cut carries on asking; it
// becomes a setting only once MegaNet has approved it. A request lasts half an
// hour.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { mono } = require('./clock');

const POLL_MS = 5000, POLL_MAX_MS = 60000, AUTO_GAP_MS = 60000;
// Where the administrator approves it. The QR code is this with #pair=<code>,
// which MegaNet opens on the Admin tab with that request's form ready.
const APP_URL = 'https://floodwarning.net/';
const TOKEN_RE = /^mgn_[0-9a-f]{64}$/;

const ENDED = {
  denied:    'An administrator turned the request down. Ask again to get a new code.',
  expired:   'Nobody approved the request within half an hour. Ask again to get a new code.',
  withdrawn: 'The request was withdrawn.',
  revoked:   'MegaNet has revoked that token. Ask again to get a new one.',
  unknown:   'MegaNet no longer has the request. Ask again to get a new code.',
};

class TokenRequest extends EventEmitter {
  constructor(opts) {
    super();
    this.cfg = opts.config;          // Config
    this.api = opts.api;             // MegaNet (lib/meganet.js)
    this.log = opts.log;
    this.describe = opts.describe;   // () => { label, host_station_id?, detail }
    this.file = path.join(opts.dataDir, 'token-request.json');
    this.pending = null;             // { token, id, code, label, requestedAt, deadline (monotonic ms) }
    this.last = null;                // { status, message, label?, at }
    this.busy = false;
    this.timer = null;
    this.autoTimer = null;
    this.failures = 0;
    this.lastAuto = -Infinity;
    this.stopped = false;
    // How often to ask; the tests shorten it. Otherwise MegaNet's poll_s, 5 s.
    this.pollMs = opts.pollMs || 0;
  }

  load() {
    try {
      const p = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (p && TOKEN_RE.test(p.token || '') && /^[A-Z]{4}-[A-Z]{4}$/.test(p.code || '')) {
        // The monotonic clock restarts with the Pi, so a saved deadline means
        // nothing after a reboot: the first answer from MegaNet sets it again.
        p.deadline = mono() + 5 * 60 * 1000;
        this.pending = p;
      }
    } catch (_) {}
    return this;
  }

  save() {
    try {
      if (!this.pending) { if (fs.existsSync(this.file)) fs.unlinkSync(this.file); return; }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const keep = Object.assign({}, this.pending);
      delete keep.deadline;
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(keep, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { this.log.warn('could not save the token request: ' + e.message); }
  }

  start() {
    this.cfg.on('change', (changed) => {
      const m = this.cfg.get().meganet;
      // A token pasted in by hand while a request waits: the request is moot.
      if (changed.includes('meganet.token') && m.token && this.pending && m.token !== this.pending.token) {
        this.cancel('A token was set by hand, so the request was withdrawn.', { keepAuto: true });
      }
      // Asking by itself switched (back) on: a denial before is not a reason not to.
      if (changed.includes('meganet.autoRequest') && m.autoRequest) {
        if (this.last && this.last.status === 'denied') this.last = null;
        this.lastAuto = -Infinity;
        this.maybeAuto();
      }
    });
    if (this.pending) {
      this.log.info('still waiting for MegaNet to approve the token request — code ' + this.pending.code);
      this.schedule(1000);
    }
    // request_token = yes: keep a request open while there is no token.
    this.autoTimer = setInterval(() => this.maybeAuto(), 15000);
    if (this.autoTimer.unref) this.autoTimer.unref();
    setTimeout(() => this.maybeAuto(), this.pollMs ? 50 : 3000).unref?.();
    return this;
  }

  stop() { this.stopped = true; clearTimeout(this.timer); clearInterval(this.autoTimer); }

  maybeAuto() {
    const m = this.cfg.get().meganet;
    if (this.stopped || !m.autoRequest || !m.enabled || m.token || this.pending || this.busy) return;
    if (this.last && this.last.status === 'denied') return;
    // Not more than once a minute — a Pi with no network must not ask in a
    // tight loop — and once an hour while MegaNet cannot take requests at all
    // (0048 not applied there yet: it starts working when it is).
    const gap = this.last && this.last.status === 'unsupported' ? 3600000 : AUTO_GAP_MS;
    if (mono() - this.lastAuto < gap) return;
    this.lastAuto = mono();
    this.request({ auto: true });
  }

  // → status(). Asking again while a request waits is a no-op.
  async request(opts) {
    opts = opts || {};
    if (this.pending || this.busy) return this.status();
    this.busy = true;
    this.emit('change');
    const token = 'mgn_' + crypto.randomBytes(32).toString('hex');
    const d = this.describe();
    const payload = {
      label: String(d.label || 'RPi ALERT').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120) || 'RPi ALERT',
      detail: d.detail || {},
    };
    if (d.host_station_id) payload.host_station_id = d.host_station_id;
    let res;
    try {
      res = await this.api.rpc('request_ingest_token', payload, token);
    } catch (e) {
      this.busy = false;
      this.setLast('error', 'Could not reach MegaNet (' + e.message + ') — check the network, then ask again.');
      return this.status();
    }
    this.busy = false;
    const b = res.body || {};
    if (res.status === 200 && b.code) {
      this.pending = { token, id: b.id, code: b.code, label: b.label || payload.label, requestedAt: Date.now(),
        auto: !!opts.auto, deadline: mono() + (Number(b.expires_in) || 1800) * 1000 };
      this.save();
      this.last = null;
      this.failures = 0;
      this.log.info('asked MegaNet for an ingest token as "' + this.pending.label + '" — code ' + b.code
        + '. Approve it on MegaNet\'s Admin tab → Ingest tokens (' + this.link() + ').');
      this.emit('change');
      this.schedule(this.pollMs || POLL_MS);
      return this.status();
    }
    if (res.status === 404 && res.missingFn) {
      this.setLast('unsupported', 'MegaNet cannot take token requests yet (its migration 0048 is not applied). '
        + 'Paste a token instead: an administrator makes one on MegaNet\'s Admin tab → Ingest tokens.');
    } else if (res.status === 429) {
      this.setLast('busy', (b.message || 'Too many base stations are waiting for an administrator') + ' — try again in a few minutes.');
    } else {
      this.setLast('error', 'MegaNet did not take the request (' + res.status + (b.message ? ': ' + b.message : '') + ').');
    }
    return this.status();
  }

  schedule(ms) {
    clearTimeout(this.timer);
    if (this.stopped || !this.pending) return;
    this.timer = setTimeout(() => this.poll(), ms);
  }

  async poll() {
    this.timer = null;
    const p = this.pending;
    if (!p || this.stopped) return;
    let res;
    try {
      res = await this.api.rpc('ingest_token_request_status', {}, p.token);
    } catch (e) {
      return this.retry(p, 'could not reach MegaNet: ' + e.message);
    }
    if (this.pending !== p) return;               // withdrawn while asking
    const b = res.body || {};
    if (res.status !== 200 || !b.status) {
      if (res.status === 404 && res.missingFn) {
        this.pending = null; this.save();
        this.setLast('unsupported', 'MegaNet cannot take token requests any more (its migration 0048 is missing).');
        return;
      }
      return this.retry(p, 'MegaNet answered ' + res.status + (b.message ? ' (' + b.message + ')' : ''));
    }
    if (this.failures >= 3) this.log.info('MegaNet is answering again about the token request');
    this.failures = 0;
    if (b.status === 'pending') {
      if (b.expires_in != null) p.deadline = mono() + Number(b.expires_in) * 1000;
      return this.schedule(this.pollMs || Math.max(2000, Math.min(30000, (Number(b.poll_s) || 5) * 1000)));
    }
    if (b.status === 'approved') return this.approved(p, b);
    return this.ended(p, b.status);
  }

  // No answer is not an answer. Even past its half hour the request is kept and
  // asked about, more slowly: an administrator may have approved it while the
  // network was down, and only MegaNet can say "expired" — guessing it here
  // would throw away a token that works.
  retry(p, why) {
    if (this.pending !== p) return;
    this.failures++;
    if (this.failures === 3) this.log.warn('still waiting for approval, but ' + why + ' — trying again');
    this.schedule(Math.min(POLL_MAX_MS, (this.pollMs || POLL_MS) * Math.pow(2, Math.min(this.failures, 4))));
  }

  approved(p, b) {
    // The request is finished before the setting changes, so the change below
    // is not mistaken for a token pasted in by hand.
    this.pending = null;
    this.save();
    const r = this.cfg.update({ meganet: { token: p.token, enabled: true, autoRequest: false } });
    if (!r.ok) {
      this.log.error('MegaNet approved the token, but it could not be saved: ' + r.errors.join('; '));
      this.setLast('error', 'Approved, but the token could not be saved here: ' + r.errors.join('; '));
      return;
    }
    const label = b.label || p.label;
    this.log.info('MegaNet approved the token request — posting as "' + label + '"');
    this.setLast('approved', 'Approved — this base station posts to MegaNet as “' + label + '”.', label);
    this.emit('approved', label);
  }

  ended(p, status) {
    if (this.pending !== p) return;
    this.pending = null;
    this.save();
    const msg = ENDED[status] || ENDED.unknown;
    this.log.warn('token request ' + p.code + ': ' + status);
    this.setLast(ENDED[status] ? status : 'unknown', msg);
    // Turned down: stop asking by ourselves. Run out: ask again, if asked to.
    if (status === 'denied' && this.cfg.get().meganet.autoRequest) this.cfg.update({ meganet: { autoRequest: false } });
    else if (status !== 'denied') { this.lastAuto = -Infinity; setTimeout(() => this.maybeAuto(), 1000).unref?.(); }
  }

  // Stop waiting. MegaNet is told, so the request leaves the Admin tab's list
  // rather than waiting to be approved for nobody; it would expire anyway.
  async cancel(why, opts) {
    const p = this.pending;
    if (!p) return this.status();
    clearTimeout(this.timer);
    this.pending = null;
    this.save();
    if (!(opts && opts.keepAuto) && this.cfg.get().meganet.autoRequest) this.cfg.update({ meganet: { autoRequest: false } });
    this.setLast('withdrawn', why || 'Stopped asking. Ask again for a new code.');
    try { await this.api.rpc('withdraw_ingest_token_request', {}, p.token); } catch (_) { /* it runs out by itself */ }
    return this.status();
  }

  setLast(status, message, label) {
    this.last = { status, message, label: label || null, at: Date.now() };
    if (status === 'error' || status === 'busy' || status === 'unsupported') this.log.warn(message);
    this.emit('change');
  }

  link(code) { return APP_URL + '#pair=' + (code || (this.pending && this.pending.code) || ''); }

  status() {
    const p = this.pending;
    return {
      state: p ? 'pending' : this.busy ? 'asking' : 'idle',
      code: p ? p.code : null,
      label: p ? p.label : null,
      requestedAt: p ? p.requestedAt : null,
      expiresInS: p ? Math.max(0, Math.round((p.deadline - mono()) / 1000)) : null,
      link: p ? this.link(p.code) : null,
      auto: !!this.cfg.get().meganet.autoRequest,
      last: this.last,
    };
  }
}

module.exports = { TokenRequest, APP_URL };
