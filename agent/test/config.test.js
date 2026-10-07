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
  assert.ok(ok.ok); assert.deepEqual(ok.changed, ['receivers.sdr.freqHz', 'receivers.sdr.moreChannels'], 'MegaNet\'s channels kept around it');
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

test('rpi-alert.conf: a Bluetooth GPS is paired, read as a port, and its PIN blanked', () => {
  const { patch, system, notes } = boot.toPatch(boot.parse('gps_bluetooth = 58-a8-39-01-93-61\ngps_bluetooth_pin = 123456\n'));
  assert.deepEqual(system.btGps, { address: '58:A8:39:01:93:61', pin: '123456' });
  assert.equal(patch.location.useGps, true, 'a Bluetooth GPS means the location follows it');
  assert.equal(notes.length, 0);
  assert.deepEqual(boot.withBtGpsPort(['/dev/serial0'], system.btGps), ['/dev/serial0', boot.BT_GPS_PORT]);
  assert.deepEqual(boot.withBtGpsPort([boot.BT_GPS_PORT], system.btGps), [boot.BT_GPS_PORT], 'not added twice');
  assert.deepEqual(boot.withBtGpsPort(['/dev/serial0', boot.BT_GPS_PORT], { off: true }), ['/dev/serial0']);
  assert.equal(boot.toPatch(boot.parse('gps_bluetooth = off\n')).system.btGps.off, true);
  assert.equal(boot.toPatch(boot.parse('gps_bluetooth = 58:A8:39:01:93:61\nuse_gps = no\n')).patch.location.useGps, false, 'use_gps still wins');
  assert.ok(boot.toPatch(boot.parse('gps_bluetooth = reach\n')).notes.some(n => /Bluetooth address/.test(n)));
  assert.ok(!boot.redactText('gps_bluetooth_pin = 123456').includes('123456'));
  const c = tmpConfig();
  assert.ok(c.update(Object.assign({}, patch, { receivers: { extraPorts: boot.withBtGpsPort([], system.btGps) } })).ok, 'the port passes validation');
});

test('settings: remote management — manage by default, its own owner\'s to change, held to its shape', () => {
  const c = tmpConfig();
  assert.deepEqual(c.get().remote, { mode: 'manage', idleS: 60 });
  assert.ok(c.update({ remote: { mode: 'report' } }).ok);
  assert.match(c.update({ remote: { mode: 'everything' } }).errors[0], /remote\.mode/);
  assert.match(c.update({ remote: { idleS: 5 } }).errors[0], /30–900/, 'not more often than every 30 s by itself');
  assert.ok(!('remote' in c.redacted()) || c.redacted().remote.mode === 'report');
});

test('rpi-alert.conf: SSH keys a line each, GitHub accounts, MegaNet\'s keys, and the alert password blanked', () => {
  const ed = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPe8hvW1PCMkuoplQxeOFxa2TvuF2q0PFfleQ85hNXHo jo@laptop';
  const ec = 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBLbLD/E41tmQJt+U1fetJOuOc0jgqqf/guPCE8hi44NkDIBLOTPkxOA4ARYwct0+ql87t1YZVUb+dK5Ornw5xqg= sam';
  const text = 'remote_management = report\nssh_key = ' + ed + '\nssh_key = ' + ec + '\nssh_github = @cdomotor-g, someone-else\nssh_meganet_keys = yes\nssh_from = any\nssh_password_login = off\nalert_password = c0rrect#horse\n';
  const kv = boot.parse(text);
  assert.deepEqual(kv.ssh_key, [ed, ec], 'every ssh_key line kept, in order');
  const { patch, system, notes } = boot.toPatch(kv);
  assert.deepEqual(notes, []);
  assert.equal(patch.remote.mode, 'report');
  assert.deepEqual(system.access, { keys: [ed, ec], github: ['cdomotor-g', 'someone-else'], meganet: 'on', from: 'any', password: 'off', alertPassword: 'c0rrect#horse' });
  assert.ok(tmpConfig().update(patch).ok);
  const red = boot.redactText(text);
  assert.ok(!red.includes('c0rrect'), 'the password is wiped from the card');
  assert.ok(red.includes(ed), 'public keys are not secrets');
  assert.deepEqual(boot.toPatch(boot.parse('ssh_key = none\nalert_password = none\n')).system.access, { keys: [], alertPassword: '' }, 'none clears them');
  assert.equal(boot.toPatch(boot.parse('remote_management = no\n')).patch.remote.mode, 'off');
  assert.ok(boot.toPatch(boot.parse('ssh_from = moon\n')).notes.some(n => /ssh_from/.test(n)));
});

test('rpi-alert.conf: ssh = on makes missing host keys before starting sshd, and says why when it still fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpi-alert-ssh-'));
  const fake = (results) => {
    const calls = [];
    return { calls, run: (cmd, args) => { const c = cmd + ' ' + args.join(' '); calls.push(c); return results[c] || { ok: true, out: '' }; } };
  };
  let logs = [];
  const log = (m) => logs.push(m);

  // First boot: no host keys yet — they are made, then sshd started.
  let f = fake({});
  boot.applySsh('on', log, { run: f.run, sshDir: dir });
  assert.deepEqual(f.calls, ['systemctl enable ssh', 'ssh-keygen -A', 'systemctl start ssh']);
  assert.deepEqual(logs, ['SSH on (made its host keys)']);

  // Keys already there: left alone.
  fs.writeFileSync(path.join(dir, 'ssh_host_ed25519_key'), 'x');
  f = fake({}); logs = [];
  boot.applySsh('on', log, { run: f.run, sshDir: dir });
  assert.deepEqual(f.calls, ['systemctl enable ssh', 'systemctl start ssh']);
  assert.deepEqual(logs, ['SSH on']);

  // It still fails: sshd -t's own words, not systemd's "Job for ssh.service failed".
  f = fake({ 'systemctl start ssh': { ok: false, out: 'Job for ssh.service failed because the control process exited with error code.' },
    'sshd -t': { ok: false, out: '/etc/ssh/sshd_config line 3: Bad configuration option: Nope' } });
  logs = [];
  boot.applySsh('on', log, { run: f.run, sshDir: dir });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /next boot.*Bad configuration option/);

  f = fake({}); logs = [];
  boot.applySsh('off', log, { run: f.run, sshDir: dir });
  assert.deepEqual(f.calls, ['systemctl disable --now ssh']);
  assert.deepEqual(logs, ['SSH off']);
  fs.rmSync(dir, { recursive: true, force: true });
});
