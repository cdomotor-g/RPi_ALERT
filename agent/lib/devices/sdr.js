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

const path = require('node:path');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { EventEmitter } = require('node:events');

const STALL_MS = 10000;
const FORMAT_SHORT = { BINARY: 'ABF', ENHANCED_IFLOWS: 'EIF', ASCII: 'ASCII' };

class SdrSession extends EventEmitter {
  constructor(agent, stick) {
    super();
    this.agent = agent;
    this.stick = stick;
    this.key = stick.key;
    this.kind = 'sdr';
    this.protocol = 'alert';
    this.log = agent.log.child('sdr' + (stick.index || 0));
    this.state = 'starting';
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
    this.stopped = false;
    this.timer = null;
    this.watch = null;
    this.point = agent.state.pointFor(this.key, 'sdr');
    this.startedAt = 0;
  }

  // The settings for this stick: the shared SDR block, then its own overrides.
  cfg() {
    const all = this.agent.config.get().receivers;
    const own = (all.sdrDevices || []).find(d => d.serial && d.serial === this.stick.serial) || {};
    const c = Object.assign({}, all.sdr, own);
    const b = this.agent.board;
    // 960 ksps (cleaner channel filtering) on a 4-core Pi with 1 GB+; 240 ksps
    // (a quarter of the work) on a Zero 2 W, Pi 1/2 or Zero.
    if (!c.sampleRate) c.sampleRate = b.cores >= 4 && (!b.memMb || b.memMb >= 900) ? 960000 : 240000;
    if (!c.offsetHz) c.offsetHz = c.sampleRate / 4;
    return c;
  }

  name() {
    const own = (this.agent.config.get().receivers.sdrDevices || []).find(d => d.serial && d.serial === this.stick.serial);
    return (own && own.name) || 'RTL-SDR' + (this.point.n > 1 ? ' ' + this.point.n : '');
  }

  start() {
    this.stopped = false;
    const c = this.cfg();
    if (c.enabled === false || !this.agent.config.get().receivers.sdr.enabled) { this.state = 'disabled'; return; }
    if (!this.worker) this.spawnWorker(c);
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

  args(c) {
    const center = Math.round(c.freqHz - c.offsetHz);
    // One stick: index 0. Several: the serial when it is unique and cannot be
    // mistaken for an index (librtlsdr reads "00000001" as device 1 first),
    // else the enumeration index.
    const sticks = this.agent.devices ? this.agent.devices.sdrCount() : 1;
    const dev = sticks <= 1 ? '0' : (this.key.startsWith('sdr-serial:') && /\D/.test(this.stick.serial) ? this.stick.serial : String(this.stick.index));
    const a = ['-d', dev, '-f', String(center), '-s', String(c.sampleRate)];
    if (c.gainDb != null) a.push('-g', String(c.gainDb));
    if (c.ppm) a.push('-p', String(Math.round(c.ppm)));
    if (c.biasTee) a.push('-T');
    a.push('-b', String(c.sampleRate >= 900000 ? 65536 : 16384), '-');
    return a;
  }

  launch() {
    if (this.stopped || this.proc) return;
    const c = this.cfg();
    const args = this.args(c);
    this.state = 'starting';
    this.stderr = [];
    this.startedAt = Date.now();
    this.lastData = Date.now();
    this.worker && this.worker.postMessage({ type: 'reset' });
    this.worker && this.worker.postMessage({ type: 'config', cfg: this.dspCfg(c) });
    let p;
    try { p = spawn('rtl_sdr', args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { this.exited(null, e.message); return; }
    this.proc = p;
    this.log.info('rtl_sdr ' + args.join(' ') + '  (channel ' + (c.freqHz / 1e6).toFixed(4) + ' MHz, ' + c.format + ')');
    p.stdout.on('data', (buf) => this.onIq(buf));
    p.stderr.on('data', (d) => this.onStderr(String(d)));
    p.on('error', (e) => { this.stderr.push(e.code === 'ENOENT' ? 'rtl_sdr is not installed (apt install rtl-sdr)' : e.message); });
    p.on('close', (code, sig) => { this.proc = null; this.exited(code, sig); });
  }

  onIq(buf) {
    this.bytesIn += buf.length;
    this.lastData = Date.now();
    if (this.state !== 'running') { this.state = 'running'; this.backoff = 2000; this.log.info('receiving' + (this.tuner ? ' (' + this.tuner + ')' : '')); this.emit('change'); }
    if (!this.worker) return;
    // If the decoder cannot keep up (a slow Pi at a high sample rate), drop
    // input rather than let it pile up in memory — and say so.
    const rate = this.cfg().sampleRate * 2;
    if (this.backlog > rate * 20) { this.counts.dropped += buf.length; if (this.counts.dropped === buf.length) this.log.warn('the decoder is falling behind; dropping samples (try a 240 ksps sample rate)'); return; }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    this.backlog += buf.length;
    this.worker.postMessage({ type: 'iq', buf: ab }, [ab]);
  }

  onStderr(s) {
    for (const line of s.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      this.stderr.push(t);
      if (this.stderr.length > 30) this.stderr.shift();
      let m;
      if ((m = /^Found (.+) tuner/.exec(t))) this.tuner = m[1];
      if (/Blog V4/i.test(t)) this.model = 'RTL-SDR Blog V4';
      if ((m = /^Using device \d+: (.+)$/.exec(t))) this.model = this.model || m[1];
      if (/usb_claim_interface error|Kernel driver is active/i.test(t)) this.log.warn('the stick is held by another driver or program — is the DVB-T module blacklisted, or rtl_tcp/SDR++ running?');
    }
  }

  exited(code, sig) {
    if (this.stopped) { if (this.state !== 'unplugged') this.state = 'stopped'; return; }
    const tail = this.stderr.slice(-3).join(' | ');
    this.state = 'restarting';
    this.counts.restarts++;
    this.log.warn('rtl_sdr stopped (' + (sig || 'exit ' + code) + ')' + (tail ? ': ' + tail : '') + ' — restarting in ' + Math.round(this.backoff / 1000) + ' s');
    this.emit('change');
    clearTimeout(this.timer);
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

  reconfigure() {
    const c = this.cfg();
    if (!c.enabled || !this.agent.config.get().receivers.sdr.enabled) { this.stop(); this.state = 'disabled'; return; }
    if (this.worker) this.worker.postMessage({ type: 'config', cfg: Object.assign(this.dspCfg(c), { audio: this.agent.audio && ['auto', 'live'].includes(this.agent.audio.mode()) }) });
    // Frequency, rate, gain and bias tee are the tuner's: restart rtl_sdr with them.
    if (this.proc) { this.backoff = 1000; this.log.info('new settings — restarting rtl_sdr'); try { this.proc.kill('SIGTERM'); } catch (_) {} }
    else if (this.stopped || this.state === 'disabled') this.start();
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
    return {
      key: this.key, kind: 'sdr', name: this.name(), pointId: this.point.pointId, state: this.state, protocol: 'alert',
      device: { serial: this.stick.serial, product: this.stick.product, manufacturer: this.stick.manufacturer, usb: this.stick.vid + ':' + this.stick.pid, index: this.stick.index },
      tuner: this.tuner, model: this.model,
      freqHz: c.freqHz, sampleRate: c.sampleRate, gainDb: c.gainDb, squelchDb: c.squelchDb, format: c.format, ppm: c.ppm, biasTee: !!c.biasTee,
      level: lv ? { dbfs: round(lv.dbfs), clipPct: round(lv.clipPct, 2), chDb: round(lv.chDb), nfDb: round(lv.nfDb), open: lv.open } : null,
      spectrum: this.spectrum ? { db: this.spectrum.db, rate: this.spectrum.rate, centerHz: Math.round(c.freqHz - c.offsetHz), channelHz: c.freqHz } : null,
      counts: this.counts, lastDecode: this.lastDecode, lastBurst: this.lastBurst, stderr: this.stderr.slice(-5),
      rateKsps: this.startedAt ? Math.round(this.bytesIn / 2 / Math.max(1, (Date.now() - this.startedAt) / 1000) / 1000) : 0,
    };
  }

  detail() {
    const c = this.cfg();
    const d = { via: 'USB', freq_mhz: +(c.freqHz / 1e6).toFixed(4), format: c.format, sample_rate: c.sampleRate };
    if (this.tuner) d.tuner = this.tuner;
    if (this.model) d.model = this.model;
    if (this.stick.serial) d.serial = this.stick.serial;
    return d;
  }
}

function round(v, d) { if (v == null || !Number.isFinite(v)) return null; const k = Math.pow(10, d == null ? 1 : d); return Math.round(v * k) / k; }

module.exports = { SdrSession };
