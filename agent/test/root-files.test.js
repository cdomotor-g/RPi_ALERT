'use strict';
// Root reading and writing in the agent's own directories (/etc/rpi-alert,
// /var/lib/rpi-alert) — at boot, from the installer, under sudo — never through
// a link the agent put there; the Bluetooth GPS's settings in root's own file;
// the update's outcome read by the agent itself; an oversize log trimmed, not
// dropped.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readNoFollow, writeAtomic } = require('../lib/safe-fs');
const { Config } = require('../lib/config');
const { moveBtGpsConf } = require('../lib/bootconf');
const { requestFromCard } = require('../lib/survey');
const { lastUpdate } = require('../lib/system');
const { fitResult, MAX_RESULT_BYTES } = require('../lib/remote');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-root-')); }
// A file the agent must not be able to reach through root: /etc/shadow, say.
function secret(dir) { const f = path.join(dir, 'shadow'); fs.writeFileSync(f, 'root:$y$secret:20000::::::\n'); return f; }

test('readNoFollow: a plain file is read; a link, a hard link and a FIFO are refused', () => {
  const d = tmp();
  const s = secret(d);
  fs.writeFileSync(path.join(d, 'ok.json'), '{"a":1}');
  assert.equal(readNoFollow(path.join(d, 'ok.json')), '{"a":1}');
  fs.symlinkSync(s, path.join(d, 'link.json'));
  assert.throws(() => readNoFollow(path.join(d, 'link.json')), (e) => e.code === 'EUNSAFE' && /link/.test(e.message));
  fs.linkSync(s, path.join(d, 'hard.json'));
  assert.throws(() => readNoFollow(path.join(d, 'hard.json')), /more than one name/);
  require('node:child_process').execFileSync('mkfifo', [path.join(d, 'fifo.json')]);
  assert.throws(() => readNoFollow(path.join(d, 'fifo.json')), /not a plain file/, 'and does not hang on it');
  assert.throws(() => readNoFollow(path.join(d, 'none.json')), (e) => e.code === 'ENOENT');
  assert.throws(() => readNoFollow(path.join(d, 'ok.json'), 3), /larger than/);
});

test('writeAtomic replaces a planted link instead of writing through it, and leaves nothing behind', () => {
  const d = tmp();
  const s = secret(d);
  const f = path.join(d, 'config.json');
  fs.symlinkSync(s, f);
  writeAtomic(f, '{"b":2}\n', { mode: 0o600, owner: 'dir' });
  assert.equal(fs.readFileSync(s, 'utf8'), 'root:$y$secret:20000::::::\n', 'the target is untouched');
  assert.equal(fs.lstatSync(f).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"b":2}\n');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(d).sort(), ['config.json', 'shadow']);
});

test('settings: a config.json that is a link is not read, and saving replaces the link', () => {
  const d = tmp();
  const s = secret(d);
  const f = path.join(d, 'config.json');
  fs.symlinkSync(s, f);
  const c = new Config(f).load();
  assert.match(c.loadError, /is a link/);
  assert.doesNotMatch(c.loadError, /secret/, 'nothing of the target in the message');
  assert.equal(c.get().web.port, new Config(path.join(d, 'none.json')).get().web.port, 'defaults');
  c.save();
  assert.equal(fs.readFileSync(s, 'utf8'), 'root:$y$secret:20000::::::\n');
  assert.equal(fs.lstatSync(f).isFile(), true);
  assert.equal(new Config(f).load().loadError, null);
});

test('settings: a bad config.json is kept as .bad, never through a link planted there', () => {
  const d = tmp();
  const s = secret(d);
  const f = path.join(d, 'config.json');
  fs.writeFileSync(f, '{ not json');
  fs.symlinkSync(s, f + '.bad');
  const c = new Config(f).load();
  assert.match(c.loadError, /not valid JSON/);
  assert.equal(fs.readFileSync(s, 'utf8'), 'root:$y$secret:20000::::::\n');
  assert.equal(fs.readFileSync(f + '.bad', 'utf8'), '{ not json');
});

test('a survey asked for on the card is written fresh, not through a planted link', () => {
  const d = tmp();
  const s = secret(d);
  fs.symlinkSync(s, path.join(d, 'survey-request.json'));
  assert.equal(requestFromCard(d, { name: 'Hill site', hours: 24 }), true);
  assert.equal(fs.readFileSync(s, 'utf8'), 'root:$y$secret:20000::::::\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'survey-request.json'), 'utf8')).name, 'Hill site');
});

test('Bluetooth GPS: the old settings move to root\'s file, checked, and a link is not followed', () => {
  const d = tmp();
  const from = path.join(d, 'bluetooth-gps.conf'), to = path.join(d, 'rpi-alert-btgps.conf');
  fs.writeFileSync(from, '# old\naddress = 58:a8:39:01:93:61\npin = 12 34; reboot\nchannel = 3\n');
  assert.match(moveBtGpsConf(from, to), /moved/);
  assert.equal(fs.existsSync(from), false);
  const text = fs.readFileSync(to, 'utf8');
  assert.match(text, /^address = 58:A8:39:01:93:61$/m);
  assert.match(text, /^channel = 3$/m);
  assert.doesNotMatch(text, /pin|reboot/, 'a PIN that is not letters and digits is left out');
  assert.equal(fs.statSync(to).mode & 0o777, 0o600);

  const d2 = tmp();
  const s = secret(d2);
  const from2 = path.join(d2, 'bluetooth-gps.conf'), to2 = path.join(d2, 'rpi-alert-btgps.conf');
  fs.symlinkSync(s, from2);
  assert.match(moveBtGpsConf(from2, to2), /not moved: .*link/);
  assert.equal(fs.existsSync(to2), false);
  assert.equal(fs.existsSync(from2), false, 'the link is taken away');
  assert.equal(fs.readFileSync(s, 'utf8'), 'root:$y$secret:20000::::::\n');
  assert.equal(moveBtGpsConf(from2, to2), 'nothing to move');
});

test('the update\'s outcome: the newer of root\'s file and the old place in the agent\'s directory', () => {
  const d = tmp();
  const root = path.join(d, 'status.json'), old = path.join(d, 'update-status.json');
  assert.equal(lastUpdate([root, old]), null);
  fs.writeFileSync(old, JSON.stringify({ state: 'ok', to: '0.22.2', at: 200 }));
  assert.equal(lastUpdate([root, old]).to, '0.22.2', 'the update from 0.22.1 writes the old place');
  fs.writeFileSync(root, JSON.stringify({ state: 'current', to: '0.22.2', at: 300 }));
  assert.equal(lastUpdate([root, old]).state, 'current');
  fs.writeFileSync(root, '{}');
  assert.equal(lastUpdate([root, old]).state, 'ok', 'a file without a state is no answer');
});

test('an oversize log for MegaNet keeps its newest lines and says how many were left out', () => {
  const lines = Array.from({ length: 400 }, (_, i) => ({ t: i, level: 'info', tag: 'x', msg: String(i).padEnd(400, '.') }));
  const out = fitResult({ lines });
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= MAX_RESULT_BYTES);
  assert.ok(out.lines.length > 50 && out.lines.length < 400);
  assert.equal(out.lines[out.lines.length - 1].t, 399, 'the newest line is kept');
  assert.equal(out.left_out, 400 - out.lines.length);
  assert.match(out.note, /oldest \d+ of 400 lines left out/);
  const small = { lines: lines.slice(0, 3) };
  assert.equal(fitResult(small), small);
  assert.equal(fitResult({ blob: 'x'.repeat(MAX_RESULT_BYTES + 10) }).truncated, true);
});

test('ownNoFollow: sets a plain file\'s mode on the file itself; a link is removed and its target untouched', () => {
  const { ownNoFollow } = require('../lib/safe-fs');
  const d = tmp();
  const s = secret(d);
  fs.chmodSync(s, 0o644);
  const f = path.join(d, 'config.json');
  const uid = process.getuid(), gid = process.getgid();
  assert.equal(ownNoFollow(f, uid, gid, 0o600), 'none');
  fs.symlinkSync(s, f);
  assert.equal(ownNoFollow(f, uid, gid, 0o600), 'link removed');
  assert.equal(fs.statSync(s).mode & 0o777, 0o644, 'the target keeps its mode');
  assert.equal(fs.existsSync(f), false);
  fs.linkSync(s, f);
  assert.equal(ownNoFollow(f, uid, gid, 0o600), 'left', 'a hard link is left alone');
  assert.equal(fs.statSync(s).mode & 0o777, 0o644);
  fs.unlinkSync(f);
  fs.writeFileSync(f, '{}', { mode: 0o644 });
  assert.equal(ownNoFollow(f, uid, gid, 0o600), 'set');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('install.sh sets config.json\'s owner and mode only through ownNoFollow, never chmod on the path', () => {
  const sh = fs.readFileSync(path.join(__dirname, '..', '..', 'os', 'install.sh'), 'utf8');
  assert.doesNotMatch(sh, /chmod[^\n]*\/etc\/rpi-alert\/config\.json/);
  assert.doesNotMatch(sh, /chown[^\n]*\/etc\/rpi-alert\/config\.json/);
  assert.match(sh, /ownNoFollow\(/);
});

// ── the settings file where there is no boot partition (0.24) ────────────────
// /etc/rpi-alert.conf: root's own, beside the agent's directory and never in
// it — it can give the alert account a key, and the agent could put a file in
// a directory of its own.

function importer(conf) {
  const dir = tmp();
  const etc = path.join(dir, 'etc'), mine = path.join(etc, 'rpi-alert'), bootDir = path.join(dir, 'boot');
  fs.mkdirSync(mine, { recursive: true }); fs.mkdirSync(bootDir);
  const file = path.join(etc, 'rpi-alert.conf');
  if (conf != null) fs.writeFileSync(file, conf, { mode: 0o600 });
  const env = Object.assign({}, process.env, { RPI_ALERT_CONFIG: path.join(mine, 'config.json'), RPI_ALERT_ETC_CONF: file, RPI_ALERT_BOOT_DIRS: bootDir, RPI_ALERT_DATA: path.join(dir, 'data') });
  const run = () => require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'rpi-alert'), 'import-boot-config'], { env, encoding: 'utf8' });
  const settings = () => JSON.parse(fs.readFileSync(path.join(mine, 'config.json'), 'utf8'));
  return { dir, etc, mine, bootDir, file, run, settings };
}

test('settings file: /etc/rpi-alert.conf is applied where no boot partition holds one', () => {
  const i = importer('name = Council depot\nweb_bind = 127.0.0.1\nweb_require_login = all\nhotspot = off\nself_recovery = off\nremote_management = report\nweb_password = hunter2hunter2\n');
  const r = i.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /applying .*etc\/rpi-alert\.conf/);
  assert.match(r.stdout, /settings changed: .*web\.bind/);
  const c = i.settings();
  assert.deepEqual([c.name, c.web.bind, c.web.requireLogin, c.hotspot.mode, c.recover.mode, c.remote.mode], ['Council depot', '127.0.0.1', 'all', 'off', 'off', 'report']);
  // As on a card: applied once, and the secrets blanked in what is left of it.
  assert.equal(fs.existsSync(i.file), false);
  const applied = fs.readFileSync(i.file + '.applied', 'utf8');
  assert.match(applied, /^# Applied .* — see journalctl -u rpi-alert-boot-config\n/);
  assert.match(applied, /web_password = \(applied — removed from this file\)/);
  assert.ok(!applied.includes('hunter2'));
  assert.equal(fs.statSync(i.file + '.applied').mode & 0o777, 0o600, 'root\'s eyes only');
  // What happened is in the journal, where it was printed: nothing else is left in /etc.
  assert.deepEqual(fs.readdirSync(i.etc).sort(), ['rpi-alert', 'rpi-alert.conf.applied']);
  // Nothing there: nothing happens, and it says where it looked.
  const again = i.run();
  assert.equal(again.status, 0);
  assert.match(again.stdout, /no rpi-alert\.conf on the boot partition or at .*rpi-alert\.conf — nothing to apply/);
});

test('settings file: a boot partition\'s file comes first, and is applied as it always was', () => {
  const i = importer('name = From etc\n');
  fs.writeFileSync(path.join(i.bootDir, 'rpi-alert.conf'), 'name = From the card\r\nweb_password = hunter2hunter2\r\n');
  assert.equal(i.run().status, 0);
  assert.equal(i.settings().name, 'From the card');
  assert.match(fs.readFileSync(path.join(i.bootDir, 'rpi-alert.conf.applied'), 'utf8'), /^# Applied .* — see rpi-alert-boot\.log\n[^]*web_password = \(applied — removed from the card\)/);
  assert.match(fs.readFileSync(path.join(i.bootDir, 'rpi-alert-boot.log'), 'utf8'), /settings changed: name, web password\r\n/);
  assert.ok(fs.existsSync(i.file), 'the other waits for a boot with no card file');
  assert.equal(i.run().status, 0);
  assert.equal(i.settings().name, 'From etc');
});

test('settings file: /etc/rpi-alert.conf is applied only when it is root\'s own and nobody else can write it', () => {
  const key = 'ssh_key = ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlanted somebody\nname = Planted\n';
  const refused = (i, why) => {
    const r = i.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, why);
    assert.match(r.stdout, /not applied/);
    assert.equal(fs.existsSync(path.join(i.mine, 'config.json')), false, 'nothing was set');
    assert.equal(fs.existsSync(i.file + '.applied'), false);
    assert.ok(fs.lstatSync(i.file), 'and it is left where it was, for its owner to see');
  };
  // Anybody in its group, or anybody at all, may write it: what it says could be theirs.
  for (const mode of [0o660, 0o606, 0o666, 0o622]) {
    const i = importer(key);
    fs.chmodSync(i.file, mode);
    refused(i, /can be written by others than its owner \(mode \d+\).*sudo chmod 600/);
  }
  // A link to a file somewhere else: not followed.
  const linked = importer(null);
  const target = path.join(linked.dir, 'elsewhere.conf');
  fs.writeFileSync(target, key, { mode: 0o600 });
  fs.symlinkSync(target, linked.file);
  refused(linked, /rpi-alert\.conf is a link/);
  // Not a file at all.
  const folder = importer(null);
  fs.mkdirSync(folder.file);
  refused(folder, /is not a plain file/);
  // Another user's file (as root only: nobody else can give a file away).
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const theirs = importer(key);
    fs.chownSync(theirs.file, 65534, 65534);
    refused(theirs, /is not root's file \(its owner is user 65534\).*sudo chown root:root/);
  }
  // Root's own, readable by all but written by root alone (0644, as a file in /etc often is): applied.
  const ok = importer('name = Council depot\n');
  fs.chmodSync(ok.file, 0o644);
  assert.equal(ok.run().status, 0);
  assert.equal(ok.settings().name, 'Council depot');
});

test('settings file: one in the agent\'s own directory is never applied', () => {
  // Whatever it is — root's file moved there, a link, the agent's own: that directory is not looked in.
  const i = importer(null);
  fs.writeFileSync(path.join(i.mine, 'rpi-alert.conf'), 'ssh_key = ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlanted attacker\nname = Planted\n');
  const r = i.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to apply/);
  assert.equal(fs.existsSync(path.join(i.mine, 'config.json')), false);
  assert.ok(fs.existsSync(path.join(i.mine, 'rpi-alert.conf')), 'and it is left where it was');
  // The systemd unit that runs this at boot looks where the code looks, and nowhere in that directory.
  const unit = fs.readFileSync(path.join(__dirname, '..', '..', 'os', 'files', 'systemd', 'rpi-alert-boot-config.service'), 'utf8');
  assert.match(unit, /^ConditionPathExists=\|\/etc\/rpi-alert\.conf$/m);
  assert.doesNotMatch(unit, /^ConditionPathExists=.*\/etc\/rpi-alert\//m);
  assert.equal(require('../lib/bootconf').ETC_CONF, process.env.RPI_ALERT_ETC_CONF || '/etc/rpi-alert.conf');
});
