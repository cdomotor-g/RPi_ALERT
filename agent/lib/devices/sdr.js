'use strict';
// An RTL-SDR stick (RTL-SDR Blog V2, V3, V4, or any RTL2832U) tuned to the
// ALERT channels it is given and decoding all of them off the air at once.
//
// rtl_sdr (librtlsdr; Raspberry Pi OS Trixie's 2.0.2 knows the Blog V4) streams
// u8 IQ to this process — a slice of the band as wide as the sample rate. Each
// channel in that slice is a receiver of its own (SdrChannel): its own worker
// thread running MegaNet's AlertDsp pipeline on the stick's stream at that
// channel's offset, its own counts and its own MegaNet receiver id. One
// rtl_sdr, one stream, a decoder per channel. sdr-plan.js picks where to tune
// and how fast to sample so that every channel fits, and so that the DC spike
// every RTL2832U has (worst on a zero-IF tuner like the V2's FC0013) — and a
// zero-IF tuner's mirror images — stay off all of them. One channel is tuned
// as it always was: a quarter of the sample rate above the tuner's centre.
//
// Unplugged, crashed, or simply stalled, rtl_sdr is restarted while the stick
// is present: a stall (no samples for ten seconds) is killed; an exit is
// restarted after a pause that grows from 2 s to 30 s.
//
// The SDR hears legacy ALERT (300-baud AFSK): ALERT Binary, Enhanced iFLOWS or
// ALERT ASCII, one format per channel (alert-dsp.js explains why there is no
// "both", and why a frequency is never listed twice, even in two formats).
// Readings go to MegaNet as protocol "alert".
//
// Each stick is a session of its own — its own rtl_sdr — and may have its own
// settings (receivers.sdrDevices, by its key): other channels, format, gain,
// ppm, bias tee. rtl-index.js sees that each rtl_sdr opens the stick it is
// meant to. A stick that is unplugged stays known (and shown) until it comes
// back or is removed.
//
// Its own channel (freqHz) is the stick as a receiver always was — its name,
// its key and its MegaNet receiver id (rpi-<host>-sdr<n>). Each of its more
// channels is a receiver named for its frequency, "<name> · 151.525", with
// the receiver id "rpi-<host>-sdr<n>-151.525" (and -2, -3 after that for a
// frequency listed again, in another format): so a channel keeps its id, and
// MegaNet its history, whatever other channels come and go, and a channel
// moved to another frequency is another receiver. With more than one channel,
// the stick's own is named by its frequency too.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { EventEmitter } = require('node:events');
const { STICK_FIELDS, channelsOf } = require('../config');
const { openedUsb } = require('./rtl-index');
const { plan } = require('./sdr-plan');
const { mhz } = require('../../web/channels');

const STALL_MS = 10000;
const FORMAT_SHORT = { BINARY: 'ABF', ENHANCED_IFLOWS: 'EIF', ASCII: 'ASCII' };
const MAX_RETARGETS = 4;
// Seconds of samples a decoder may fall behind before its input is dropped:
// what one channel always had, shared out among several, never under five.
const BACKLOG_S = 20, BACKLOG_MIN_S = 5;

// One channel the stick listens on: a receiver of its own. id: '' for the
// stick's own channel, else its frequency in MHz ('151.525', '151.525-2').
class SdrChannel {
  constructor(stick, id) {
    this.stick = stick;
    this.agent = stick.agent;
    this.id = id;
    this.k = 1;                 // its place in the stick's list, from 1
    this.kind = 'sdr';
    this.protocol = 'alert';
    this.key = id ? stick.key + '@' + id : stick.key;
    this.point = id ? { pointId: stick.point.pointId + '-' + id, kind: 'sdr', n: stick.point.n, channel: id } : stick.point;
    this.log = id ? stick.agent.log.child('sdr' + stick.point.n + '@' + id) : stick.log;
    this.spec = null;           // { freqHz, format, offsetHz, inBand }: its place in the stick's plan
    this.worker = null;
    this.backlog = 0;
    this.attached = false;      // its MegaNet receiver is registered
    this.moved = false;         // its offset changed since its decoder was last told
    this.blank();
  }

  // What it has heard so far — from scratch when it is moved to another frequency.
  blank() {
    this.level = null;
    this.counts = { bursts: 0, decodes: 0, shadows: 0, undecoded: 0, dropped: 0 };
    this.lastDecode = null;
    this.lastBurst = null;
  }

  name() {
    const chans = this.stick.channels;
    const base = this.stick.name();
    if (chans.length <= 1 || !this.spec) return base;
    const s = this.spec;
    const twin = chans.some(o => o !== this && o.spec && o.spec.freqHz === s.freqHz);
    return base + ' · ' + mhz(s.freqHz) + (twin ? ' ' + FORMAT_SHORT[s.format] : '');
  }

  state() { return this.spec && !this.spec.inBand ? 'out-of-band' : this.stick.state; }

  spawn(dsp, audio) {
    const w = new Worker(path.join(__dirname, 'sdr-worker.js'), { workerData: { cfg: dsp, audio } });
    this.worker = w;
    this.backlog = 0;
    w.on('message', (m) => this.stick.onWorker(this, m));
    w.on('error', (e) => { this.log.error('decoder worker failed: ' + (e && e.stack || e)); });
    w.on('exit', (code) => {
      if (this.worker !== w) return;          // closed on purpose
      this.worker = null;
      if (this.stick.stopped) return;
      this.log.warn('decoder worker exited (' + code + '), restarting it');
      setTimeout(() => this.stick.spawnWorkers(), 1000);
    });
  }

  close() {
    if (!this.worker) return;
    const w = this.worker;
    this.worker = null;
    w.terminate();
  }

  post(m, transfer) { if (this.worker) this.worker.postMessage(m, transfer); }

  // A chunk of the stick's samples. If the decoder cannot keep up (a slow Pi,
  // too many channels at a high sample rate), input is dropped rather than
  // let pile up in memory — and it says so.
  feed(buf, limit) {
    if (this.backlog > limit) {
      this.counts.dropped += buf.length;
      if (this.counts.dropped === buf.length) {
        this.log.warn('the decoder is falling behind; dropping samples (' + (this.stick.channels.length > 1
          ? 'too many channels for this Pi at ' + this.stick.cfg().sampleRate / 1000 + ' ksps — fewer, or closer together' : 'try a 240 ksps sample rate') + ')');
      }
      return;
    }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    this.backlog += buf.length;
    this.worker.postMessage({ type: 'iq', buf: ab }, [ab]);
  }

  onDecode(m) {
    const fmt = FORMAT_SHORT[m.format] || m.format;
    const freq = +(this.spec.freqHz / 1e6).toFixed(4);
    const level = m.burst ? Math.round(m.burst.peakDb * 10) / 10 : null;
    const nf = m.burst ? Math.round(m.burst.nfDb * 10) / 10 : null;
    // Burst peak over the closed-squelch floor it opened on, both in the 12 kHz channel.
    const snr = level != null && nf != null ? Math.round((level - nf) * 10) / 10 : null;
    for (const r of m.readings) {
      this.counts.decodes++;
      this.lastDecode = { t: Date.now(), id: r.sensorId, value: r.value, votes: r.votes, fmt };
      this.agent.deviceReading(this, { alert_id: r.sensorId, value_raw: r.value, protocol: 'alert', fmt, votes: r.votes,
        freq_mhz: freq, level_dbfs: level, nf_dbfs: nf, snr_db: snr, line: 'SDR,' + fmt + ',' + r.sensorId + ',' + r.value + ',votes=' + r.votes + ',hex=' + r.hex.replace(/ /g, '') + ',mhz=' + freq,
        burstKey: 's' + (m.burst ? m.burst.t : Date.now()) });
      this.agent.deviceReception(this, { protocol: 'alert', alert_id: r.sensorId, value_raw: r.value, payload_hex: r.hex.replace(/ /g, ''),
        ok: true, level_dbfs: level, nf_dbm: null, votes: r.votes, detail: { fmt, polarity: r.polarity, carrier_hz: r.carrierHz, crc: r.crcOk, nf_dbfs: nf, snr_db: snr, freq_mhz: freq } });
    }
    for (const s of m.shadows || []) {
      this.counts.shadows++;
      this.agent.deviceReception(this, { protocol: 'alert', alert_id: s.sensorId, value_raw: s.value, ok: false, fault: 'shadow', votes: s.votes,
        level_dbfs: level, detail: { fmt, shadow_of: s.of, freq_mhz: freq } });
    }
    // `all` counts readings before the pipeline drops repeats from overlapping
    // windows: a burst whose readings were all repeats was still decoded.
    if (m.burst && !m.all && !(m.shadows || []).length) {
      this.counts.undecoded++;
      this.agent.deviceReception(this, { protocol: 'alert', alert_id: null, ok: false, fault: 'undecoded', level_dbfs: level,
        detail: { fmt, burst_ms: m.burst.ms, nf_dbfs: nf, freq_mhz: freq } });
    }
  }

  // What report_ingest_point is told about this receiver (agent.describe()).
  detail() {
    const st = this.stick, c = st.cfg(), s = this.spec || { freqHz: c.freqHz, format: c.format };
    const d = { via: 'USB', freq_mhz: +(s.freqHz / 1e6).toFixed(4), format: s.format, sample_rate: c.sampleRate };
    if (st.channels.length > 1) { d.channel = this.k; d.channels = st.channels.length; d.center_mhz = +(c.centerHz / 1e6).toFixed(4); }
    if (st.tuner) d.tuner = st.tuner;
    if (st.model) d.model = st.model;
    if (st.stick.serial) d.serial = st.stick.serial;
    if (st.stick.busPath) d.usb_port = st.stick.busPath;
    return d;
  }

  status(plugged) {
    const lv = this.level, s = this.spec;
    return {
      k: this.k, id: this.id, key: this.key, name: this.name(), pointId: this.point.pointId, state: this.state(),
      freqHz: s.freqHz, format: s.format, offsetHz: s.offsetHz, inBand: s.inBand,
      level: lv && plugged && s.inBand ? { chDb: round(lv.chDb), nfDb: round(lv.nfDb), open: lv.open } : null,
      counts: this.counts, lastDecode: this.lastDecode, lastBurst: this.lastBurst,
    };
  }
}

class SdrSession extends EventEmitter {
  // stick: from scan.js, with its key; absent: a stick remembered, not plugged in.
  constructor(agent, stick, opts) {
    super();
    this.agent = agent;
    this.stick = stick;
    this.key = stick.key;
    this.kind = 'sdr';
    this.protocol = 'alert';
    this.point = agent.state.pointFor(this.key, 'sdr');
    this.log = agent.log.child('sdr' + this.point.n);
    this.state = opts && opts.absent ? 'unplugged' : 'starting';
    this.proc = null;
    this.channels = [];         // SdrChannel, one per channel: the receivers
    this.attachedAll = false;   // plugged in: its channels' MegaNet receivers are registered
    this.pointsSeen = new Set();
    this.restarts = 0;
    this.backoff = 2000;
    this.lastData = 0;
    this.bytesIn = 0;
    this.bytesPerSec = 0;
    this.stderr = [];
    this.tuner = null;
    this.model = null;
    this.spectrum = null;
    this.counts = { restarts: 0 };
    this.stopped = !!(opts && opts.absent);
    this.timer = null;
    this.watch = null;
    this.startedAt = 0;
    this.sel = null;            // how rtl_sdr was pointed at the stick: { arg, index, how }
    this.checked = null;        // true: seen to have opened this stick; false: could not tell
    this.usingIndex = null;     // the device number rtl_sdr said it used
    this.listing = null;        // rtl_sdr's device list, as it prints it
    this.avoid = new Set();     // device numbers just found busy (another stick's)
    this.openFailed = false;
    this.reopen = null;         // why rtl_sdr is being closed to be opened again at once
    this.retargets = 0;
    this.tuned = '';            // the tuner settings rtl_sdr runs with
    this.syncChannels(this.cfg());
  }

  // This stick's own settings: its entry in receivers.sdrDevices, by key — or,
  // as 0.4 wrote them, by serial alone (shared by every stick with it).
  own() {
    const list = this.agent.config.get().receivers.sdrDevices || [];
    return list.find(d => d.key === this.key) || list.find(d => !d.key && d.serial && d.serial === this.stick.serial) || null;
  }

  // The settings for this stick: the shared SDR block, then its own; and the
  // plan for its channels (sdr-plan.js): the sample rate, where to tune, and
  // each channel's offset from there.
  cfg() {
    const all = this.agent.config.get().receivers;
    const own = this.own() || {};
    const c = Object.assign({}, all.sdr);
    for (const f of STICK_FIELDS) if (own[f] !== undefined) c[f] = own[f];
    const b = this.agent.board;
    // 960 ksps (cleaner channel filtering) on a 4-core Pi with 1 GB+; 240 ksps
    // (a quarter of the work) on a Zero 2 W, Pi 1/2 or Zero — unless its
    // channels need more.
    const base = b.cores >= 4 && (!b.memMb || b.memMb >= 900) ? 960000 : 240000;
    c.tune = plan(channelsOf(c, null), { sampleRate: c.sampleRate, baseRate: base, offsetHz: c.offsetHz });
    c.sampleRate = c.tune.sampleRate;
    c.centerHz = c.tune.centerHz;
    if (!c.offsetHz) c.offsetHz = c.sampleRate / 4;
    return c;
  }

  // On, unless the stick is turned off, or RTL-SDR sticks are.
  on() { return this.cfg().enabled !== false && this.agent.config.get().receivers.sdr.enabled !== false; }

  name() {
    const own = this.own();
    return (own && own.name) || 'RTL-SDR' + (this.point.n > 1 ? ' ' + this.point.n : '');
  }

  // ── channels ─────────────────────────────────────────────────────────────

  // The channels as the settings now have them: new ones made, gone ones
  // closed and their MegaNet receivers stood down, each given its place in the
  // plan. The stick's own channel moved to another frequency starts its
  // counts again. No decoders are started here: spawnWorkers() does that for
  // a stick that is running. → whether anything changed.
  syncChannels(c) {
    const want = c.tune.channels;
    const times = new Map();
    const ids = want.map((spec, i) => {
      if (i === 0) return '';
      const f = mhz(spec.freqHz), n = (times.get(f) || 0) + 1;
      times.set(f, n);
      return n > 1 ? f + '-' + n : f;
    });
    const had = new Map(this.channels.map(ch => [ch.id, ch]));
    const next = ids.map(id => had.get(id) || new SdrChannel(this, id));
    let changed = next.length !== this.channels.length || next.some((ch, i) => ch !== this.channels[i]);
    for (const ch of this.channels) {
      if (next.includes(ch)) continue;
      ch.close();
      this.standDown(ch);
      ch.log.info('channel ' + mhz(ch.spec.freqHz) + ' MHz removed');
    }
    this.channels = next;
    next.forEach((ch, i) => {
      const spec = want[i], was = ch.spec;
      ch.k = i + 1;
      if (was && was.freqHz !== spec.freqHz) ch.blank();
      if (was && (was.freqHz !== spec.freqHz || was.offsetHz !== spec.offsetHz || was.inBand !== spec.inBand || was.format !== spec.format)) changed = true;
      if (!was || was.offsetHz !== spec.offsetHz) ch.moved = true;
      ch.spec = spec;
      if (!spec.inBand) { ch.close(); this.standDown(ch); }
      else if (this.attachedAll && !ch.attached) this.attachOne(ch);
    });
    if (changed) {
      for (const ch of next) {
        if (!ch.spec.inBand) ch.log.warn(mhz(ch.spec.freqHz) + ' MHz does not fit beside this stick\'s other channels — not decoded; give it a stick of its own');
      }
    }
    return changed;
  }

  // Decoders for the channels that have none, on a stick that is running.
  spawnWorkers() {
    if (this.stopped || this.state === 'disabled' || this.state === 'unplugged') return;
    const c = this.cfg();
    const audio = this.audioOn();
    for (const ch of this.channels) {
      if (!ch.spec.inBand || ch.worker) continue;
      ch.spawn(this.dspCfg(c, ch.spec), audio);
      ch.moved = false;
    }
  }

  audioOn() { return !!(this.agent.audio && ['auto', 'live'].includes(this.agent.audio.mode())); }

  dspCfg(c, spec) {
    return { deviceRate: c.sampleRate, channelOffsetHz: spec.offsetHz, format: spec.format, gate: c.gate !== false,
      squelchDb: c.squelchDb, minVotes: c.minVotes, minVotesCrc: c.minVotesCrc };
  }

  // Plugged in: each channel's MegaNet receiver registered (the manager calls
  // these as the stick comes and goes).
  attach() {
    this.attachedAll = true;
    for (const ch of this.channels) if (ch.spec.inBand && !ch.attached) this.attachOne(ch);
  }
  detach() {
    this.attachedAll = false;
    for (const ch of this.channels) this.standDown(ch);
  }
  attachOne(ch) {
    ch.attached = true;
    this.pointsSeen.add(ch.point.pointId);
    this.agent.deviceAttached(ch);
  }
  standDown(ch) {
    if (!ch.attached) return;
    ch.attached = false;
    this.agent.deviceDetached(ch);
  }

  // Every MegaNet receiver id this stick has had — to forget them all with it.
  pointIds() { return [...new Set([...this.pointsSeen, ...this.channels.map(ch => ch.point.pointId)])]; }

  // The stick as one receiver, where one is wanted (checking a token): its first channel.
  detail() { return this.channels[0].detail(); }

  // ── rtl_sdr ──────────────────────────────────────────────────────────────

  start() {
    this.stopped = false;
    if (!this.on()) { this.state = 'disabled'; return; }
    const c = this.cfg();
    this.syncChannels(c);
    if (this.state === 'disabled' || this.state === 'unplugged' || this.state === 'stopped') this.state = 'starting';
    this.spawnWorkers();
    // Stopped a moment ago and its rtl_sdr still closing: open again once it has.
    if (this.proc) this.reopen = 'restart';
    this.launch();
    clearInterval(this.watch);
    this.watch = setInterval(() => this.checkStall(), 2000);
  }

  args(c, dev) {
    const a = ['-d', dev, '-f', String(c.centerHz), '-s', String(c.sampleRate)];
    if (c.gainDb != null) a.push('-g', String(c.gainDb));
    if (c.ppm) a.push('-p', String(Math.round(c.ppm)));
    if (c.biasTee) a.push('-T');
    a.push('-b', String(c.sampleRate >= 900000 ? 65536 : 16384), '-');
    return a;
  }

  // What rtl_sdr is told, but which stick: when it changes, rtl_sdr restarts.
  tunerKey(c) { return this.args(c, '').join(' '); }

  launch() {
    if (this.stopped || this.proc) return;
    const c = this.cfg();
    const rtl = this.agent.devices && this.agent.devices.rtl;
    this.sel = rtl ? rtl.choose(this.stick, this.avoid) : { arg: '0', index: 0, how: 'only' };
    const args = this.args(c, this.sel.arg);
    this.tuned = this.tunerKey(c);
    this.bytesPerSec = c.sampleRate * 2;
    this.state = 'starting';
    this.stderr = [];
    this.listing = null; this.usingIndex = null; this.openFailed = false; this.checked = null;
    this.startedAt = Date.now();
    this.lastData = Date.now();
    this.bytesIn = 0;
    const audio = this.audioOn();
    for (const ch of this.channels) {
      if (!ch.worker) continue;
      ch.post({ type: 'reset' });
      ch.post({ type: 'config', cfg: Object.assign(this.dspCfg(c, ch.spec), { audio }) });
      ch.moved = false;
    }
    let p;
    try { p = spawn('rtl_sdr', args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { this.exited(null, e.message); return; }
    this.proc = p;
    const heard = c.tune.channels.filter(ch => ch.inBand);
    this.log.info('rtl_sdr ' + args.join(' ') + '  (' + (heard.length > 1
      ? heard.length + ' channels: ' + heard.map(ch => mhz(ch.freqHz) + ' ' + FORMAT_SHORT[ch.format]).join(', ') + ' MHz'
      : 'channel ' + (c.freqHz / 1e6).toFixed(4) + ' MHz, ' + c.format)
      + (c.tune.raised ? '; ' + c.sampleRate / 1000 + ' ksps to hold them all' : '')
      + (this.sel.how === 'only' ? '' : '; the stick in USB port ' + this.stick.busPath) + ')');
    p.stdout.on('data', (buf) => this.onIq(buf));
    p.stderr.on('data', (d) => this.onStderr(String(d)));
    p.on('error', (e) => { this.stderr.push(e.code === 'ENOENT' ? 'rtl_sdr is not installed (apt install rtl-sdr)' : e.message); });
    p.on('close', (code, sig) => { if (this.proc === p) this.proc = null; this.exited(code, sig); });
  }

  // The stick's samples, to every channel's decoder.
  onIq(buf) {
    if (this.stopped || this.reopen) return;
    this.bytesIn += buf.length;
    this.lastData = Date.now();
    if (this.state !== 'running') {
      this.checkStick();
      if (this.reopen) return;
      this.state = 'running'; this.backoff = 2000; this.avoid.clear();
      this.log.info('receiving' + (this.tuner ? ' (' + this.tuner + ')' : ''));
      this.emit('change');
    }
    const live = this.channels.filter(ch => ch.worker);
    const limit = this.bytesPerSec * Math.max(BACKLOG_MIN_S, BACKLOG_S / Math.max(1, live.length));
    for (const ch of live) ch.feed(buf, limit);
  }

  // rtl_sdr is streaming: is it this stick? (rtl-index.js)
  checkStick() {
    const mgr = this.agent.devices;
    if (!mgr || !mgr.rtl || !this.proc || !this.sel || this.sel.how === 'only') return;
    const index = this.usingIndex != null ? this.usingIndex : this.sel.index;
    const at = openedUsb(this.proc.pid);
    const st = at && mgr.sticks.find(s => s.busnum === at.busnum && s.devnum === at.devnum);
    if (!st) { this.checked = false; return; }                 // cannot tell: trust the choice
    if (index != null) mgr.rtl.learn(index, st.busPath);
    if (st.busPath === this.stick.busPath) { this.checked = true; this.retargets = 0; return; }
    if (++this.retargets > MAX_RETARGETS) {
      this.checked = false;
      this.log.error('rtl_sdr keeps opening the stick in USB port ' + st.busPath + ' instead of this one (' + this.stick.busPath + '); using it. Give each stick its own serial: rtl_eeprom -d <n> -s <name>');
      return;
    }
    this.log.warn('rtl_sdr device ' + index + ' is the stick in USB port ' + st.busPath + ', not this one (' + this.stick.busPath + ') — reopening');
    this.reopen = 'retarget';
    try { this.proc.kill('SIGTERM'); } catch (_) {}
  }

  onStderr(s) {
    for (const line of s.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      this.stderr.push(t);
      if (this.stderr.length > 30) this.stderr.shift();
      let m;
      if (/^Found \d+ device\(s\)/.test(t)) { this.listing = []; continue; }
      if (this.listing && (m = /^(\d+):\s+(.*)$/.exec(t))) { this.listing.push({ index: Number(m[1]), text: m[2].trim() }); continue; }
      if ((m = /^Found (.+) tuner/.exec(t))) this.tuner = m[1];
      if (/Blog V4/i.test(t)) this.model = 'RTL-SDR Blog V4';
      if ((m = /^Using device (\d+): (.+)$/.exec(t))) {
        this.usingIndex = Number(m[1]);
        this.model = this.model || m[2];
        const rtl = this.agent.devices && this.agent.devices.rtl;
        if (rtl && this.listing) rtl.listing(this.listing);
        this.listing = null;
      }
      if (/usb_claim_interface error|Failed to open rtlsdr device/i.test(t)) this.openFailed = true;
      // A guessed device number is often another stick of ours, held by its own rtl_sdr.
      const guessing = this.sel && this.sel.how === 'guess';
      if (/Kernel driver is active/i.test(t) || (!guessing && /usb_claim_interface error/i.test(t))) this.log.warn('the stick is held by another driver or program — is the DVB-T module blacklisted, or rtl_tcp/SDR++ running?');
    }
  }

  exited(code, sig) {
    clearTimeout(this.timer);
    if (this.stopped) { if (['running', 'starting', 'restarting'].includes(this.state)) this.state = 'stopped'; this.reopen = null; return; }
    // Closed on purpose, to open again at once: the wrong stick, new tuner settings, Restart.
    if (this.reopen) {
      this.reopen = null;
      this.state = 'starting';
      this.timer = setTimeout(() => this.launch(), 300);
      this.emit('change');
      return;
    }
    // A guessed device number that was busy is most likely another of our
    // sticks: try the next number at once, before backing off.
    const sticks = this.agent.devices ? this.agent.devices.sticks.length : 1;
    if (this.openFailed && this.sel && this.sel.how === 'guess') {
      this.avoid.add(this.sel.index);
      if (this.avoid.size < sticks) {
        this.state = 'starting';
        this.log.info('rtl_sdr device ' + this.sel.index + ' is in use (another stick, most likely) — trying another');
        this.timer = setTimeout(() => this.launch(), 1000);
        return;
      }
      this.avoid.clear();
    }
    const tail = this.stderr.slice(-3).join(' | ');
    this.state = 'restarting';
    this.counts.restarts++;
    this.log.warn('rtl_sdr stopped (' + (sig || 'exit ' + code) + ')' + (tail ? ': ' + tail : '') + ' — restarting in ' + Math.round(this.backoff / 1000) + ' s');
    this.emit('change');
    this.timer = setTimeout(() => this.launch(), this.backoff);
    this.backoff = Math.min(30000, this.backoff * 2);
  }

  checkStall() {
    if (this.proc && Date.now() - this.lastData > STALL_MS) {
      this.log.warn('no samples for ' + Math.round(STALL_MS / 1000) + ' s — restarting rtl_sdr');
      this.lastData = Date.now();
      try { this.proc.kill('SIGKILL'); } catch (_) {}
    }
  }

  // From one channel's decoder.
  onWorker(ch, m) {
    if (m.type === 'fed') { ch.backlog = Math.max(0, ch.backlog - m.bytes); return; }
    if (m.type === 'level') { ch.level = m.level; return; }
    // The whole slice is the same for every channel: drawn from the first.
    if (m.type === 'spectrum') { if (ch === this.channels.find(x => x.worker)) this.spectrum = m; return; }
    if (m.type === 'audio') { this.agent.audio && this.agent.audio.live(m.pcm, m.rate); return; }
    if (m.type === 'error') { ch.log.error('decoder: ' + m.message); return; }
    if (m.type === 'burst') {
      ch.counts.bursts++;
      const peak = round(m.peakDb), nf = round(m.nfDb);
      ch.lastBurst = { t: Date.now(), ms: m.ms, peakDb: peak, nfDb: nf, snrDb: peak != null && nf != null ? round(peak - nf) : null };
      this.agent.deviceEvent(ch, 'burst', { ms: m.ms, peakDb: m.peakDb, nfDb: m.nfDb });
      return;
    }
    if (m.type === 'decode') ch.onDecode(m);
  }

  // Settings changed. Format and squelch go to the decoders as they are, and
  // a channel added or removed starts or stops its decoder; where to tune,
  // the rate, gain, ppm and bias tee are the tuner's, and restart rtl_sdr —
  // this stick's only, and only when they changed for it.
  reconfigure() {
    if (this.state === 'unplugged') { this.syncChannels(this.cfg()); return; }
    if (!this.on()) {
      if (this.state !== 'disabled') { this.stop(); this.state = 'disabled'; this.log.info('turned off'); this.emit('change'); }
      return;
    }
    if (this.stopped || this.state === 'disabled') { this.log.info('turned on'); this.start(); this.emit('change'); return; }
    const c = this.cfg();
    const changed = this.syncChannels(c);
    this.spawnWorkers();
    const retune = this.tunerKey(c) !== this.tuned;
    if (changed) this.emit('change');
    if (retune) {
      // The decoders finish what they hold as they were; launch() starts each
      // afresh at its new offset once rtl_sdr is tuned to match.
      if (this.proc) { this.log.info('new tuner settings — restarting rtl_sdr'); this.reopen = 'settings'; try { this.proc.kill('SIGTERM'); } catch (_) {} }
      return;
    }
    const audio = this.audioOn();
    for (const ch of this.channels) {
      if (!ch.worker) continue;
      // A channel moved under a running rtl_sdr: what its decoder holds is another frequency's.
      if (ch.moved) ch.post({ type: 'reset' });
      ch.moved = false;
      ch.post({ type: 'config', cfg: Object.assign(this.dspCfg(c, ch.spec), { audio }) });
    }
  }

  // The Restart button: rtl_sdr closed and opened again now.
  restart() {
    if (this.state === 'unplugged') return;
    clearTimeout(this.timer);
    this.backoff = 2000; this.avoid.clear(); this.retargets = 0;
    if (this.stopped || this.state === 'disabled') { this.start(); return; }
    if (this.proc) { this.log.info('restarting rtl_sdr'); this.reopen = 'restart'; try { this.proc.kill('SIGTERM'); } catch (_) {} return; }
    this.launch();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer); clearInterval(this.watch);
    if (this.proc) { try { this.proc.kill('SIGTERM'); } catch (_) {} }
    for (const ch of this.channels) ch.close();
    this.state = 'stopped';
  }

  status() {
    const c = this.cfg();
    const st = this.stick;
    const own = this.own() || {};
    const info = this.agent.state.sdrInfo(this.key);
    const plugged = this.state !== 'unplugged';
    const first = this.channels[0];
    const lv = first && first.level;
    // The stick's counts are its channels' together.
    const counts = { bursts: 0, decodes: 0, shadows: 0, undecoded: 0, restarts: this.counts.restarts, dropped: 0 };
    for (const ch of this.channels) for (const k of ['bursts', 'decodes', 'shadows', 'undecoded', 'dropped']) counts[k] += ch.counts[k];
    const latest = (f) => this.channels.map(ch => ch[f]).filter(Boolean).sort((a, b) => b.t - a.t)[0] || null;
    return {
      key: this.key, kind: 'sdr', name: this.name(), n: this.point.n, pointId: this.point.pointId, state: this.state, protocol: 'alert',
      present: plugged, lastSeen: info && info.lastSeen ? Date.parse(info.lastSeen) : null, enabled: this.on(),
      device: { serial: st.serial, product: st.product, manufacturer: st.manufacturer, usb: st.vid + ':' + st.pid, port: st.busPath, index: st.index != null ? st.index : null },
      opened: this.sel && plugged ? { arg: this.sel.arg, index: this.usingIndex != null ? this.usingIndex : this.sel.index, how: this.sel.how, checked: this.checked } : null,
      own: STICK_FIELDS.filter(f => own[f] !== undefined).concat(own.name ? ['name'] : []),
      tuner: this.tuner, model: this.model,
      freqHz: c.freqHz, sampleRate: c.sampleRate, centerHz: c.centerHz, gainDb: c.gainDb, squelchDb: c.squelchDb, format: c.format, ppm: c.ppm, biasTee: !!c.biasTee,
      tune: { raised: c.tune.raised, dcHz: c.tune.dcHz, mirrorHz: c.tune.mirrorHz },
      channels: this.channels.map(ch => ch.status(plugged)),
      level: lv && plugged ? { dbfs: round(lv.dbfs), clipPct: round(lv.clipPct, 2), chDb: round(lv.chDb), nfDb: round(lv.nfDb), open: lv.open } : null,
      spectrum: this.spectrum && plugged ? { db: this.spectrum.db, rate: this.spectrum.rate, centerHz: c.centerHz, channelHz: c.freqHz,
        channelsHz: this.channels.filter(ch => ch.spec.inBand).map(ch => ch.spec.freqHz) } : null,
      counts, lastDecode: latest('lastDecode'), lastBurst: latest('lastBurst'), stderr: this.stderr.slice(-5),
      rateKsps: this.startedAt && this.state === 'running' ? Math.round(this.bytesIn / 2 / Math.max(1, (Date.now() - this.startedAt) / 1000) / 1000) : 0,
      startedAt: this.startedAt || null,
    };
  }
}

function round(v, d) { if (v == null || !Number.isFinite(v)) return null; const k = Math.pow(10, d == null ? 1 : d); return Math.round(v * k) / k; }

module.exports = { SdrSession, SdrChannel };
