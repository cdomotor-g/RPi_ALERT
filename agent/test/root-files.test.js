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
