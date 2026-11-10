'use strict';
// Getting back in touch by itself.
//
// A base station that cannot reach MegaNet keeps listening and keeps what it
// hears (lib/uplink.js, lib/spool.js). Until 0.23 that was all it did. One
// night in November 2026 a base station on Wi-Fi lost its link at 22:18 and
// sat there until somebody switched it off and on at 06:27 — decoding the
// whole time, its nightly update check running (and finding no internet), the
// hardware watchdog content because nothing had hung. Nothing on the Pi was
// trying to get the link back beyond NetworkManager's own retries, which it
// gives up for good after some failures, and the hotspot's ninety-second
// pauses, which only help while NetworkManager is still trying.
//
// So this watches the one thing that matters — does any MegaNet door answer
// (lib/meganet.js: any HTTP answer, a refusal included, says the path is
// there) — and when none has for two minutes it finds out what kind of
// trouble it is and works up a ladder, gentlest first:
//
//   no network at all             join a saved Wi-Fi network by name (at 2
//                                 minutes, then every 10; lib/hotspot.js does
//                                 the same each time it steps aside)
//   a network, nothing passing    renew the connection (5 min, then every 15)
//   either, still                 restart NetworkManager (15 min, then every 2 h)
//   either, still                 reboot the Pi (45 min) — recover.mode 'full'
//   the internet is there, but    renew the connection (10 min), restart
//   MegaNet's name is not found   NetworkManager (20 min); never a reboot
//   another program on the Pi     restart the agent (10 min; then 30 min,
//   reaches MegaNet, this one     then 2 h)
//   does not
//   the internet is there and     nothing: the trouble is MegaNet's, and a
//   MegaNet answers nobody        fleet rebooting itself would not mend it
//
// A reboot is the last resort and is held back hard: only in mode 'full';
// only for a base station that has reached MegaNet in the last week (there is
// a link to get back — a Pi on a hill for a survey never had one); never
// during a survey, with a phone on the hotspot (somebody is working on it) or
// while an update installs; and each one in an outage waits longer than the
// last — 45 minutes without an answer since the Pi started, then 3 hours, 12,
// and a day from then on — so a site whose router has died costs the Pi a
// minute of listening a day, not a reboot loop. The waits are counted on the
// clock nobody can set (how long this process has seen no answer), so NTP or
// a GPS correcting the wall clock by days moves nothing.
//
// Everything it sees and does is kept in <data>/keeper.json, across restarts
// and reboots: each outage — when, what kind, each step and how it went, what
// brought it back — for the web page, `rpi-alert status` and MegaNet's Base
// Stations tab. That record is what was missing after the night above: the
// Pi's own account of it went with the power.
//
// recover.mode: full (all of it) | network (everything but the reboot) | off.

const net = require('node:net');
const dns = require('node:dns');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const system = require('./system');
const hotspot = require('./hotspot');
const { deadline } = require('./meganet');
const { readNoFollow, writeAtomic } = require('./safe-fs');

const MODES = ['full', 'network', 'off'];
const MIN = 60 * 1000, HOUR = 60 * MIN;
const TICK_MS = 30 * 1000;
const FIRST_MS = 2 * MIN;
const REJOIN_EVERY_MS = 10 * MIN;
const RENEW_AFTER_MS = 5 * MIN, RENEW_EVERY_MS = 15 * MIN;
const NETWORK_AFTER_MS = 15 * MIN, NETWORK_EVERY_MS = 2 * HOUR;
const NAMES_RENEW_MS = 10 * MIN, NAMES_NETWORK_MS = 20 * MIN;
const AGENT_AFTER_MS = [10 * MIN, 30 * MIN, 2 * HOUR];
const REBOOT_AFTER_MS = [45 * MIN, 3 * HOUR, 12 * HOUR, 24 * HOUR];
const REACHED_WITHIN_MS = 7 * 24 * HOUR;
const SAVE_REACHED_MS = 6 * HOUR;       // "it answered" is written this often: an SD card is not a log
const UPDATE_RUNS_S = 30 * 60;          // an install said to be running for longer than this has died
const HISTORY = 20, STEPS = 40;
// By number, so no name has to be looked up: is the internet there at all?
const PUBLIC = [['1.1.1.1', 443], ['8.8.8.8', 443], ['9.9.9.9', 443]];

// What each step is, as it is doing it and looking back on it.
const STEP = {
  'wifi-rejoin': ['joining a saved Wi-Fi network', 'after joining its Wi-Fi network again'],
  'net-reconnect': ['renewing the network connection', 'after renewing its network connection'],
  'net-restart': ['restarting the Pi\'s networking', 'after restarting its networking'],
  'restart-agent': ['restarting the agent', 'after restarting the agent'],
  reboot: ['rebooting the Pi', 'after rebooting itself'],
  // Not the keeper's doing, but part of the story:
  power: ['the Pi was switched off and on', 'after the Pi was switched off and on'],
  restart: ['the agent was restarted', 'after the agent was restarted'],
};
const KIND = {
  'no-network': 'This Pi is on no network.',
  'dead-link': 'This Pi is on a network, but nothing gets out to the internet over it.',
  names: 'The internet is there, but this Pi cannot look up Flood-Net\'s name.',
  agent: 'Other programs on this Pi reach Flood-Net and the agent does not.',
  'far-end': 'The internet is there and Flood-Net is not answering: the trouble is at its end.',
};

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function mins(ms) { const m = Math.max(1, Math.ceil(ms / MIN)); return m < 90 ? m + ' min' : Math.round(m / 60) + ' h'; }
function span(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  return m < 1 ? 'under a minute' : m < 90 ? m + ' min' : m < 48 * 60 ? (Math.round(m / 6) / 10) + ' h' : Math.round(m / 1440) + ' days';
}

function tcp(host, port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
// Can any address on the internet be reached? No names, nothing sent.
async function internet() { return (await Promise.all(PUBLIC.map(([h, p]) => tcp(h, p, 5000)))).some(Boolean); }
function names(host) {
  if (!host || net.isIP(host)) return Promise.resolve(true);
  return deadline(dns.promises.lookup(host), 8000).then(() => true, () => false);
}
// Does another program on this Pi get any answer from MegaNet? → true, false,
// or null when there is no curl to ask with.
async function fresh(url) {
  const r = await system.run('curl', ['-s', '-o', '/dev/null', '-m', '12', '-w', '%{http_code}', url + '/'], { timeout: 15000 });
  if (r.missing) return null;
  return Number(r.stdout.trim()) > 0;
}
// Is an update installing right now? (The updater's own note, root's file.)
function updating(nowMs) {
  const u = system.lastUpdate();
  return !!u && u.state === 'running' && Math.abs(nowMs / 1000 - (Number(u.at) || 0)) < UPDATE_RUNS_S;
}

class Keeper extends EventEmitter {
  // opts, for tests: { exec(verb) → { code, stdout, stderr }, probe: { net, internet, names, fresh, updating }, now(), mono() }
  constructor(agent, opts) {
    super();
    opts = opts || {};
    this.agent = agent;
    this.log = agent.log.child('keeper');
    this.file = path.join(agent.dataDir, 'keeper.json');
    this.exec = opts.exec || ((verb, ...a) => system.priv(verb, ...a));
    this.probe = Object.assign({ net: hotspot.readStatus, internet, names, fresh, updating }, opts.probe || {});
    this.now = opts.now || Date.now;
    this.mono = opts.mono || (() => Math.round(performance.now()));
    // Kept on disk: when MegaNet last answered; reboots and agent restarts
    // tried since then; the outages before this one.
    this.d = { lastReachedAt: null, reboots: 0, agentRestarts: 0, history: [] };
    this.out = null;          // the outage now: { since, sinceMono, kind, steps, last }
    this.downMono = null;     // when this process first saw no door answering
    this.note = '';
    this.busy = false;
    this.savedReachedAt = 0;
  }

  mode() { const m = (this.agent.config.get().recover || {}).mode; return MODES.includes(m) ? m : 'full'; }
  bootId() { try { return this.agent.clock.bootId(); } catch (_) { return null; } }

  load() {
    let j = null;
    try { j = JSON.parse(readNoFollow(this.file, 512 * 1024)); } catch (_) {}
    if (!isObj(j)) return this;
    this.d.lastReachedAt = Number(j.lastReachedAt) || null;
    this.d.reboots = Math.max(0, Math.round(Number(j.reboots) || 0));
    this.d.agentRestarts = Math.max(0, Math.round(Number(j.agentRestarts) || 0));
    this.d.history = Array.isArray(j.history) ? j.history.filter(isObj).slice(0, HISTORY) : [];
    // An outage that was still on when the agent stopped is carried on: its
    // steps kept, its waits begun again. What stopped the agent is part of
    // the story when it was not this keeper's own doing.
    if (isObj(j.out) && Number(j.out.since)) {
      const steps = Array.isArray(j.out.steps) ? j.out.steps.filter(isObj).slice(-STEPS) : [];
      const last = steps[steps.length - 1];
      const rebooted = !!j.boot && j.boot !== this.bootId();
      if (rebooted && !(last && last.what === 'reboot')) steps.push({ t: this.now(), what: 'power', ok: true });
      else if (!rebooted && !(last && last.what === 'restart-agent')) steps.push({ t: this.now(), what: 'restart', ok: true });
      this.out = { since: Number(j.out.since), sinceMono: this.mono(), kind: j.out.kind || null, steps, last: {} };
    }
    return this;
  }

  save() {
    const o = this.out;
    const d = Object.assign({}, this.d, { boot: this.bootId(), out: o ? { since: o.since, kind: o.kind, steps: o.steps } : null });
    try { writeAtomic(this.file, JSON.stringify(d) + '\n', { mode: 0o600 }); }
    catch (e) { this.log.warn('could not keep the record of this outage: ' + e.message); }
  }

  start() {
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    return this;
  }
  stop() { this.stopped = true; clearInterval(this.timer); clearTimeout(this.soonTimer); }

  // After a step that may have worked: ask again shortly, not in half a minute.
  soon(ms) {
    clearTimeout(this.soonTimer);
    if (this.stopped) return;
    this.soonTimer = setTimeout(() => this.tick(), ms);
    this.soonTimer.unref?.();
  }

  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try { await this.step(); }
    catch (e) { this.log.warn('could not check the link to Flood-Net: ' + ((e && e.message) || e)); }
    finally { this.busy = false; }
  }

  async step() {
    const api = this.agent.uplink.api, mode = this.mode();
    // Off, or not sending by choice (no token, sending turned off): there is no link to keep.
    if (mode === 'off' || !this.agent.uplink.enabled()) {
      this.downMono = null;
      if (this.out) { this.out = null; this.save(); this.emit('change'); }
      return this.say(mode === 'off' ? 'Off.' : 'Not sending to Flood-Net, so there is no link to keep.');
    }
    if (api.unreachableSince == null) {
      if (api.lastAnswerAt != null) return this.reached(api.lastAnswerAt);
      // Nothing tried since the agent started. With an outage carried over, ask; else wait for the first word.
      if (this.out && await api.reach()) return this.reached(this.now());
      if (!this.out) return this.say('');
    }
    const mono = this.mono();
    // Counted from when the first request failed — but credited a minute of
    // that at most, since that moment is wall-clock time and the wall clock
    // can be set.
    if (this.downMono == null) this.downMono = mono - Math.min(Math.max(0, this.now() - (api.unreachableSince || this.now())), 2 * TICK_MS);
    if (!this.out) {
      if (mono - this.downMono < FIRST_MS) return;
      this.out = { since: api.unreachableSince || this.now(), sinceMono: this.downMono, kind: null, steps: [], last: {} };
      this.log.warn('no answer from Flood-Net for ' + mins(mono - this.downMono) + (api.lastFailure ? ' (' + api.lastFailure + ')' : '') + ' — finding out why');
    }
    const o = this.out;
    // The queue may be backing off for five minutes: ask here.
    if (await api.reach()) return this.reached(this.now());
    const see = await this.look(api);
    if (see.kind !== o.kind) { o.kind = see.kind; this.log.warn(KIND[see.kind]); this.emit('change'); }
    await this.act(o, this.mono() - o.sinceMono, see, mode);
  }

  // What kind of trouble: no network, a dead one, names, this program, or MegaNet's end.
  async look(api) {
    const ep = api.endpoints()[0] || { url: '' };
    let host = '';
    try { host = new URL(ep.url).hostname; } catch (_) {}
    const [nm, online] = await Promise.all([Promise.resolve().then(() => this.probe.net()).catch(() => null), Promise.resolve().then(() => this.probe.internet()).catch(() => false)]);
    const n = nm && !nm.error ? nm : { wifi: null, active: false, clients: 0, saved: 0, connected: [] };
    const see = { net: n, internet: !!online, names: null, fresh: null };
    if (!online) { see.kind = (n.connected || []).length ? 'dead-link' : 'no-network'; return see; }
    see.names = await Promise.resolve().then(() => this.probe.names(host)).catch(() => false);
    see.fresh = see.names ? await Promise.resolve().then(() => this.probe.fresh(ep.url)).catch(() => null) : false;
    see.kind = see.fresh ? 'agent' : !see.names ? 'names' : 'far-end';
    return see;
  }

  async act(o, down, see, mode) {
    const n = see.net;
    // Due: not before `after`, and (when it repeats) `every` since it was last tried.
    const due = (what, after, every) => down >= after && (o.last[what] == null || (!!every && down - o.last[what] >= every));
    if (see.kind === 'far-end') return this.say(KIND['far-end'] + ' Nothing to do here but keep what is heard and wait.');
    if (see.kind === 'agent') {
      const after = AGENT_AFTER_MS[this.d.agentRestarts];
      if (after == null) return this.say(KIND.agent + ' Restarting it ' + AGENT_AFTER_MS.length + ' times has not helped: it needs a person.');
      if (down < after) return this.say(KIND.agent + ' Restarting the agent in ' + mins(after - down) + ' if that goes on.');
      this.d.agentRestarts++;
      return this.take(o, down, 'restart-agent');
    }
    if (see.kind === 'names') {
      if (due('net-reconnect', NAMES_RENEW_MS)) return this.take(o, down, 'net-reconnect');
      if (due('net-restart', NAMES_NETWORK_MS)) return this.take(o, down, 'net-restart');
      return this.say(KIND.names + (down < NAMES_NETWORK_MS ? ' Renewing the connection, then restarting its networking, if that goes on.' : ' Its networking has been restarted; the rest is the network\'s to fix.'));
    }
    // No way out to the internet at all. A phone on a hotspot that came up
    // because there was no network is somebody at the Pi, working on it; on
    // one that is always on it is just the site's Wi-Fi.
    const always = ((this.agent.config.get().hotspot || {}).mode === 'on');
    if (n.active && n.clients > 0 && !always) return this.say(KIND[see.kind] + ' Somebody is on its hotspot, so the Wi-Fi is left alone while they work.');
    // With the hotspot up, lib/hotspot.js steps aside and joins by itself; here, when it is not.
    if (see.kind === 'no-network' && n.wifi && n.saved && !n.active && due('wifi-rejoin', FIRST_MS, REJOIN_EVERY_MS)) return this.take(o, down, 'wifi-rejoin');
    if (see.kind === 'dead-link' && due('net-reconnect', RENEW_AFTER_MS, RENEW_EVERY_MS)) return this.take(o, down, 'net-reconnect');
    if (this.agent.survey && this.agent.survey.running && this.agent.survey.running()) {
      return this.say(KIND[see.kind] + ' A survey is running, which is meant to work with no network: nothing is restarted.');
    }
    if (due('net-restart', NETWORK_AFTER_MS, NETWORK_EVERY_MS)) return this.take(o, down, 'net-restart');
    const wait = this.rebootWait(down, mode);
    if (wait == null) return this.take(o, down, 'reboot');
    return this.say(KIND[see.kind] + ' ' + (down < NETWORK_AFTER_MS ? 'Restarting its networking in ' + mins(NETWORK_AFTER_MS - down) + ' if nothing brings the link back. ' : '') + wait);
  }

  // → null when a reboot is due now; else why not, or when.
  rebootWait(down, mode) {
    if (mode !== 'full') return 'It will not reboot the Pi: that is turned off in the settings.';
    const reached = this.d.lastReachedAt;
    if (!reached || this.now() - reached > REACHED_WITHIN_MS) return 'It will not reboot the Pi: this Pi has not reached Flood-Net in the last week, so there is no link here to get back.';
    if (this.probe.updating(this.now())) return 'An update is installing: no reboot until it has finished.';
    const tried = this.d.reboots;
    const after = REBOOT_AFTER_MS[Math.min(tried, REBOOT_AFTER_MS.length - 1)];
    if (down < after) {
      return 'Rebooting the Pi in ' + mins(after - down) + ' if nothing brings the link back'
        + (tried ? ' (' + tried + ' reboot' + (tried === 1 ? ' has' : 's have') + ' not, so each waits longer than the last).' : '.');
    }
    return null;
  }

  async take(o, down, what) {
    o.last[what] = down;
    const step = { t: this.now(), what, ok: false };
    o.steps.push(step);
    if (o.steps.length > STEPS) o.steps.splice(0, o.steps.length - STEPS);
    this.say(KIND[o.kind] + ' Now ' + STEP[what][0] + '.');
    // Said in the log the first time in an outage; a night of the same step every ten minutes is not sixty lines.
    const before = o.steps.length > 1 ? o.steps[o.steps.length - 2] : null;
    const again = !!before && before.what === what;
    if (!again) this.log.warn('no answer from Flood-Net for ' + mins(down) + ': ' + STEP[what][0]);
    const ends = what === 'reboot' || what === 'restart-agent';
    if (what === 'reboot') this.d.reboots++;
    if (ends) {
      // Written down first — the answer to these never comes back — and the queue with it.
      step.ok = true;
      this.save();
      try { this.agent.uplink.persistNow(); } catch (_) {}
    }
    let r;
    try { r = await this.exec(what); } catch (e) { r = { code: -1, stdout: '', stderr: String((e && e.message) || e) }; }
    step.ok = !!r && r.code === 0;
    const said = String((r && (r.code === 0 ? r.stdout : r.stderr || r.stdout)) || '').trim().split('\n').pop().slice(0, 160);
    if (said) step.note = said;
    // The same step failing the same way again is one line of the record, counted.
    if (again && !step.ok && !before.ok && (before.note || '') === (step.note || '')) {
      o.steps.pop();
      before.n = (before.n || 1) + 1;
      before.t = step.t;
    } else if (!step.ok) this.log.warn('could not finish ' + STEP[what][0] + (said ? ': ' + said : ''));
    this.save();
    this.emit('change');
    if (step.ok && !ends) this.soon(10000);
  }

  // MegaNet answered.
  reached(at) {
    this.downMono = null;
    const now = this.now();
    let dirty = false;
    if (this.out) {
      const o = this.out;
      this.out = null;
      const did = o.steps.filter(s => s.ok).pop();
      this.d.history.unshift({ began: o.since, ended: now, kind: o.kind, how: did ? did.what : null,
        steps: o.steps.slice(-12).map(s => ({ t: s.t, what: s.what, ok: !!s.ok, note: s.note, n: s.n })) });
      this.d.history.length = Math.min(this.d.history.length, HISTORY);
      this.log.info('back in touch with Flood-Net after ' + span(now - o.since) + ' — ' + (did ? STEP[did.what][1] : 'the link came back by itself'));
      dirty = true;
      // What was kept goes now, not when the queue's own back-off next comes
      // round — and MegaNet hears it is back now, not a quarter of an hour on.
      try { this.agent.uplink.sendNow(); } catch (_) {}
      try { const r = this.agent.remote; if (r && r.st && r.st.state === 'error') r.schedule(1000); } catch (_) {}
    }
    if (this.d.reboots || this.d.agentRestarts) { this.d.reboots = 0; this.d.agentRestarts = 0; dirty = true; }
    this.d.lastReachedAt = Math.max(Number(at) || 0, this.d.lastReachedAt || 0) || now;
    if (dirty || now - this.savedReachedAt > SAVE_REACHED_MS) { this.savedReachedAt = now; this.save(); }
    if (dirty) this.emit('change');
    this.say('');
  }

  say(note) { if (note !== this.note) { this.note = note; this.emit('change'); } }

  // For the web page and `rpi-alert status`.
  status() {
    const o = this.out, mode = this.mode(), api = this.agent.uplink.api;
    return { mode, state: mode === 'off' ? 'off' : o ? 'down' : 'ok', since: o ? o.since : null, kind: o ? o.kind : null, note: this.note,
      steps: o ? o.steps.slice(-8) : [], lastReachedAt: Math.max(this.d.lastReachedAt || 0, api.lastAnswerAt || 0) || null,
      reboots: this.d.reboots, history: this.d.history.slice(0, 8) };
  }

  // For MegaNet's Base Stations tab: the setting, and the last few outages in brief.
  brief() {
    return { mode: this.mode(), down_since: this.out ? this.out.since : null,
      outages: this.d.history.slice(0, 5).map(h => ({ began: h.began, ended: h.ended, kind: h.kind || null, how: h.how || null,
        steps: (h.steps || []).slice(-6).map(s => ({ what: s.what, ok: !!s.ok, n: s.n })) })) };
  }
}

module.exports = { Keeper, MODES, STEP, KIND, span, FIRST_MS, REBOOT_AFTER_MS, AGENT_AFTER_MS, NETWORK_AFTER_MS, REJOIN_EVERY_MS, REACHED_WITHIN_MS };
