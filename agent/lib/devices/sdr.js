'use strict';
// An RTL-SDR stick (RTL-SDR Blog V2, V3, V4, or any RTL2832U) tuned to an
// ALERT channel and decoding it off the air.
//
// rtl_sdr (librtlsdr; Raspberry Pi OS Trixie's 2.0.2 knows the Blog V4) streams
// u8 IQ to this process; MegaNet's AlertDsp pipeline decodes it in a worker.
// The stick is tuned off-centre — the channel sits a quarter of the sample
// rate above the tuner's centre — so the DC spike every RTL2832U has (worst on
// a zero-IF tuner like the V2's FC0013) never lands on the burst.
//
// Unplugged, crashed, or simply stalled, rtl_sdr is restarted while the stick
// is present: a stall (no samples for ten seconds) is killed; an exit is
// restarted after a pause that grows from 2 s to 30 s.
//
// The SDR hears legacy ALERT (300-baud AFSK): ALERT Binary, Enhanced iFLOWS or
// ALERT ASCII, one format at a time (alert-dsp.js explains why there is no
// "both"). Readings go to MegaNet as protocol "alert".
//
// Each stick is a receiver of its own — its own rtl_sdr, decoder thread and
// MegaNet receiver id — and may have its own settings (receivers.sdrDevices,
// by its key): another channel, format, gain, ppm, bias tee. rtl-index.js
// sees that each rtl_sdr opens the stick it is meant to. A stick that is
// unplugged stays known (and shown) until it comes back or is removed.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { EventEmitter } = require('node:events');
const { STICK_FIELDS } = require('../config');
const { openedUsb } = require('./rtl-index');

const STALL_MS = 10000;
const FORMAT_SHORT = { BINARY: 'ABF', ENHANCED_IFLOWS: 'EIF', ASCII: 'ASCII' };
const MAX_RETARGETS = 4;

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
    this.worker = null;
    this.restarts = 0;
    this.backoff = 2000;
    this.lastData = 0;
    this.bytesIn = 0;
    this.backlog = 0;
    this.stderr = [];
    this.tuner = null;
    this.model = null;
    this.level = null;
    this.spectrum = null;
    this.counts = { bursts: 0, decodes: 0, shadows: 0, undecoded: 0, restarts: 0, dropped: 0 };
    this.lastDecode = null;
    this.lastBurst = null;
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
  }

  // This stick's own settings: its entry in receivers.sdrDevices, by key — or,
  // as 0.4 wrote them, by serial alone (shared by every stick with it).
  own() {
    const list = this.agent.config.get().receivers.sdrDevices || [];
    return list.find(d => d.key === this.key) || list.find(d => !d.key && d.serial && d.serial === this.stick.serial) || null;
  }

  // The settings for this stick: the shared SDR block, then its own.
  cfg() {
    const all = this.agent.config.get().receivers;
    const own = this.own() || {};
    const c = Object.assign({}, all.sdr);
    for (const f of STICK_FIELDS) if (own[f] !== undefined) c[f] = own[f];
    const b = this.agent.board;
    // 960 ksps (cleaner channel filtering) on a 4-core Pi with 1 GB+; 240 ksps
    // (a quarter of the work) on a Zero 2 W, Pi 1/2 or Zero.
    if (!c.sampleRate) c.sampleRate = b.cores >= 4 && (!b.memMb || b.memMb >= 900) ? 960000 : 240000;
    if (!c.offsetHz) c.offsetHz = c.sampleRate / 4;
    return c;
  }

  // On, unless the stick is turned off, or RTL-SDR sticks are.
  on() { return this.cfg().enabled !== false && this.agent.config.get().receivers.sdr.enabled !== false; }

  name() {
    const own = this.own();
    return (own && own.name) || 'RTL-SDR' + (this.point.n > 1 ? ' ' + this.point.n : '');
  }

  start() {
    this.stopped = false;
    if (!this.on()) { this.state = 'disabled'; return; }
    if (!this.worker) this.spawnWorker(this.cfg());
    // Stopped a moment ago and its rtl_sdr still closing: open again once it has.
    if (this.proc) this.reopen = 'restart';
    this.launch();
    clearInterval(this.watch);
    this.watch = setInterval(() => this.checkStall(), 2000);
  }

  spawnWorker(c) {
    const audio = this.agent.audio && ['auto', 'live'].includes(this.agent.audio.mode());
    this.worker = new Worker(path.join(__dirname, 'sdr-worker.js'), { workerData: { cfg: this.dspCfg(c), audio } });
    this.worker.on('message', (m) => this.onWorker(m));
    this.worker.on('error', (e) => { this.log.error('decoder worker failed: ' + (e && e.stack || e)); });
    this.worker.on('exit', (code) => {
      this.worker = null;
      if (!this.stopped) { this.log.warn('decoder worker exited (' + code + '), restarting it'); setTimeout(() => { if (!this.stopped) this.spawnWorker(this.cfg()); }, 1000); }
    });
  }

  dspCfg(c) {
    return { deviceRate: c.sampleRate, channelOffsetHz: c.offsetHz, format: c.format, gate: c.gate !== false,
      squelchDb: c.squelchDb, minVotes: c.minVotes, minVotesCrc: c.minVotesCrc };
  }

  args(c, dev) {
    const center = Math.round(c.freqHz - c.offsetHz);
    const a = ['-d', dev, '-f', String(center), '-s', String(c.sampleRate)];
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
    this.state = 'starting';
    this.stderr = [];
    this.listing = null; this.usingIndex = null; this.openFailed = false; this.checked = null;
    this.startedAt = Date.now();
    this.lastData = Date.now();
    this.bytesIn = 0;
    this.worker && this.worker.postMessage({ type: 'reset' });
    this.worker && this.worker.postMessage({ type: 'config', cfg: this.dspCfg(c) });
    let p;
    try { p = spawn('rtl_sdr', args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { this.exited(null, e.message); return; }
    this.proc = p;
    this.log.info('rtl_sdr ' + args.join(' ') + '  (channel ' + (c.freqHz / 1e6).toFixed(4) + ' MHz, ' + c.format
      + (this.sel.how === 'only' ? '' : '; the stick in USB port ' + this.stick.busPath) + ')');
    p.stdout.on('data', (buf) => this.onIq(buf));
    p.stderr.on('data', (d) => this.onStderr(String(d)));
    p.on('error', (e) => { this.stderr.push(e.code === 'ENOENT' ? 'rtl_sdr is not installed (apt install rtl-sdr)' : e.message); });
    p.on('close', (code, sig) => { if (this.proc === p) this.proc = null; this.exited(code, sig); });
  }

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
    if (!this.worker) return;
    // If the decoder cannot keep up (a slow Pi at a high sample rate), drop
    // input rather than let it pile up in memory — and say so.
    const rate = this.cfg().sampleRate * 2;
    if (this.backlog > rate * 20) { this.counts.dropped += buf.length; if (this.counts.dropped === buf.length) this.log.warn('the decoder is falling behind; dropping samples (try a 240 ksps sample rate)'); return; }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    this.backlog += buf.length;
    this.worker.postMessage({ type: 'iq', buf: ab }, [ab]);
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

  onWorker(m) {
    if (m.type === 'fed') { this.backlog = Math.max(0, this.backlog - m.bytes); return; }
    if (m.type === 'level') { this.level = m.level; return; }
    if (m.type === 'spectrum') { this.spectrum = m; return; }
    if (m.type === 'audio') { this.agent.audio && this.agent.audio.live(m.pcm, m.rate); return; }
    if (m.type === 'error') { this.log.error('decoder: ' + m.message); return; }
    if (m.type === 'burst') {
      this.counts.bursts++;
      const peak = round(m.peakDb), nf = round(m.nfDb);
      this.lastBurst = { t: Date.now(), ms: m.ms, peakDb: peak, nfDb: nf, snrDb: peak != null && nf != null ? round(peak - nf) : null };
      this.agent.deviceEvent(this, 'burst', { ms: m.ms, peakDb: m.peakDb, nfDb: m.nfDb });
      return;
    }
    if (m.type === 'decode') this.onDecode(m);
  }

  onDecode(m) {
    const fmt = FORMAT_SHORT[m.format] || m.format;
    const level = m.burst ? Math.round(m.burst.peakDb * 10) / 10 : null;
    const nf = m.burst ? Math.round(m.burst.nfDb * 10) / 10 : null;
    // Burst peak over the closed-squelch floor it opened on, both in the 12 kHz channel.
    const snr = level != null && nf != null ? Math.round((level - nf) * 10) / 10 : null;
    for (const r of m.readings) {
      this.counts.decodes++;
      this.lastDecode = { t: Date.now(), id: r.sensorId, value: r.value, votes: r.votes, fmt };
      this.agent.deviceReading(this, { alert_id: r.sensorId, value_raw: r.value, protocol: 'alert', fmt, votes: r.votes,
        level_dbfs: level, nf_dbfs: nf, snr_db: snr, line: 'SDR,' + fmt + ',' + r.sensorId + ',' + r.value + ',votes=' + r.votes + ',hex=' + r.hex.replace(/ /g, ''),
        burstKey: 's' + (m.burst ? m.burst.t : Date.now()) });
      this.agent.deviceReception(this, { protocol: 'alert', alert_id: r.sensorId, value_raw: r.value, payload_hex: r.hex.replace(/ /g, ''),
        ok: true, level_dbfs: level, nf_dbm: null, votes: r.votes, detail: { fmt, polarity: r.polarity, carrier_hz: r.carrierHz, crc: r.crcOk, nf_dbfs: nf, snr_db: snr } });
    }
    for (const s of m.shadows || []) {
      this.counts.shadows++;
      this.agent.deviceReception(this, { protocol: 'alert', alert_id: s.sensorId, value_raw: s.value, ok: false, fault: 'shadow', votes: s.votes,
        level_dbfs: level, detail: { fmt, shadow_of: s.of } });
    }
    // `all` counts readings before the pipeline drops repeats from overlapping
    // windows: a burst whose readings were all repeats was still decoded.
    if (m.burst && !m.all && !(m.shadows || []).length) {
      this.counts.undecoded++;
      this.agent.deviceReception(this, { protocol: 'alert', alert_id: null, ok: false, fault: 'undecoded', level_dbfs: level,
        detail: { fmt, burst_ms: m.burst.ms, nf_dbfs: nf } });
    }
  }

  // Settings changed. Format, squelch and votes go to the decoder as they
  // are; frequency, rate, gain, ppm and bias tee are the tuner's, and restart
  // rtl_sdr — this stick's only, and only when they changed for it.
  reconfigure() {
    if (this.state === 'unplugged') return;
    if (!this.on()) {
      if (this.state !== 'disabled') { this.stop(); this.state = 'disabled'; this.log.info('turned off'); this.emit('change'); }
      return;
    }
    if (this.stopped || this.state === 'disabled') { this.log.info('turned on'); this.start(); this.emit('change'); return; }
    const c = this.cfg();
    if (this.worker) this.worker.postMessage({ type: 'config', cfg: Object.assign(this.dspCfg(c), { audio: !!(this.agent.audio && ['auto', 'live'].includes(this.agent.audio.mode())) }) });
    if (this.tunerKey(c) === this.tuned) return;
    if (this.proc) { this.log.info('new tuner settings — restarting rtl_sdr'); this.reopen = 'settings'; try { this.proc.kill('SIGTERM'); } catch (_) {} }
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
    if (this.worker) { const w = this.worker; this.worker = null; w.terminate(); }
    this.state = 'stopped';
  }

  status() {
    const c = this.cfg();
    const lv = this.level;
    const st = this.stick;
    const own = this.own() || {};
    const info = this.agent.state.sdrInfo(this.key);
    return {
      key: this.key, kind: 'sdr', name: this.name(), n: this.point.n, pointId: this.point.pointId, state: this.state, protocol: 'alert',
      present: this.state !== 'unplugged', lastSeen: info && info.lastSeen ? Date.parse(info.lastSeen) : null, enabled: this.on(),
      device: { serial: st.serial, product: st.product, manufacturer: st.manufacturer, usb: st.vid + ':' + st.pid, port: st.busPath, index: st.index != null ? st.index : null },
      opened: this.sel && this.state !== 'unplugged' ? { arg: this.sel.arg, index: this.usingIndex != null ? this.usingIndex : this.sel.index, how: this.sel.how, checked: this.checked } : null,
      own: STICK_FIELDS.filter(f => own[f] !== undefined).concat(own.name ? ['name'] : []),
      tuner: this.tuner, model: this.model,
      freqHz: c.freqHz, sampleRate: c.sampleRate, gainDb: c.gainDb, squelchDb: c.squelchDb, format: c.format, ppm: c.ppm, biasTee: !!c.biasTee,
      level: lv && this.state !== 'unplugged' ? { dbfs: round(lv.dbfs), clipPct: round(lv.clipPct, 2), chDb: round(lv.chDb), nfDb: round(lv.nfDb), open: lv.open } : null,
      spectrum: this.spectrum && this.state !== 'unplugged' ? { db: this.spectrum.db, rate: this.spectrum.rate, centerHz: Math.round(c.freqHz - c.offsetHz), channelHz: c.freqHz } : null,
      counts: this.counts, lastDecode: this.lastDecode, lastBurst: this.lastBurst, stderr: this.stderr.slice(-5),
      rateKsps: this.startedAt && this.state === 'running' ? Math.round(this.bytesIn / 2 / Math.max(1, (Date.now() - this.startedAt) / 1000) / 1000) : 0,
      startedAt: this.startedAt || null,
    };
  }

  detail() {
    const c = this.cfg();
    const d = { via: 'USB', freq_mhz: +(c.freqHz / 1e6).toFixed(4), format: c.format, sample_rate: c.sampleRate };
    if (this.tuner) d.tuner = this.tuner;
    if (this.model) d.model = this.model;
    if (this.stick.serial) d.serial = this.stick.serial;
    if (this.stick.busPath) d.usb_port = this.stick.busPath;
    return d;
  }
}

function round(v, d) { if (v == null || !Number.isFinite(v)) return null; const k = Math.pow(10, d == null ? 1 : d); return Math.round(v * k) / k; }

module.exports = { SdrSession };
