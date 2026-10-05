'use strict';
// SSH access (lib/access.js): keys read the way OpenSSH reads them, the list
// sshd is given, where each key came from and how far it is trusted, fetched
// lists kept through an outage and dropped on a refusal, and the sshd drop-in
// checked by sshd itself before it is kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

// Everything in a scratch directory: the module reads these when it loads.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-access-'));
process.env.RPI_ALERT_ACCESS_DIR = path.join(root, 'etc-ssh-rpi-alert');
process.env.RPI_ALERT_ACCESS_STATE = path.join(root, 'state');
process.env.RPI_ALERT_SSHD_DROPIN = path.join(root, 'sshd_config.d', '10-rpi-alert.conf');
process.env.RPI_ALERT_SSHD_CONFIG = path.join(root, 'sshd_config');
process.env.RPI_ALERT_CONFIG = path.join(root, 'config.json');
process.env.RPI_ALERT_ACCESS_NO_RELOAD = '1';
const access = require('../lib/access');

// Made with ssh-keygen, with its own fingerprints (ssh-keygen -lf).
const V = {
  ed25519: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPe8hvW1PCMkuoplQxeOFxa2TvuF2q0PFfleQ85hNXHo vec-ed25519@test', 'SHA256:VeBIQNSQYe0Ge+JIoXnjKbfB0gSWAJChLuItuhNNFew'],
  ecdsa: ['ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBLbLD/E41tmQJt+U1fetJOuOc0jgqqf/guPCE8hi44NkDIBLOTPkxOA4ARYwct0+ql87t1YZVUb+dK5Ornw5xqg= vec-ecdsa@test', 'SHA256:RknIRqux7NWt85Wr0wnUI0GZOtVaVIIGAxKdQwI8OEU'],
  rsa: ['ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDQhmzilcQE/HqeS702rytJUG6MSED7V609+e+1rKE4Bdfi4AKiBctMELLfdIH3dg6ydvAs3+btwUlcmF0RMU+wAamACOGu/bmJT4gYduqQdftZxwBedKZURdqFa56eRMVaY4TEAZAGvVOwSeEjD3WNLccAQaHXZlCffTvuij5aWR7Hh6oGqiQDBa9wRH8zDcr96ZlLD8yEWXLgrP4FchQXdZCxIphZrww4JeWsi5CYyFPGxsoX8T26HJqim/fdvYGLS66ytqgV13Zg7+WtfJUNXrXHyrb0NyGJECxKPE+IUCl6CWzJSoTcFvTN3PTouzj0eSerWw+GP/KQUylENGL2jXAPD5Jdm/hwKu7ZzxKMiIwWtsWPeQovaXEfXUs27DLdNrcCoWd0sMsxW0fXSNpMK5Mu7KhcWDsTRWspPu1PssaSO6IpJTN5QEtGwx+8JBceQxgUtswr6lpI7gN2o4AN2zVeZYZa99ARHs9qbNKk6Hk1k9xG55ztvz14ZkzWpbM= vec-rsa@test', 'SHA256:ST5vehZy5UfLDnjvsU9mbYVfaSPQlCgvu9WdYYqm760'],
  weak: ['ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDdW6rTeThWDCPw2L3zu53N0l9R3fe++zLyN3njKTAf6bpcE/yKXTDcaxCf4Yx1CdOnqK2SDQGhea3357ZlWGjHwrKQHcB5UQJZDyjJTg4c6eJ2jeRq8resqUQM6Lb/RxmwYY57WiUxmFtWfpeEncBuuXt7EWZNQgNraXaJuzFGVQ== weak@test'],
};

// sshd -t wants its privilege-separation directory, which a Pi has and a
// container that never started sshd may not.
let hasSshd = fs.existsSync('/usr/sbin/sshd');
if (hasSshd) { try { fs.mkdirSync('/run/sshd', { recursive: true, mode: 0o755 }); } catch (_) {} hasSshd = fs.existsSync('/run/sshd'); }
try { execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' }); } catch (e) { if (e.code === 'ENOENT') hasSshd = false; }

test('access: keys are read the way OpenSSH reads them, fingerprints and all', () => {
  for (const t of ['ed25519', 'ecdsa', 'rsa']) {
    const k = access.parseKey(V[t][0]);
    assert.ok(!k.error, t + ': ' + k.error);
    assert.equal(k.fingerprint, V[t][1], t + ': the fingerprint ssh-keygen -l prints');
    assert.equal(k.comment, 'vec-' + t + '@test');
  }
  assert.match(access.parseKey(V.weak[0]).error, /2048/, 'a 1024-bit RSA key is refused');
  assert.match(access.parseKey('from="10.0.0.0/8" ' + V.ed25519[0]).error, /not accepted|public key/, 'options in front are a source\'s to give, never');
  assert.match(access.parseKey('ssh-dss AAAAB3NzaC1kc3MAAACBAP').error, /not accepted/);
  assert.match(access.parseKey('ssh-ed25519 ' + V.rsa[0].split(' ')[1]).error, /does not match/, 'a key that says it is one type and is another');
  assert.match(access.parseKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPe8hvW1PCMku').error, /cut short|mistyped/);
  assert.match(access.parseKey('hello').error, /not a public key/);
  const odd = access.parseKey(V.ed25519[0].replace('vec-ed25519@test', 'a\u0007b   c ' + 'x'.repeat(200)));
  assert.equal(odd.comment.length, 100, 'a comment is one short line');
  assert.ok(!/\u0007/.test(odd.comment));
  const many = access.parseKeys(['# a comment', '', V.ed25519[0], V.ed25519[0], V.weak[0], V.ecdsa[0]].join('\n'));
  assert.equal(many.keys.length, 2, 'each key once, the bad one left out');
  assert.equal(many.errors.length, 1);
});

test('access: the list sshd reads — local keys as given, fetched ones held to the policy, each key once', () => {
  const [ed, ec, rsa] = ['ed25519', 'ecdsa', 'rsa'].map(t => access.parseKey(V[t][0]));
  const policy = Object.assign(access.defaultPolicy(), { github: ['someone'], meganetKeys: true });
  const text = access.render(policy, { local: [ed], github: { someone: [ec, ed] }, meganet: [Object.assign({}, rsa, { comment: 'Jo Bloggs laptop' })] });
  const lines = text.split('\n').filter(l => l && !l.startsWith('#'));
  assert.equal(lines.length, 3, 'the Ed25519 key on two lists is written once, as the local one');
  assert.match(lines[0], /^ssh-ed25519 \S+ vec-ed25519@test$/, 'a local key carries no options');
  assert.ok(lines[1].startsWith('from="' + access.PRIVATE_FROM + '",no-agent-forwarding ecdsa-sha2-nistp256 '), 'a GitHub key works from private networks only');
  assert.match(lines[1], / github:someone$/);
  assert.match(lines[2], / meganet:Jo_Bloggs_laptop$/);
  const any = access.render(Object.assign({}, policy, { from: 'any' }), { local: [], github: { someone: [ec] }, meganet: [] });
  assert.ok(any.includes('no-agent-forwarding ecdsa-sha2-nistp256 ') && !any.includes('from="'), 'from anywhere: no from= at all');
});

test('access: local keys, the policy and the list on disk, read back with where each came from', async () => {
  const r = access.addLocalKeys([V.ed25519[0], V.rsa[0]]);
  assert.ok(r.ok, r.error);
  assert.equal(access.addLocalKeys([V.weak[0]]).ok, false, 'a weak key is refused, not added');
  assert.deepEqual(access.addLocalKeys([V.ed25519[0]]).added, [], 'a key already there is not added twice');
  const s = await access.sync({ fetch: false });
  assert.equal(s.keys, 2);
  const keys = fs.readFileSync(access.FILES.keys, 'utf8');
  assert.equal(fs.statSync(access.FILES.keys).mode & 0o777, 0o644, 'sshd reads it; only root writes it');
  assert.ok(keys.includes('ssh-ed25519 ') && keys.includes('ssh-rsa '));
  const listed = access.listed();
  assert.deepEqual(listed.map(k => [k.fingerprint, k.source, k.restricted]), [[V.ed25519[1], 'local', false], [V.rsa[1], 'local', false]]);
  assert.ok(access.removeLocalKey(V.rsa[1].slice(0, 20)).ok, 'removed by the start of its fingerprint');
  assert.equal(access.removeLocalKey('SHA256:nope-nope-nope').ok, false);
  await access.sync({ fetch: false });
  assert.equal(access.listed().length, 1);
  assert.throws(() => access.setPolicy('github', ['ok-name', 'bad name!']), /GitHub user name/);
  assert.throws(() => access.setPolicy('from', 'everywhere'), /private\|any/);
  assert.equal(access.setPolicy('meganet', 'on').meganetKeys, true);
  assert.equal(access.setPolicy('meganet', 'off').meganetKeys, false);
  assert.equal(access.loadPolicy().from, 'private', 'the default: fetched keys from private networks only');
});

test('access: MegaNet\'s team keys are fetched with the token, kept through an outage, and dropped when MegaNet refuses the token', async () => {
  let mode = 'ok';
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, token: req.headers['x-ingest-token'], profile: req.headers['content-profile'], body });
      if (mode === 'down') { res.writeHead(503); return res.end('{}'); }
      if (mode === 'refused') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"message":"invalid or revoked ingest token"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hash: 'h1', keys: [{ key: V.ecdsa[0].split(' ').slice(0, 2).join(' '), comment: 'jo@meganet', fingerprint: V.ecdsa[1] },
        { key: V.weak[0].split(' ').slice(0, 2).join(' '), comment: 'too weak' }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/rest/v1';
  fs.writeFileSync(process.env.RPI_ALERT_CONFIG, JSON.stringify({ meganet: { token: 'mgn_' + 'a'.repeat(64), endpoints: ['http://evil.invalid/rest/v1'] } }));
  const p = access.loadPolicy();
  access.savePolicy(Object.assign(p, { meganetKeys: true, meganetEndpoints: [url] }));

  let s = await access.sync();
  assert.equal(seen.length, 1, 'asked once — at the policy\'s address, never at the agent\'s settings\' (evil.invalid)');
  assert.equal(seen[0].url, '/rest/v1/rpc/base_station_keys');
  assert.equal(seen[0].token, 'mgn_' + 'a'.repeat(64));
  assert.equal(seen[0].profile, 'meganet');
  assert.ok(s.ok);
  assert.equal(s.meganetHash, 'h1');
  assert.ok(s.notes.some(n => /2048/.test(n)), 'the weak key is named and left out');
  let mg = access.listed().filter(k => k.source === 'meganet');
  assert.equal(mg.length, 1);
  assert.equal(mg[0].restricted, true, 'MegaNet\'s keys work from private networks only');
  assert.equal(mg[0].comment, 'meganet:jo@meganet');

  mode = 'down';
  s = await access.sync();
  assert.equal(s.ok, false);
  assert.equal(access.listed().filter(k => k.source === 'meganet').length, 1, 'an outage removes nobody');

  mode = 'refused';
  s = await access.sync();
  assert.equal(access.listed().filter(k => k.source === 'meganet').length, 0, 'a Pi MegaNet has disowned keeps no key MegaNet gave it');

  mode = 'ok';
  await access.sync();
  assert.equal(access.listed().filter(k => k.source === 'meganet').length, 1);
  access.setPolicy('meganet', 'off');
  await access.sync();
  assert.equal(access.listed().filter(k => k.source === 'meganet').length, 0, 'turned off: off the list at once');
  assert.ok(!fs.existsSync(access.FILES.meganet));
  await new Promise(r => server.close(r));
});

test('access: the sshd drop-in — Imager\'s password choice stands unless the policy says, and sshd checks it before it is kept', { skip: !hasSshd && 'no sshd here' }, () => {
  const dropDir = path.dirname(process.env.RPI_ALERT_SSHD_DROPIN);
  fs.mkdirSync(dropDir, { recursive: true });
  const hk = path.join(root, 'hostkey');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hk]);
  const good = 'Include ' + dropDir + '/*.conf\nHostKey ' + hk + '\nPasswordAuthentication yes\nUsePAM yes\n';
  fs.writeFileSync(process.env.RPI_ALERT_SSHD_CONFIG, good);

  const d = access.defaultPolicy();
  assert.ok(!/PasswordAuthentication/.test(access.dropinText(d)), 'unchanged: no word about passwords');
  assert.match(access.dropinText(d), new RegExp('AuthorizedKeysFile \\.ssh/authorized_keys \\.ssh/authorized_keys2 ' + access.DIR.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '/%u\\.keys'));
  const off = Object.assign({}, d, { passwordLogin: 'off' });
  let r = access.applyDropin(off);
  assert.ok(r.ok && r.changed, r.error);
  const eff = execFileSync('/usr/sbin/sshd', ['-T', '-f', process.env.RPI_ALERT_SSHD_CONFIG], { encoding: 'utf8' });
  assert.match(eff, /^passwordauthentication no$/m, 'the drop-in wins over the main file, as Debian includes it first');
  assert.match(eff, /^authorizedkeysfile .*%u\.keys$/m);
  assert.deepEqual(access.applyDropin(off), { ok: true, changed: false }, 'the same again: nothing written, nothing reloaded');

  // A configuration sshd will not start with is never left in place.
  fs.writeFileSync(process.env.RPI_ALERT_SSHD_CONFIG, good + 'ThisIsNotADirective yes\n');
  const before = fs.readFileSync(process.env.RPI_ALERT_SSHD_DROPIN, 'utf8');
  r = access.applyDropin(Object.assign({}, d, { passwordLogin: 'on' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /sshd refused/);
  assert.equal(fs.readFileSync(process.env.RPI_ALERT_SSHD_DROPIN, 'utf8'), before, 'the drop-in that worked is put back');
});
