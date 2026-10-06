'use strict';
// Whether the Pi knows what time it is.
//
// A Raspberry Pi has no battery clock (a Pi 5 can, with a cell fitted). It
// boots at whatever time fake-hwclock saved at the last shutdown, and is only
// right once NTP has answered — or, with no internet, once a GPS has a fix.
// A reading stamped before then would go to MegaNet hours or days out, and
// MegaNet only refuses the obviously dead clocks (before 1990, or a day ahead).
//
// A battery-backed real-time clock — a Pi 5 with its RTC battery fitted, or
// an RTC board (DS3231 and the like) on a Pi 3 or 4 — keeps time with the
// power off, and is what lets a base station with no internet and no GPS (a
// site survey on a hill) time what it hears across a power cut. It is trusted
// only once it has been seen to agree with NTP or a GPS (within two seconds,
// in the last 60 days), and only when it reads no earlier than the last time
// this agent knew the time to be right: an RTC whose battery is flat or
// missing starts again from 1970 or from wherever it stopped, and fails that
// check. While NTP or a GPS is trusted the agent keeps the RTC set (the root
// helper's rtc-sync, hwclock) and remembers both in clock.json.
//
// So a reading that arrives while the clock is untrusted is held with a
// monotonic timestamp (CLOCK_MONOTONIC, milliseconds since this boot, which
// Node's hrtime reads and which does not jump when the wall clock is set) and
// the boot it belongs to. The moment the clock is trusted, every held reading
// gets its real time: now − (monotonic now − monotonic then). One from an
// earlier boot that never saw a good clock cannot be placed, and is dropped
// with a line in the log.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const GPS_FRESH_MS = 60 * 60 * 1000;
const RTC_DIR = process.env.RPI_ALERT_RTC || '/sys/class/rtc/rtc0';
const RTC_TRUST_DAYS = 60, RTC_AGREE_MS = 2000, KEEP_MS = 10 * 60 * 1000;

function bootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (_) { return 'unknown'; }
}
function mono() { return Number(process.hrtime.bigint() / 1000000n); }

class Clock extends EventEmitter {
  constructor(opts) {
    super();
    this.log = opts && opts.log;
    this.assume = !!(opts && opts.assumeSynced) || process.env.RPI_ALERT_ASSUME_CLOCK === '1';
    this.ntp = this.assume;
    this.gps = null;           // { offset, atMono }
    this.boot = bootId();
    this.timer = null;
    this.setter = opts && opts.setSystemTime;   // async (ms) => …, may be absent
    this.syncRtc = opts && opts.syncRtc;        // async () => …: write the system time to the RTC
    this.rtcDir = (opts && opts.rtcDir) || RTC_DIR;
    this.file = opts && opts.dataDir ? path.join(opts.dataDir, 'clock.json') : null;
    this.memory = { lastGood: 0, rtcVerifiedAt: 0 };
    this.rtc = null;           // { offset } while the RTC is what the time is trusted on
    this.rtcNote = '';
    this.lastRtcSync = 0;
    this.lastSet = 0;
    this.source = this.assume ? 'assumed' : 'none';
  }

  start() {
    if (this.file) try { Object.assign(this.memory, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (_) {}
    this.checkRtc();
    this.check();
    this.keeper = setInterval(() => this.keep(), KEEP_MS);
    this.keeper.unref?.();
    return this;
  }
  stop() { clearTimeout(this.timer); clearInterval(this.keeper); if (this.trusted()) this.keep(); }

  // ── the RTC ─────────────────────────────────────────────────────────────

  rtcRead() {
    try {
      const s = Number(fs.readFileSync(path.join(this.rtcDir, 'since_epoch'), 'utf8').trim());
      // An RTC that lost its time either fails to read (a DS3231 says so) or reads 1970-something.
      return Number.isFinite(s) && s > 0 ? s * 1000 : null;
    } catch (_) { return null; }
  }
  rtcInfo() {
    const read = (f) => { try { return fs.readFileSync(path.join(this.rtcDir, f), 'utf8').trim(); } catch (_) { return null; } };
    const name = read('name');
    if (name == null && this.rtcRead() == null) return null;
    // A Pi 5's RTC says its battery's voltage, in microvolts.
    const uv = Number(read('battery_voltage'));
    return { name: name || 'rtc', batteryV: Number.isFinite(uv) && read('battery_voltage') != null ? Math.round(uv / 10000) / 100 : null };
  }

  // At start (and whenever there is still nothing better): is the RTC to be believed?
  checkRtc() {
    if (this.assume || this.trusted()) return;
    const r = this.rtcRead();
    if (r == null) { this.rtcNote = this.rtcInfo() ? 'The RTC has lost its time (no battery, or a flat one).' : ''; return; }
    const m = this.memory;
    if (!m.rtcVerifiedAt) { this.rtcNote = 'The RTC has not yet been checked against NTP or a GPS — get this Pi online once (or a GPS fix) and it will be.'; return; }
    if (r - m.rtcVerifiedAt > RTC_TRUST_DAYS * 86400e3) { this.rtcNote = 'The RTC was last checked against NTP or a GPS over ' + RTC_TRUST_DAYS + ' days ago.'; return; }
    if (r < m.lastGood - 120000) { this.rtcNote = 'The RTC reads ' + new Date(r).toISOString() + ', before this Pi last knew the time — it did not keep time with the power off.'; return; }
    this.rtcNote = '';
    this.rtc = { offset: r + 500 - Date.now() };   // since_epoch is whole seconds
    this.source = 'rtc';
    if (Math.abs(this.rtc.offset) > 5000 && this.setter) {
      this.lastSet = Date.now();
      Promise.resolve(this.setter(Date.now() + this.rtc.offset)).then(() => {
        this.log && this.log.info('set the system clock from the RTC (it was ' + Math.round(this.rtc.offset / 1000) + ' s out)');
        if (this.rtc) this.rtc.offset = 0;
      }, (e) => { this.log && this.log.warn('could not set the system clock from the RTC: ' + (e && e.message)); });
    }
    this.log && this.log.info('the clock is trusted (rtc' + (this.rtcInfo() ? ', ' + this.rtcInfo().name : '') + ')');
    this.emit('trusted');
  }

  // While the time is right: remember it, and keep the RTC right too.
  keep() {
    if (!this.trusted() || this.assume) return;
    const now = this.now();
    this.memory.lastGood = now;
    if (this.ntp || this.gpsFresh()) {
      const r = this.rtcRead();
      if (r != null && Math.abs(r + 500 - now) <= RTC_AGREE_MS) this.memory.rtcVerifiedAt = now;
      else if (this.rtcInfo() && this.syncRtc && Date.now() - this.lastRtcSync > 3600e3) {
        this.lastRtcSync = Date.now();
        Promise.resolve(this.syncRtc()).then(() => {
          this.log && this.log.info('set the RTC from the ' + this.source + ' time');
          const r2 = this.rtcRead();
          if (r2 != null && Math.abs(r2 + 500 - this.now()) <= RTC_AGREE_MS) { this.memory.rtcVerifiedAt = this.now(); this.save(); }
        }, (e) => { this.log && this.log.warn('could not set the RTC: ' + (e && e.message)); });
      }
    }
    this.save();
  }
  save() {
    if (!this.file) return;
    try { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.memory)); fs.renameSync(this.file + '.tmp', this.file); } catch (_) {}
  }

  check() {
    clearTimeout(this.timer);
    const again = (ms) => { this.timer = setTimeout(() => this.check(), ms); this.timer.unref?.(); };
    if (this.assume) return;
    // systemd-timesyncd marks a sync here; timedatectl answers for chrony and
    // anything else that sets the kernel's sync flag.
    if (fs.existsSync('/run/systemd/timesync/synchronized')) { this.setNtp(true); return again(600000); }
    execFile('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 5000 }, (err, out) => {
      if (err) {
        // No systemd (a development machine): trust the clock, as every PC does.
        if (err.code === 'ENOENT') { this.setNtp(true); return; }
        return again(30000);
      }
      this.setNtp(String(out).trim() === 'yes');
      again(this.ntp ? 600000 : 15000);
    });
  }

  setNtp(v) {
    const was = this.trusted();
    const had = this.ntp;
    this.ntp = v;
    if (v) this.source = 'ntp';
    if (!was && this.trusted()) { this.log && this.log.info('the clock is trusted (' + this.source + ')'); this.emit('trusted'); }
    if (v && !had) { this.rtc = null; this.keep(); }
  }

  // A GPS time: { ms (UTC from the receiver), at (hrtime bigint when it was read) }.
  gpsTime(t) {
    const age = Number((process.hrtime.bigint() - t.at) / 1000000n);
    const offset = t.ms + age - Date.now();
    const was = this.trusted();
    this.gps = { offset, atMono: mono() };
    if (!this.ntp) {
      this.source = 'gps';
      this.rtc = null;
      // Put the system clock right too, so the logs agree, at most every ten minutes.
      if (Math.abs(offset) > 5000 && this.setter && Date.now() - this.lastSet > 600000) {
        this.lastSet = Date.now();
        Promise.resolve(this.setter(Date.now() + offset)).then(() => {
          this.log && this.log.info('set the system clock from GPS (it was ' + Math.round(offset / 1000) + ' s out)');
          if (this.gps) this.gps.offset = 0;
        }, (e) => { this.log && this.log.warn('could not set the system clock from GPS: ' + (e && e.message)); });
      }
    }
    if (!was && this.trusted()) { this.log && this.log.info('the clock is trusted (gps)'); this.emit('trusted'); this.keep(); }
  }

  gpsFresh() { return !!this.gps && mono() - this.gps.atMono < GPS_FRESH_MS; }
  trusted() { return this.ntp || this.gpsFresh() || !!this.rtc; }
  now() { return Date.now() + (this.ntp ? 0 : this.gpsFresh() ? this.gps.offset : this.rtc ? this.rtc.offset : 0); }
  mono() { return mono(); }
  bootId() { return this.boot; }

  // The wall time of a monotonic stamp taken in this boot.
  wallOf(monoMs) { return this.now() - (mono() - monoMs); }

  status() {
    const info = this.rtcInfo();
    return { trusted: this.trusted(), source: this.trusted() ? this.source : 'none', ntp: this.ntp,
      gpsOffsetMs: this.gps ? Math.round(this.gps.offset) : null, now: new Date(this.now()).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Whether the time would survive a power cut with no internet and no GPS.
      rtc: info ? Object.assign(info, { verifiedAt: this.memory.rtcVerifiedAt || null, trusted: !!this.rtc,
        usable: !!this.memory.rtcVerifiedAt && Date.now() - this.memory.rtcVerifiedAt < RTC_TRUST_DAYS * 86400e3, note: this.rtcNote }) : null };
  }
}

module.exports = { Clock, mono, bootId };
