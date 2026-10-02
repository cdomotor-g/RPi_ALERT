'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Config, hashPassword, checkPassword, maskToken } = require('../lib/config');
const boot = require('../lib/bootconf');

function tmpConfig() { return new Config(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-cfg-')), 'config.json')).load(); }

test('settings: defaults, a valid change saved 0600, a bad one refused with a reason', () => {
  const c = tmpConfig();
  assert.equal(c.get().receivers.sdr.freqHz, 151500000);
  const ok = c.update({ receivers: { sdr: { freqHz: 151525000 } } });
  assert.ok(ok.ok); assert.deepEqual(ok.changed, ['receivers.sdr.freqHz']);
  assert.equal(fs.statSync(c.file).mode & 0o777, 0o600);
  const bad = c.update({ receivers: { sdr: { format: 'BOTH' } } });
  assert.equal(bad.ok, false); assert.match(bad.errors[0], /format/);
  assert.equal(c.get().receivers.sdr.format, 'BINARY');
});

test('settings: the token never comes back out whole', () => {
  const c = tmpConfig();
  c.update({ meganet: { token: 'mgn_abcdefghijklmnopqrstuvwxyz' } });
  const r = c.redacted();
  assert.equal(r.meganet.tokenSet, true);
  assert.ok(!JSON.stringify(r).includes('mgn_abcdefghijklmnopqrstuvwxyz'));
  assert.equal(maskToken('mgn_abcdefghijklmnopqrstuvwxyz'), 'mgn_ab…wxyz');
});

test('settings: a damaged file falls back to defaults field by field', () => {
  const c = tmpConfig();
  fs.writeFileSync(c.file, JSON.stringify({ name: 'Kept', receivers: { sdr: { format: 'NONSENSE', freqHz: 151500000 } } }));
  const d = new Config(c.file).load();
  assert.equal(d.get().name, 'Kept');
  assert.equal(d.get().receivers.sdr.format, 'BINARY');
  assert.ok(d.loadError);
});

test('web password: scrypt, checked in constant time', () => {
  const h = hashPassword('correct horse');
  assert.ok(checkPassword('correct horse', h));
  assert.ok(!checkPassword('wrong', h));
});

test('rpi-alert.conf: parsed, turned into settings, and its secrets blanked', () => {
  const kv = boot.parse('# c\r\ntoken = mgn_xyz\nname = Bench Pi  # trailing\nlatitude = -27.4698\nlongitude = 153.0251\nsdr_frequency_mhz = 151.525\nsdr_format = enhanced iflows\nsdr_gain_db = auto\naudio = off\nkiosk = no\nweb_password = a #b\nwifi_ssid = "My Net"\nwifi_password = secret12\nnot a line\n');
  const { patch, system, notes } = boot.toPatch(kv);
  assert.equal(patch.meganet.token, 'mgn_xyz');
  assert.equal(patch.name, 'Bench Pi');
  assert.deepEqual(patch.location, { lat: -27.4698, lon: 153.0251, source: 'manual' });
  assert.equal(patch.receivers.sdr.freqHz, 151525000);
  assert.equal(patch.receivers.sdr.format, 'ENHANCED_IFLOWS');
  assert.equal(patch.receivers.sdr.gainDb, null);
  assert.equal(patch.audio.mode, 'off');
  assert.equal(patch.kiosk.mode, 'off');
  assert.ok(checkPassword('a #b', patch.web.passwordHash), 'a # inside a password is part of it');
  assert.equal(system.wifiSsid, 'My Net');
  assert.ok(notes.some(n => /not "key = value"/.test(n)));
  const red = boot.redactText('token = mgn_xyz\nwifi_password = secret12\nname = x');
  assert.ok(!red.includes('mgn_xyz') && !red.includes('secret12') && red.includes('name = x'));
  const c = tmpConfig();
  assert.ok(c.update(patch).ok, 'the patch passes validation');
});
