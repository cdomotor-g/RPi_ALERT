'use strict';
// MegaNet's Base Stations tab: how this base station is, told to MegaNet, and
// the few things MegaNet's administrators may ask of it (MegaNet's migration
// 0049, docs/base-stations.md there; docs/remote-management.md here).
//
// The base station calls MegaNet; MegaNet never calls the base station. There
// is no port to open, nothing listening for MegaNet, and nothing a stranger
// could connect to: the Pi asks, over the same HTTPS door and with the same
// ingest token its readings use,
//
//   POST <endpoint>/rpc/base_station_checkin   {"payload": {…}}
//
// Every check-in carries a heartbeat — a few hundred bytes: uptime,
// temperature, what is queued, each receiver's state — and, when something has
// changed, every quarter of an hour, or when MegaNet asks, the whole status:
// receivers, the uplink, the clock, the software, SSH access, the settings less
// the token. MegaNet's answer says when to check in next (a minute; every five
// seconds while an administrator has this base station open) and carries what
// they asked for, which is done at once and answered at the next check-in.
//
// What MegaNet may ask is VERBS below, and nothing else: change settings — but
// never the ingest token, where readings go, the web page's password or port,
// or these settings themselves, so MegaNet cannot widen its own reach; restart
// a receiver, the agent or the Pi; look for receivers; send what is queued;
// check for, install and schedule updates; the last lines of the log. No
// shell, no files, no SSH keys, nothing secret in either direction. Anything
// asked is done once (MegaNet hands a request over once) and written in this
// Pi's log and on its web page.
//
// What it costs: one small request a minute from the main thread — decoding
// is in worker threads of its own — and two root-helper calls a quarter of an
// hour (update and SSH state). The heartbeat and status are built from what
// the agent already holds.
//
// Turned down or off on the Pi alone (remote.mode: manage, report, off): the
// web page's Settings, `rpi-alert remote`, or remote_management in
// rpi-alert.conf.

const os = require('node:os');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const logm = require('./log');
const system = require('./system');
const { defaults } = require('./config');
const pkg = require('../package.json');

const FULL_MS = 15 * 60 * 1000;      // the whole status, at least this often
const SLOW_MS = 15 * 60 * 1000;      // update and SSH state, asked of root this often
const MISSING_MS = 60 * 60 * 1000;   // a MegaNet without 0049: ask again in an hour
const REFUSED_MS = 15 * 60 * 1000;   // a refused token: the uplink says so; ask again later
const AFTER_MS = 60 * 1000;          // a restart waits this long at most for its answer to go
const MAX_RESULTS = 10;
const MAX_RESULT_BYTES = 60000;
// What MegaNet keeps of a check-in (0049): a status of 16 KB, a heartbeat of 2 KB.
const MAX_STATUS_BYTES = 15500;
const MAX_RX_IN_BEAT = 12;

// Of the settings, these are this base station's alone.
const LOCAL_ONLY = {
  web: 'the web page\'s password and port',
  hotspot: 'its own Wi-Fi network and its password',
  remote: 'what MegaNet may do',
  version: null,
};
// Of meganet.*: whether to send — never where, or with what.
const MEGANET_REMOTE = ['enabled', 'receptions'];

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// A settings patch from MegaNet → null, or why not.
function checkPatch(patch) {
  if (!isObj(patch) || !Object.keys(patch).length) return 'send the settings to change, as an object';
  const d = defaults();
  for (const k of Object.keys(patch)) {
    if (k in LOCAL_ONLY) return k + ' is set on the base station itself' + (LOCAL_ONLY[k] ? ' (' + LOCAL_ONLY[k] + ')' : '');
    if (!(k in d)) return 'there is no setting "' + String(k).slice(0, 40) + '"';
  }
  if (patch.meganet !== undefined) {
    if (!isObj(patch.meganet)) return 'meganet: an object';
    for (const k of Object.keys(patch.meganet)) {
      if (!MEGANET_REMOTE.includes(k)) return 'meganet.' + String(k).slice(0, 40) + ' is set on the base station itself — from MegaNet only sending (enabled) and receptions';
    }
  }
  return null;
}

// Every path a patch touches, for the log: "receivers.sdr.freqHz, audio.volume".
function paths(o, pre) {
  const out = [];
  for (const k of Object.keys(o || {})) {
    const p = pre ? pre + '.' + k : k;
    if (isObj(o[k])) out.push(...paths(o[k], p)); else out.push(p);
  }
  return out;
}

function deviceOf(agent, key) {
  const s = agent.devices.all().find(x => x.key === key);
  if (!s) throw new Error('no receiver ' + String(key).slice(0, 80));
  return s;
}

function priv(verb, ...args) {
  return system.priv(verb, ...args).then((r) => {
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || '').trim().slice(0, 300) || verb + ' failed');
    return r;
  });
}

// What MegaNet may ask. Each runs with (remote, args) and answers
// { result, after }: result goes back to MegaNet, and after — a restart —
// runs once the answer has gone.
const VERBS = {
  status: { label: 'send its whole status', run: async (r) => { r.wantFull = true; return { result: 'the whole status goes with the next check-in' }; } },
  log: { label: 'show its log', run: async (r, a) => {
    const n = Math.max(1, Math.min(400, Math.round(Number(a.lines) || 200)));
    return { result: { lines: logm.recent(n).map(l => ({ t: l.t, level: l.level, tag: l.tag, msg: String(l.msg).slice(0, 400) })) } };
  } },
  'config.set': { label: 'change settings', run: async (r, a) => {
    const why = checkPatch(a.patch);
    if (why) throw new Error(why);
    const u = r.agent.config.update(a.patch);
    if (!u.ok) throw new Error('not saved: ' + u.errors.join('; '));
    r.wantFull = true;
    return { result: { changed: u.changed } };
  } },
  'device.restart': { label: 'restart a receiver', run: async (r, a) => {
    const s = deviceOf(r.agent, a.key);
    if (s.state === 'unplugged') throw new Error(s.name() + ' is not plugged in');
    await s.restart();
    return { result: s.name() + ' restarted' };
  } },
  'device.rescan': { label: 'look for receivers', run: async (r) => { r.agent.devices.scan(); return { result: 'looking' }; } },
  'device.forget': { label: 'remove an unplugged receiver', run: async (r, a) => {
    const f = r.agent.devices.forget(String(a.key || ''));
    if (!f.ok) throw new Error(f.error);
    r.wantFull = true;
    return { result: f.name + ' removed' };
  } },
  'send-now': { label: 'send what is queued now', run: async (r) => { r.agent.uplink.sendNow(); return { result: r.agent.uplink.status().queued + ' readings queued, sending' }; } },
  'stations.refresh': { label: 'download the station register again', run: async (r) => { r.agent.stations.refresh(); return { result: 'downloading' }; } },
  'agent.restart': { label: 'restart the agent', run: async () => ({ result: 'restarting the agent — it is back within seconds', after: () => system.priv('restart-agent') }) },
  reboot: { label: 'reboot', run: async () => ({ result: 'rebooting — back in a minute or two', after: () => system.priv('reboot') }) },
  'update.check': { label: 'check for updates', run: async () => {
    const x = await priv('update-check');
    return { result: { message: x.stdout.trim().slice(0, 1000), version: pkg.version } };
  } },
  'update.install': { label: 'install the latest release', run: async (r) => {
    await priv('update-install');
    r.slowAt = 0;
    return { result: 'installing — the agent restarts on the new version, and puts this one back if it does not start' };
  } },
  'update.auto': { label: 'install updates automatically, or not', run: async (r, a) => {
    if (typeof a.on !== 'boolean') throw new Error('on: true or false');
    await priv('update-auto', a.on ? 'on' : 'off');
    r.slowAt = 0; r.wantFull = true;
    return { result: 'automatic updates ' + (a.on ? 'on' : 'off') };
  } },
  'access.sync': { label: 'fetch its SSH keys again', run: async (r) => {
    await priv('access-sync');
    r.slowAt = 0; r.wantFull = true;
    return { result: 'fetched' };
  } },
};

// A status that would not fit is cut down, least needed first: most of the
// SSH keys (the count stays), then the settings, then the SSH detail.
function fit(st) {
  const size = (o) => Buffer.byteLength(JSON.stringify(o));
  if (size(st) <= MAX_STATUS_BYTES) return st;
  const out = Object.assign({}, st);
  if (out.access && Array.isArray(out.access.keys) && out.access.keys.length > 10) {
    out.access = Object.assign({}, out.access, { keys: out.access.keys.slice(0, 10), keys_total: out.access.keys.length });
  }
  for (const k of ['config', 'access', 'update']) {
    if (size(out) <= MAX_STATUS_BYTES) break;
    out[k] = { left_out: 'too big for one check-in' };
  }
  if (size(out) > MAX_STATUS_BYTES) out.receivers = out.receivers.slice(0, 8);
  return size(out) <= MAX_STATUS_BYTES ? out : { name: st.name, left_out: 'the status was too big for one check-in' };
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('took longer than ' + ms / 1000 + ' s')), ms); })]).finally(() => clearTimeout(t));
}

const round = (v, d) => v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * Math.pow(10, d || 0)) / Math.pow(10, d || 0);

function tempC() {
  try { return Math.round(Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 100) / 10; } catch (_) { return null; }
}

// The settings as MegaNet sees them: everything but the token (not even masked)
// and the web password's hash.
function remoteConfig(c) {
  const out = JSON.parse(JSON.stringify(c));
  out.meganet = { enabled: c.meganet.enabled, receptions: c.meganet.receptions, tokenSet: !!c.meganet.token, autoRequest: c.meganet.autoRequest };
  out.web = { port: c.web.port, passwordSet: !!c.web.passwordHash };
  if (c.hotspot) out.hotspot = { mode: c.hotspot.mode, ssid: c.hotspot.ssid, passwordSet: !!c.hotspot.password };
  return out;
}

// One receiver, without what changes every second (that is in the heartbeat).
function receiverOf(d) {
  const r = { key: d.key, name: d.name, kind: d.kind, state: d.state, protocol: d.protocol || null, error: d.error || null, point: d.pointId || null };
  if (d.kind === 'sdr') {
    Object.assign(r, { enabled: d.enabled !== false, freq_hz: d.freqHz, format: d.format, gain_db: d.gainDb, ppm: d.ppm || 0, squelch_db: d.squelchDb,
      bias_tee: !!d.biasTee, sample_rate: d.sampleRate, model: d.model || d.tuner || null, serial: d.device.serial || null,
      usb_port: d.device.port || null, own: d.own, last_seen: d.lastSeen || null });
    // A stick hearing more than one channel: each, its own first.
    if (Array.isArray(d.channels) && d.channels.length > 1) {
      r.channels = d.channels.map(ch => ({ freq_hz: ch.freqHz, format: ch.format, in_band: ch.inBand !== false,
        decoded: ch.counts ? ch.counts.decodes || 0 : 0, point: ch.pointId || null }));
    }
  } else {
    const q = d.detail || {};
    Object.assign(r, { port: d.port.byId || d.port.dev, baud: d.port.baud || null, how: d.how || null,
      firmware: q.firmware || (q.legacy ? 'legacy' : null), battery_pct: q.battery ? q.battery.pct : null,
      format: d.kind === 'ert-a2' ? q.format || null : undefined });
  }
  return r;
}

// SSH access, as MegaNet sees it: who may log in and how — fingerprints and
// the keys' own comments, never a key.
function accessOf(a) {
  if (!a) return null;
  if (!a.available) return { available: false, error: a.error || null };
  return { available: true, account: a.account, ssh: a.ssh, policy: a.policy, logins: a.logins,
    keys: (a.keys || []).slice(0, 50).map(k => ({ fingerprint: k.fingerprint, type: k.type, comment: k.comment, source: k.source, restricted: k.restricted })),
    last_sync: a.lastSync ? { at: a.lastSync.at, ok: a.lastSync.ok, notes: (a.lastSync.notes || []).slice(0, 5) } : null };
}

class Remote extends EventEmitter {
  constructor(agent, opts) {
    super();
    opts = opts || {};
    this.agent = agent;
    this.cfg = agent.config;
    this.api = agent.uplink.api;
    this.log = agent.log.child('remote');
    this.timer = null;
    this.stopped = false;
    this.busy = false;
    this.results = [];      // answers waiting to go: { id, ok, result, error }
    this.after = [];        // restarts waiting for their answer to go
    this.history = [];      // the last few things MegaNet asked, for the web page
    this.wantFull = true;
    this.lastSig = '';
    this.lastFullAt = 0;
    this.slow = { update: null, access: null };
    this.slowAt = 0;
    this.lastKeysAsk = 0;
    this.st = { state: 'starting', lastOkAt: null, lastError: '', failures: 0, watch: false, nextAt: null, checkins: 0, label: '' };
    // Tests shorten the waits; a base station uses remote.idleS.
    this.idleMs = opts.idleMs || 0;
    this.firstMs = opts.firstMs != null ? opts.firstMs : 10000;
  }

  start() {
    this.cfg.on('change', (changed) => {
      if (!changed.some(p => p.startsWith('remote.') || p === 'meganet.token')) return;
      // Turned off: one last check-in says so (checkin() below), then nothing.
      if (this.mode() === 'off' && this.st.state === 'off') return;
      this.wantFull = true;
      this.schedule(500);
    });
    // Off from the start: not a word to MegaNet.
    if (this.mode() === 'off') { this.st.state = 'off'; return this; }
    this.schedule(this.firstMs);
    return this;
  }

  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = null; }

  mode() { return this.cfg.get().remote.mode; }

  idle() {
    // ±10 %, so a fleet started by one power cut does not check in in step.
    const ms = this.idleMs || this.cfg.get().remote.idleS * 1000;
    return Math.round(ms * (0.9 + Math.random() * 0.2));
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped) return;
    this.st.nextAt = Date.now() + ms;
    this.timer = setTimeout(() => this.checkin(), ms);
    if (this.timer.unref) this.timer.unref();
  }

  // ── what is sent ──────────────────────────────────────────────────────────

  async refreshSlow(force) {
    if (!force && Date.now() - this.slowAt < SLOW_MS) return;
    this.slowAt = Date.now();
    const [update, access] = await Promise.all([system.updateStatus().catch(() => null), system.accessStatus().catch(() => null)]);
    this.slow = { update, access };
  }

  devices() {
    return this.agent.devices.all().map(s => s.status()).sort((a, b) => (a.kind === 'sdr' ? 0 : 1) - (b.kind === 'sdr' ? 0 : 1) || String(a.name).localeCompare(b.name));
  }

  status(sys, devs) {
    const a = this.agent, c = this.cfg.get();
    const m = a.uplink.status();
    const loc = a.location();
    const clock = a.clock.status();
    return {
      name: a.baseName(),
      host: { hostname: sys.hostname, model: sys.model, os: sys.os, arch: sys.arch, node: sys.node, cores: sys.cores,
        mem_mb: sys.memMb.total, disk_mb: sys.disk ? sys.disk.totalMb : null, addresses: sys.addresses },
      clock: { trusted: clock.trusted, source: clock.source, timezone: clock.timezone },
      location: loc.source === 'none' ? { source: 'none' } : { source: loc.source, lat: round(loc.lat, 5), lon: round(loc.lon, 5),
        accuracy_m: round(loc.accuracy_m), station: loc.station || null },
      meganet: { enabled: c.meganet.enabled, receptions: c.meganet.receptions, label: m.label || null, endpoint: m.endpoint || null,
        token_refused: !!m.tokenRefused, error: m.lastError || null, rx_error: m.rxError || null, report_error: m.reportError || null },
      receivers: devs.map(receiverOf),
      kiosk: { mode: c.kiosk.mode, running: !!a.kiosk.running, display: !!a.kiosk.display },
      audio: { mode: c.audio.enabled ? c.audio.mode : 'off', device: c.audio.device },
      update: this.slow.update,
      access: accessOf(this.slow.access),
      remote: { mode: c.remote.mode, idle_s: c.remote.idleS },
      config: remoteConfig(c),
      survey: a.surveyBrief ? a.surveyBrief() : undefined,
    };
  }

  beat(sys, devs) {
    const a = this.agent, m = a.uplink.status();
    const power = sys.power || {};
    return {
      up: Math.round(os.uptime()), agent_up: Math.round((Date.now() - a.startedAt) / 1000),
      temp: tempC(), load: round(os.loadavg()[0], 2), mem_free: Math.round(os.freemem() / 1048576),
      disk_free: sys.disk ? sys.disk.freeMb : null,
      uv: !!power.underVoltageNow, uv_boot: !!power.underVoltageSinceBoot, throttled: !!(power.throttledNow || power.throttledSinceBoot),
      clock: a.clock.trusted(),
      q: m.queued, hold: m.waitingForClock, rxq: m.receptionsQueued, stored: m.accepted, refused: m.rejected, last_ok: m.lastOkAt,
      readings: a.counts.readings,
      // Each receiver: [key, state, what it has decoded, seconds since it last sent anything].
      rx: devs.slice(0, MAX_RX_IN_BEAT).map(d => [String(d.key).slice(-80), d.state,
        d.kind === 'sdr' ? (d.counts ? d.counts.decodes : 0) : (d.detail && d.detail.counts ? (d.detail.counts.dec || d.detail.counts.readings || 0) : 0),
        d.lastRxAgoMs != null ? Math.round(d.lastRxAgoMs / 1000) : null]),
    };
  }

  async payload(mode) {
    const c = this.cfg.get();
    const p = { v: 1, agent: { app: 'RPi ALERT', version: pkg.version }, mode, idle_s: c.remote.idleS };
    if (mode === 'off') return { p, sig: null };
    await this.refreshSlow(false);
    const sys = await system.info();
    const devs = this.devices();
    p.beat = this.beat(sys, devs);
    if (this.results.length) p.results = this.results.slice(0, MAX_RESULTS);
    const st = fit(this.status(sys, devs));
    const sig = JSON.stringify(st);
    if (this.wantFull || sig !== this.lastSig || Date.now() - this.lastFullAt > FULL_MS) p.status = st;
    const mg = this.slow.access && this.slow.access.sources && this.slow.access.sources.meganet;
    if (mg && mg.hash) p.keys_hash = mg.hash;
    return { p, sig };
  }

  // ── the check-in ──────────────────────────────────────────────────────────

  async checkin() {
    this.timer = null;
    if (this.stopped || this.busy) return;
    const c = this.cfg.get();
    const mode = c.remote.mode;
    if (!c.meganet.token) { this.setState('no-token', ''); return this.schedule(60000); }
    // Turned off: say so once, so MegaNet shows it rather than a station that
    // went quiet, then nothing until it is turned on again.
    if (mode === 'off' && this.st.state === 'off') return;
    this.busy = true;
    let built, res;
    try {
      built = await this.payload(mode);
      res = await this.api.rpc('base_station_checkin', built.p);
    } catch (e) {
      this.busy = false;
      return this.failed('could not reach MegaNet (' + e.message + ')');
    }
    this.busy = false;
    if (res.status === 404 && res.missingFn) {
      this.setState('unsupported', 'MegaNet cannot take check-ins yet (its migration 0049 is not applied); readings are not affected.');
      return this.schedule(MISSING_MS);
    }
    if (res.status === 401 || res.status === 403) {
      this.setState('refused', 'MegaNet refused the ingest token.');
      return this.schedule(REFUSED_MS);
    }
    const b = res.body;
    if (res.status !== 200 || !b || typeof b !== 'object') return this.failed('MegaNet answered ' + res.status + (b && b.message ? ' (' + b.message + ')' : ''));

    // Delivered.
    if (built.p.results) this.results.splice(0, built.p.results.length);
    if (built.p.status) { this.lastSig = built.sig; this.lastFullAt = Date.now(); this.wantFull = false; }
    this.st.failures = 0; this.st.lastOkAt = Date.now(); this.st.checkins++;
    this.st.label = typeof b.label === 'string' ? b.label.slice(0, 120) : this.st.label;
    this.st.watch = !!b.watch;
    if (mode === 'off') { this.setState('off', ''); return; }
    this.setState('ok', '');
    if (b.want_status) this.wantFull = true;
    this.runAfter();
    this.keysAnnounced(b.keys_hash);

    // MegaNet hands over at most ten at a time; any more are answered, not
    // dropped — a request handed over is never left without an answer.
    const cmds = Array.isArray(b.commands) ? b.commands.slice(0, 50) : [];
    for (const [i, cmd] of cmds.entries()) {
      if (i < MAX_RESULTS) await this.execute(cmd);
      else if (Number.isSafeInteger(Number(cmd && cmd.id))) this.results.push({ id: Number(cmd.id), ok: false, error: 'too many requests at once — ask again' });
    }
    if (this.stopped) return;
    let next;
    if (cmds.length || this.results.length || this.wantFull) next = 1000;
    else if (b.watch) next = Math.max(3, Math.min(30, Number(b.next_s) || 5)) * 1000;
    else next = this.idle();
    this.schedule(next);
  }

  failed(why) {
    this.st.failures++;
    this.setState('error', why);
    if (this.st.failures === 3) this.log.warn('remote management: ' + why + ' — trying again');
    // Back off from MegaNet, not from the readings: the uplink keeps its own pace.
    const base = this.st.watch ? 5000 : this.idleMs || this.cfg.get().remote.idleS * 1000;
    this.schedule(Math.min(15 * 60 * 1000, base * Math.pow(2, Math.min(this.st.failures - 1, 4))));
  }

  setState(state, err) {
    const changed = state !== this.st.state || err !== this.st.lastError;
    this.st.state = state; this.st.lastError = err;
    if (changed) this.emit('change');
  }

  // MegaNet's team SSH keys changed, and this Pi takes them: root fetches the
  // list again (the agent only asks — it never handles a key).
  keysAnnounced(hash) {
    const acc = this.slow.access;
    if (!hash || !acc || !acc.available || !acc.policy || !acc.policy.meganetKeys) return;
    const have = acc.sources && acc.sources.meganet && acc.sources.meganet.hash;
    if (have === hash || this.keysBusy || Date.now() - this.lastKeysAsk < 120000) return;
    this.keysBusy = true;
    this.lastKeysAsk = Date.now();
    this.log.info('MegaNet\'s team SSH keys have changed — fetching them');
    system.priv('access-sync').then(() => this.refreshSlow(true)).catch(() => {})
      .finally(() => { this.keysBusy = false; this.wantFull = true; });
  }

  // ── what is asked ─────────────────────────────────────────────────────────

  async execute(cmd) {
    const id = Number(cmd && cmd.id);
    if (!Number.isSafeInteger(id) || this.history.some(h => h.id === id)) return;
    const verb = String((cmd && cmd.verb) || '').slice(0, 40);
    const args = isObj(cmd.args) ? cmd.args : {};
    const v = Object.prototype.hasOwnProperty.call(VERBS, verb) ? VERBS[verb] : null;
    const h = { id, verb, label: v ? v.label : verb, at: Date.now(), ok: false, error: null, detail: verb === 'config.set' && isObj(args.patch) ? paths(args.patch).slice(0, 12).join(', ') : '' };
    this.history.unshift(h);
    if (this.history.length > 20) this.history.length = 20;
    let out;
    if (this.mode() !== 'manage') out = { ok: false, error: 'this base station only reports to MegaNet — its owner has turned requests off (Settings → Remote management)' };
    else if (!v) out = { ok: false, error: 'this base station cannot "' + verb + '" (RPi ALERT ' + pkg.version + ')' };
    else {
      this.log.info('MegaNet asks: ' + v.label + (h.detail ? ' — ' + h.detail : '') + ' (request ' + id + ')');
      try {
        const r = await withTimeout(Promise.resolve(v.run(this, args)), 90000);
        out = { ok: true, result: r && r.result !== undefined ? r.result : null };
        if (r && r.after) this.deferAfter(r.after);
      } catch (e) {
        out = { ok: false, error: String((e && e.message) || e).slice(0, 500) };
      }
    }
    h.ok = out.ok; h.error = out.error || null;
    if (!out.ok) this.log.warn('MegaNet asked to ' + h.label + ', and it was not done: ' + out.error);
    const size = JSON.stringify(out.result === undefined ? null : out.result).length;
    if (size > MAX_RESULT_BYTES) out.result = { truncated: true, note: 'the answer was ' + size + ' bytes — more than a check-in carries' };
    this.results.push(Object.assign({ id }, out));
    this.emit('change');
  }

  // A restart waits for its answer to reach MegaNet — or a minute, if MegaNet
  // has gone quiet: an administrator asked for it.
  deferAfter(fn) {
    const job = { fn, done: false };
    job.timer = setTimeout(() => this.runJob(job), AFTER_MS);
    if (job.timer.unref) job.timer.unref();
    this.after.push(job);
  }

  runAfter() {
    const jobs = this.after.splice(0);
    for (const job of jobs) { clearTimeout(job.timer); setTimeout(() => this.runJob(job), 1500); }
  }

  runJob(job) {
    if (job.done) return;
    job.done = true;
    this.after = this.after.filter(j => j !== job);
    Promise.resolve().then(job.fn).catch((e) => this.log.warn('could not do what MegaNet asked: ' + (e && e.message)));
  }

  // For the web page and `rpi-alert remote`.
  statusForPage() {
    const c = this.cfg.get();
    return Object.assign({ mode: c.remote.mode, idleS: c.remote.idleS }, this.st, { history: this.history.slice(0, 10) });
  }
}

module.exports = { Remote, VERBS, checkPatch, remoteConfig, fit, LOCAL_ONLY, MEGANET_REMOTE };
