'use strict';
// When the Pi's time can be trusted with no internet: a battery RTC that has
// been seen to agree with NTP or a GPS, and has not lost its time since.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Clock } = require('../lib/clock');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

// A fake /sys/class/rtc/rtc0 and a data directory, with what the agent remembered.
function rig(rtcMs, memory, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-clock-'));
  const rtcDir = path.join(dir, 'rtc0');
  fs.mkdirSync(rtcDir);
  fs.writeFileSync(path.join(rtcDir, 'name'), 'rpi-rtc soc:rpi_rtc');
  if (rtcMs != null) fs.writeFileSync(path.join(rtcDir, 'since_epoch'), String(Math.floor(rtcMs / 1000)) + '\n');
  for (const [k, v] of Object.entries(extra || {})) fs.writeFileSync(path.join(rtcDir, k), v);
  if (memory) fs.writeFileSync(path.join(dir, 'clock.json'), JSON.stringify(memory));
  return { dir, rtcDir, set: (ms) => fs.writeFileSync(path.join(rtcDir, 'since_epoch'), String(Math.floor(ms / 1000))) };
}
// No NTP: timedatectl is not asked (assumeSynced off, and check() is not run).
function clock(r, opts) {
  const c = new Clock(Object.assign({ log: quiet, dataDir: r.dir, rtcDir: r.rtcDir }, opts || {}));
  c.check = () => {};
  return c;
}

test('an RTC checked against NTP recently, and not behind, is trusted at boot', () => {
  const now = Date.now();
  const r = rig(now, { lastGood: now - 3600e3, rtcVerifiedAt: now - 2 * 86400e3 });
  const c = clock(r);
  let fired = 0; c.on('trusted', () => fired++);
  c.start();
  assert.equal(c.trusted(), true);
  assert.equal(c.status().source, 'rtc');
  assert.equal(fired, 1);
  assert.ok(Math.abs(c.now() - now) < 2000);
  c.stop();
});

test('an RTC that lost its time with the power is not trusted', () => {
  const now = Date.now();
  // A Pi 5 with no battery: it starts again from 1970.
  const a = clock(rig(30 * 1000, { lastGood: now - 3600e3, rtcVerifiedAt: now - 86400e3 })).start();
  assert.equal(a.trusted(), false);
  assert.match(a.status().rtc.note, /before this Pi last knew the time/);
  a.stop();
  // A DS3231 that stopped says so by failing to read.
  const b = clock(rig(null, { lastGood: now - 3600e3, rtcVerifiedAt: now - 86400e3 })).start();
  assert.equal(b.trusted(), false);
  assert.match(b.status().rtc.note, /lost its time/);
  b.stop();
});

test('an RTC never checked, or not for 60 days, is not trusted', () => {
  const now = Date.now();
  const a = clock(rig(now, null)).start();
  assert.equal(a.trusted(), false);
  assert.match(a.status().rtc.note, /not yet been checked/);
  a.stop();
  const b = clock(rig(now, { lastGood: now - 61 * 86400e3, rtcVerifiedAt: now - 61 * 86400e3 })).start();
  assert.equal(b.trusted(), false);
  b.stop();
});

test('while NTP is good the RTC is checked, and set when it is out', async () => {
  const now = Date.now();
  const r = rig(now - 90e3, null);
  let synced = 0;
  const c = clock(r, { syncRtc: async () => { synced++; r.set(Date.now()); } }).start();
  assert.equal(c.trusted(), false);
  c.setNtp(true);
  assert.equal(c.status().source, 'ntp');
  await new Promise(res => setTimeout(res, 50));
  assert.equal(synced, 1, 'the RTC was 90 s out: set from NTP');
  const mem = JSON.parse(fs.readFileSync(path.join(r.dir, 'clock.json'), 'utf8'));
  assert.ok(mem.rtcVerifiedAt > now - 5000, 'checked once set');
  assert.ok(mem.lastGood > now - 5000);
  c.stop();
  // The next boot, offline and with no GPS, keeps the time.
  const d = clock(r).start();
  assert.equal(d.status().source, 'rtc');
  d.stop();
});

test('the RTC status says the battery voltage when the Pi 5 gives it', () => {
  const c = clock(rig(Date.now(), null, { battery_voltage: '3012345' })).start();
  assert.equal(c.status().rtc.batteryV, 3.01);
  c.stop();
});

test('no RTC at all: nothing about one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-clock-'));
  const c = clock({ dir, rtcDir: path.join(dir, 'none') }).start();
  assert.equal(c.status().rtc, null);
  assert.equal(c.trusted(), false);
  c.stop();
});
