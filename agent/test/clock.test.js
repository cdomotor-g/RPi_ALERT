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

// ── GPS time: believed only when plausible and steady ───────────────────────

// What the GPS driver passes: the receiver's UTC, read just now.
const fix = (ms) => ({ ms, at: process.hrtime.bigint() });
function noRtc(memory) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-clock-'));
  if (memory) fs.writeFileSync(path.join(dir, 'clock.json'), JSON.stringify(memory));
  return { dir, rtcDir: path.join(dir, 'none') };
}

test('a GPS time is taken once it has said the same three times', () => {
  const now = Date.now();
  const c = clock(noRtc({ lastGood: now - 3600e3 })).start();
  c.gpsTime(fix(now + 30e3));
  c.gpsTime(fix(now + 30e3));
  assert.equal(c.trusted(), false, 'two is not yet steady');
  c.gpsTime(fix(now + 30e3));
  assert.equal(c.trusted(), true);
  assert.equal(c.status().source, 'gps');
  assert.ok(Math.abs(c.now() - (now + 30e3)) < 2000);
  // From then on each fix that agrees keeps it.
  c.gpsTime(fix(Date.now() + 30e3));
  assert.equal(c.trusted(), true);
  c.stop();
});

test('a GPS time that jumps about is not steady, and is not taken', () => {
  const now = Date.now();
  const c = clock(noRtc({ lastGood: now - 3600e3 })).start();
  for (const off of [10e3, 50e3, 10e3, 90e3, 10e3]) c.gpsTime(fix(now + off));
  assert.equal(c.trusted(), false);
  c.stop();
});

test('a GPS time before this Pi last knew the time, or before 2025, is refused and said', () => {
  const now = Date.now();
  let warned = '';
  const c = clock(noRtc({ lastGood: now }), { log: Object.assign({}, quiet, { warn: (m) => { warned = m; } }) }).start();
  // A receiver with the week-rollover bug: 1024 weeks back.
  for (let i = 0; i < 5; i++) c.gpsTime(fix(now - 1024 * 7 * 86400e3));
  assert.equal(c.trusted(), false);
  assert.match(c.status().gpsNote, /before 2025/);
  for (let i = 0; i < 5; i++) c.gpsTime(fix(now - 3 * 86400e3));
  assert.equal(c.trusted(), false);
  assert.match(c.status().gpsNote, /before this Pi last knew the time/);
  assert.match(warned, /before this Pi last knew the time/);
  // Far in the future is no better.
  for (let i = 0; i < 5; i++) c.gpsTime(fix(now + 500 * 86400e3));
  assert.match(c.status().gpsNote, /over 400 days past/);
  assert.equal(c.trusted(), false);
  c.stop();
});

test('a jump of more than a day needs a minute of agreement, not three fixes', () => {
  const now = Date.now();
  // Powered off for a week, then out on a hill with only the GPS.
  const c = clock(noRtc({ lastGood: now - 7 * 86400e3 })).start();
  const ahead = now + 7 * 86400e3;
  for (let i = 0; i < 10; i++) c.gpsTime(fix(ahead));
  assert.equal(c.trusted(), false, 'not yet a minute');
  assert.equal(c.gpsCand.n, 10);
  // A minute later (the candidate's start moved back rather than waiting).
  c.gpsCand.since -= 61e3;
  c.gpsTime(fix(ahead));
  assert.equal(c.trusted(), true);
  assert.equal(c.status().gpsNote, null);
  c.stop();
});

test('with a trusted RTC, a GPS more than five minutes from it is not used', () => {
  const now = Date.now();
  const c = clock(rig(now, { lastGood: now - 3600e3, rtcVerifiedAt: now - 86400e3 })).start();
  assert.equal(c.status().source, 'rtc');
  for (let i = 0; i < 5; i++) c.gpsTime(fix(now + 20 * 60e3));
  assert.equal(c.status().source, 'rtc');
  assert.match(c.status().gpsNote, /20 min out from the RTC/);
  // One that agrees takes over (it is the finer clock).
  for (let i = 0; i < 3; i++) c.gpsTime(fix(Date.now() + 1000));
  assert.equal(c.status().source, 'gps');
  assert.equal(c.status().gpsNote, null);
  c.stop();
});

test('while NTP has the time, a GPS far from it is noted and never moves the clock', () => {
  let set = 0;
  const c = clock(noRtc(null), { setSystemTime: async () => { set++; } }).start();
  c.setNtp(true);
  for (let i = 0; i < 5; i++) c.gpsTime(fix(Date.now() + 3600e3));
  assert.match(c.status().gpsNote, /60 min out from network time/);
  assert.equal(set, 0);
  assert.equal(c.status().source, 'ntp');
  assert.ok(Math.abs(c.now() - Date.now()) < 100);
  c.stop();
});
