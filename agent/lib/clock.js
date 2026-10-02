'use strict';
// Whether the Pi knows what time it is.
//
// A Raspberry Pi has no battery clock (a Pi 5 can, with a cell fitted). It
// boots at whatever time fake-hwclock saved at the last shutdown, and is only
// right once NTP has answered — or, with no internet, once a GPS has a fix.
// A reading stamped before then would go to MegaNet hours or days out, and
// MegaNet only refuses the obviously dead clocks (before 1990, or a day ahead).
//
// So a reading that arrives while the clock is untrusted is held with a
// monotonic timestamp (CLOCK_MONOTONIC, milliseconds since this boot, which
// Node's hrtime reads and which does not jump when the wall clock is set) and
// the boot it belongs to. The moment the clock is trusted, every held reading
// gets its real time: now − (monotonic now − monotonic then). One from an
// earlier boot that never saw a good clock cannot be placed, and is dropped
// with a line in the log.

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const GPS_FRESH_MS = 60 * 60 * 1000;

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
    this.lastSet = 0;
    this.source = this.assume ? 'assumed' : 'none';
  }

  start() {
    this.check();
    return this;
  }
  stop() { clearTimeout(this.timer); }

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
    this.ntp = v;
    if (v) this.source = 'ntp';
    if (!was && this.trusted()) { this.log && this.log.info('the clock is trusted (' + this.source + ')'); this.emit('trusted'); }
  }

  // A GPS time: { ms (UTC from the receiver), at (hrtime bigint when it was read) }.
  gpsTime(t) {
    const age = Number((process.hrtime.bigint() - t.at) / 1000000n);
    const offset = t.ms + age - Date.now();
    const was = this.trusted();
    this.gps = { offset, atMono: mono() };
    if (!this.ntp) {
      this.source = 'gps';
      // Put the system clock right too, so the logs agree, at most every ten minutes.
      if (Math.abs(offset) > 5000 && this.setter && Date.now() - this.lastSet > 600000) {
        this.lastSet = Date.now();
        Promise.resolve(this.setter(Date.now() + offset)).then(() => {
          this.log && this.log.info('set the system clock from GPS (it was ' + Math.round(offset / 1000) + ' s out)');
          if (this.gps) this.gps.offset = 0;
        }, (e) => { this.log && this.log.warn('could not set the system clock from GPS: ' + (e && e.message)); });
      }
    }
    if (!was && this.trusted()) { this.log && this.log.info('the clock is trusted (gps)'); this.emit('trusted'); }
  }

  gpsFresh() { return !!this.gps && mono() - this.gps.atMono < GPS_FRESH_MS; }
  trusted() { return this.ntp || this.gpsFresh(); }
  now() { return Date.now() + (!this.ntp && this.gpsFresh() ? this.gps.offset : 0); }
  mono() { return mono(); }
  bootId() { return this.boot; }

  // The wall time of a monotonic stamp taken in this boot.
  wallOf(monoMs) { return this.now() - (mono() - monoMs); }

  status() {
    return { trusted: this.trusted(), source: this.trusted() ? this.source : 'none', ntp: this.ntp,
      gpsOffsetMs: this.gps ? Math.round(this.gps.offset) : null, now: new Date(this.now()).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
}

module.exports = { Clock, mono, bootId };
