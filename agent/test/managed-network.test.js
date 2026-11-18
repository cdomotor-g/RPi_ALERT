'use strict';
// 0.24 — the dashboard of a base station on a managed network, where somebody
// whose job it is asks what listens, who is let in, and what is on record.
// Each setting is as before until it is set:
//   web.bind          the address the dashboard listens on
//   web.hosts         more names it answers to
//   web.behindProxy   a reverse proxy on this machine publishes it
//   web.requireLogin  "all": nothing is read without a login
// and every login attempt is a line in the log, with the caller's address.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-managed-'));
// Before anything of the agent's is loaded: where its files are.
process.env.RPI_ALERT_DATA = path.join(TMP, 'data');
process.env.RPI_ALERT_WEBPW_FILE = path.join(TMP, 'data', 'web-password.txt');
fs.mkdirSync(process.env.RPI_ALERT_DATA, { recursive: true });

const { Config, defaults, validate, merge, hashPassword } = require('../lib/config');
const { WebServer, isLocal, hostAllowed, forwarded, callerAddress } = require('../lib/web/server');
const boot = require('../lib/bootconf');

const PASSWORD = 'correct horse battery';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 5000)) { if (await fn()) return true; await wait(20); } return false; }
const LINUX = process.platform === 'linux';   // 127.0.0.2 is this machine too, on Linux

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// A request as a caller would put it on the wire: the address to connect to,
// the Host it asks for, and any header — a list for one sent more than once.
function ask(port, o) {
  o = o || {};
  return new Promise((resolve) => {
    const headers = Object.assign({ Host: '127.0.0.1:' + port }, o.headers || {});
    let body = null;
    if (o.body !== undefined) { body = JSON.stringify(o.body); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const req = http.request({ host: o.to || '127.0.0.1', port, path: o.path || '/api/status', method: o.method || (body ? 'POST' : 'GET'), headers, agent: false, setHost: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    req.end(body || undefined);
  });
}

// The live stream, read until closed: what came, and whether the server ended it.
function stream(port, headers) {
  const got = { status: 0, text: '', ended: false, req: null };
  got.ready = new Promise((resolve) => {
    got.req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: Object.assign({ Host: '127.0.0.1:' + port }, headers || {}), agent: false, setHost: false }, (res) => {
      got.status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', (d) => { got.text += d; });
      res.on('end', () => { got.ended = true; });
      res.on('error', () => {});
      resolve(got);
    });
    got.req.on('error', () => resolve(got));
    got.req.end();
  });
  got.close = () => got.req.destroy();
  return got;
}

// A base station with nothing plugged in: the settings, and what the routes read.
async function station(webSettings, opts) {
  const dir = fs.mkdtempSync(path.join(TMP, 'bs-'));
  const config = new Config(path.join(dir, 'config.json')).load();
  const port = await freePort();
  const r = config.update({ web: Object.assign({ port, passwordHash: hashPassword(PASSWORD) }, webSettings || {}) });
  assert.ok(r.ok, r.errors.join('; '));
  const agent = new EventEmitter();
  Object.assign(agent, {
    config, board: {}, recent: [{ alert_id: 2088, eng: 14.3 }], bursts: [],
    history: { get: () => ({ points: [1, 2, 3] }) },
    stations: { search: () => [{ id: 'marburg' }], status: () => ({}) },
    status: async () => ({ version: 'test', location: { lat: -27.47, lon: 153.02 }, system: { hostname: 'bs', addresses: [{ address: '10.0.0.5' }] }, devices: { ports: [], sdrs: [] } }),
  });
  config.on('change', (changed) => agent.emit('config', changed));
  const web = new WebServer(agent);
  const log = [];
  web.log = { debug() {}, info: (m) => log.push(['info', String(m)]), warn: (m) => log.push(['warn', String(m)]), error: (m) => log.push(['error', String(m)]) };
  Object.assign(web, opts || {});
  web.start();
  assert.ok(await until(async () => (await ask(port, { path: '/api/status' })).status !== 0), 'the dashboard comes up on 127.0.0.1');
  return { web, config, agent, port, log, logins: () => log.filter(l => /^login /.test(l[1])), said: (level, re) => log.filter(l => l[0] === level && re.test(l[1])).map(l => l[1]), stop: () => web.stop() };
}

// A request as the web server sees it.
function reqOf(remoteAddress, headers, raw) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = v;
  const rawHeaders = raw || Object.entries(headers || {}).flatMap(([k, v]) => [k, v]);
  return { socket: { remoteAddress }, headers: h, rawHeaders };
}
const OUTSIDE = { 'X-Forwarded-For': '203.0.113.7' };   // as a proxy on this machine forwards an outside caller

// ── the settings ─────────────────────────────────────────────────────────────

test('settings: each is as before 0.24 until set, and a bad value is refused with a reason', () => {
  const d = defaults().web;
  assert.deepEqual([d.bind, d.hosts, d.behindProxy, d.requireLogin], ['', [], false, 'settings']);
  const c = new Config(path.join(fs.mkdtempSync(path.join(TMP, 'cfg-')), 'config.json')).load();
  // A settings file from before 0.24 has none of them.
  fs.writeFileSync(c.file, JSON.stringify({ version: 3, name: 'Old', web: { port: 8081, passwordHash: '' } }));
  const old = new Config(c.file).load();
  assert.equal(old.loadError, null);
  assert.deepEqual(old.get().web, { port: 8081, passwordHash: '', bind: '', hosts: [], behindProxy: false, requireLogin: 'settings' });

  assert.ok(c.update({ web: { bind: '127.0.0.1', hosts: ['bs01.council.example'], behindProxy: true, requireLogin: 'all' } }).ok);
  assert.ok(c.update({ web: { bind: '::1' } }).ok, 'an IPv6 address');
  assert.ok(c.update({ web: { bind: '' } }).ok, 'and back to every interface');
  const bad = (web, re) => assert.match(c.update({ web }).errors.join('; '), re, JSON.stringify(web));
  bad({ bind: 'eth0' }, /web\.bind: one of this machine's addresses/);
  // "Every interface" is the empty setting, never an address, however it is spelt.
  for (const every of ['0.0.0.0', '::', '0::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', '::0.0.0.0', '::%eth0', '0::0%eth0', '::ffff:0.0.0.0%lo']) bad({ bind: every }, /web\.bind/);
  // (The interface an address is on, after a %, does not make "every address" one address — and is no bar to one.)
  assert.deepEqual(validate(merge(defaults(), { web: { bind: 'fe80::1%eth0' } })), []);
  bad({ bind: 'bs01.council.example' }, /web\.bind/);
  bad({ hosts: 'bs01.council.example' }, /web\.hosts: a list/);
  bad({ hosts: ['two words'] }, /web\.hosts/);
  bad({ hosts: ['evil.example/path'] }, /web\.hosts/);
  bad({ hosts: new Array(17).fill('a.example') }, /web\.hosts: a list of up to 16/);
  bad({ behindProxy: 'yes' }, /web\.behindProxy: true or false/);
  bad({ requireLogin: 'none' }, /web\.requireLogin: one of settings, all/);
  // None of them is a secret: they are shown with the rest.
  assert.deepEqual(c.redacted().web.hosts, ['bs01.council.example']);
});

test('settings: one that is there but cannot be read becomes the cautious value, never the open one', () => {
  const file = path.join(fs.mkdtempSync(path.join(TMP, 'cfg-')), 'config.json');
  // A slip of the hand in config.json: an address mistyped, "yes" for true, "al" for all.
  fs.writeFileSync(file, JSON.stringify({ version: 3, name: 'Kept', web: { port: 8082, bind: '127.0.0.l', behindProxy: 'yes', requireLogin: 'al', hosts: 'bs01' } }));
  const c = new Config(file).load();
  assert.deepEqual(c.get().web, { port: 8082, passwordHash: '', bind: '127.0.0.1', hosts: [], behindProxy: true, requireLogin: 'all' });
  assert.equal(c.get().name, 'Kept');
  assert.match(c.loadError, /web\.bind/);
  assert.match(c.loadError, /the cautious value/);
  assert.deepEqual(validate(c.get()), []);
});

test('settings: a config.json that cannot be read as a whole does not open the dashboard it was written to close', () => {
  const load = (text) => {
    const file = path.join(fs.mkdtempSync(path.join(TMP, 'cfg-')), 'config.json');
    fs.writeFileSync(file, text);
    return new Config(file).load();
  };
  const closed = { bind: '127.0.0.1', hosts: ['bs01.council.example'], behindProxy: true, requireLogin: 'all' };
  const good = JSON.stringify({ version: 3, name: 'Depot', web: Object.assign({ port: 8083, passwordHash: '' }, closed) }, null, 2);
  assert.deepEqual([load(good).loadError, load(good).get().web.bind], [null, '127.0.0.1']);
  const open = { port: 80, passwordHash: '', bind: '', hosts: [], behindProxy: false, requireLogin: 'settings' };
  const shut = Object.assign({}, open, { bind: '127.0.0.1', behindProxy: true, requireLogin: 'all' });

  // A comma too many, a comment, half a file: nothing of it can be used — but its text shows what it set.
  for (const [what, text] of [['a comma too many', good.replace(/\n}$/, ',\n}')], ['a comment', '// the depot\n' + good], ['cut short', good.slice(0, good.indexOf('"requireLogin"') + 22)]]) {
    const c = load(text);
    assert.deepEqual(c.get().web, shut, what);
    assert.match(c.loadError, /^settings file is not valid JSON \(.*\); starting from defaults — but for web\.bind, web\.behindProxy, web\.requireLogin, which the file set: the cautious value \(this machine only, a proxy in front, a login for everything\), the file is kept as \.bad$/, what);
    assert.equal(c.get().name, '', 'the rest is as it comes, as before');
    assert.ok(fs.existsSync(c.file + '.bad'));
  }
  // Only what the text shows was set: the others are as they come.
  const one = load('{ "web": { "requireLogin": "all", } }');
  assert.deepEqual(one.get().web, Object.assign({}, open, { requireLogin: 'all' }));
  assert.match(one.loadError, /but for web\.requireLogin, which the file set/);
  // Under the spelling rpi-alert.conf has, too.
  assert.deepEqual(load('web_bind = 127.0.0.1\nweb_behind_proxy = yes\n').get().web, Object.assign({}, open, { bind: '127.0.0.1', behindProxy: true }));
  // A base station that never set them stays as before 0.24: a file that names none of them…
  const never = load('{ "name": "Old", "web": { "port": 80, "passwordHash": "" }, }');
  assert.deepEqual(never.get().web, open);
  assert.match(never.loadError, /^settings file is not valid JSON \(.*\); starting from defaults, the file is kept as \.bad$/);
  // …and one the agent itself saved, which names them all as they come.
  const saved = JSON.stringify({ version: 3, name: 'Old', web: open }, null, 2);
  assert.deepEqual(load(saved.replace(/\n}$/, ',\n}')).get().web, open);
  // Not a set of settings at all.
  for (const text of ['null', '[]', '"web.bind"', '42']) assert.match(load(text).loadError, /not valid JSON \(it is not a set of settings in \{ \}\)/, text);
  assert.deepEqual(load('[{ "bind": "10.0.0.5" }]').get().web, Object.assign({}, open, { bind: '127.0.0.1' }));

  // There, but not to be read at all (here: a folder where the file should be): what it set cannot be known.
  const dir = fs.mkdtempSync(path.join(TMP, 'cfg-'));
  fs.mkdirSync(path.join(dir, 'config.json'));
  const unread = new Config(path.join(dir, 'config.json')).load();
  assert.deepEqual(unread.get().web, shut);
  assert.match(unread.loadError, /is not a plain file — not read; starting from defaults — but for the dashboard, the cautious values, since what the file set cannot be known/);
  // No file at all — a new base station — is as it comes.
  const fresh = new Config(path.join(dir, 'none.json')).load();
  assert.deepEqual([fresh.get().web, fresh.loadError], [open, null]);
});

test('settings: a slip in another part of config.json costs that part, and a misspelt one of the dashboard\'s own is the cautious value', () => {
  const load = (o) => {
    const file = path.join(fs.mkdtempSync(path.join(TMP, 'cfg-')), 'config.json');
    fs.writeFileSync(file, JSON.stringify(o));
    return new Config(file).load();
  };
  // "meganet": "off" where a group of settings belongs: that group is as it comes, and the rest of the file is kept.
  const group = load({ version: 3, name: 'Depot', meganet: 'off', web: { port: 8084, bind: '127.0.0.1', requireLogin: 'all' } });
  assert.deepEqual([group.get().name, group.get().web.bind, group.get().web.requireLogin, group.get().web.port, group.get().meganet.enabled], ['Depot', '127.0.0.1', 'all', 8084, true]);
  assert.match(group.loadError, /^settings file has problems \(defaults used for them\): meganet: a group of settings, in \{ \}$/);
  assert.deepEqual(validate(group.get()), []);
  // The dashboard's own group: nothing of it can be read, so its three are the cautious values.
  const web = load({ version: 3, name: 'Depot', web: 'closed' });
  assert.deepEqual(web.get().web, { port: 80, passwordHash: '', bind: '127.0.0.1', hosts: [], behindProxy: true, requireLogin: 'all' });
  assert.match(web.loadError, /the cautious value: this machine only, a proxy in front, a login for everything\): web: a group of settings/);
  assert.equal(load({ receivers: { sdr: 'off' } }).get().receivers.sdr.freqHz, 151500000, 'a group inside a group, too');

  // Spelt as rpi-alert.conf spells them, or without the capital: somebody meant to set them.
  const slip = load({ version: 3, web: { port: 8085, require_login: 'all', behindproxy: true, 'web-bind': '127.0.0.1' } });
  assert.deepEqual([slip.get().web.requireLogin, slip.get().web.behindProxy, slip.get().web.bind, slip.get().web.port], ['all', true, '127.0.0.1', 8085]);
  assert.match(slip.loadError, /web\.require_login is not a setting — web\.requireLogin is how it is spelt/);
  assert.match(slip.loadError, /web\.behindproxy is not a setting — web\.behindProxy is how it is spelt/);
  assert.match(slip.loadError, /the cautious value/);
  // With the setting itself there, it is what counts; the other is said and left.
  const both = load({ version: 3, web: { requireLogin: 'settings', require_login: 'all' } });
  assert.equal(both.get().web.requireLogin, 'settings');
  assert.equal(both.loadError, 'settings file: not settings the agent knows, and ignored: web.require_login');
  // Any other key the agent does not know: said, nothing changed.
  const odd = load({ version: 3, web: { port: 8086, tls: true } });
  assert.deepEqual([odd.get().web.port, odd.get().web.bind], [8086, '']);
  assert.equal(odd.loadError, 'settings file: not settings the agent knows, and ignored: web.tls');
});

test('settings: Flood-Net cannot change them, and neither can a login from another computer', async () => {
  const { checkPatch } = require('../lib/remote');
  assert.match(checkPatch({ web: { bind: '' } }), /web is set on the base station itself/);
  assert.match(checkPatch({ web: { requireLogin: 'settings' } }), /set on the base station itself/);

  const s = await station({ hosts: ['bs01.council.example'], requireLogin: 'all' });
  try {
    const login = await ask(s.port, { path: '/api/login', headers: OUTSIDE, body: { password: PASSWORD } });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const put = (web, headers) => ask(s.port, { path: '/api/config', method: 'PUT', headers: Object.assign({ Cookie: cookie }, headers), body: { config: { web } } });
    for (const [web, key] of [[{ requireLogin: 'settings' }, 'requireLogin'], [{ bind: '10.0.0.5' }, 'bind'], [{ hosts: [] }, 'hosts'], [{ hosts: ['bs01.council.example', 'evil.example'] }, 'hosts'], [{ behindProxy: true }, 'behindProxy']]) {
      const r = await put(web, OUTSIDE);
      assert.equal(r.status, 403, JSON.stringify(web));
      assert.match(r.json.error, new RegExp('web\\.' + key + ' can only be changed on the base station itself'));
    }
    assert.equal(s.config.get().web.requireLogin, 'all', 'nothing was opened');
    // A form sending back what is already set saves as before.
    assert.equal((await put({ requireLogin: 'all', hosts: ['bs01.council.example'], bind: '', behindProxy: false }, OUTSIDE)).status, 200);
    // On the base station itself (rpi-alert config set), they change.
    const local = await ask(s.port, { path: '/api/config', method: 'PUT', body: { config: { web: { requireLogin: 'settings' } } } });
    assert.deepEqual([local.status, local.json.changed], [200, ['web.requireLogin']]);
  } finally { s.stop(); }
});

test('settings file: web_bind, web_hosts, web_behind_proxy and web_require_login', () => {
  const { patch, notes } = boot.toPatch(boot.parse('web_bind = 127.0.0.1\nweb_hosts = BS01.council.example, alert.council.example\nweb_behind_proxy = yes\nweb_require_login = all\n'));
  assert.deepEqual(patch.web, { bind: '127.0.0.1', hosts: ['bs01.council.example', 'alert.council.example'], behindProxy: true, requireLogin: 'all' });
  assert.deepEqual(notes, []);
  assert.deepEqual(validate(merge(defaults(), patch)), [], 'and the settings take them');
  const web = (text) => boot.toPatch(boot.parse(text)).patch.web;
  assert.equal(web('web_bind = localhost\n').bind, '127.0.0.1');
  assert.equal(web('web_bind = [::1]\n').bind, '::1');
  for (const every of ['all', 'any', '0.0.0.0', '::', '*']) assert.equal(web('web_bind = ' + every + '\n').bind, '', every + ': every interface');
  assert.deepEqual(web('web_hosts = none\n').hosts, []);
  assert.equal(web('web_behind_proxy = no\n').behindProxy, false);
  assert.equal(web('web_require_login = yes\n').requireLogin, 'all');
  assert.equal(web('web_require_login = settings\n').requireLogin, 'settings');
  // One that cannot be read is left as it was — and costs the others on the card nothing.
  const slip = boot.toPatch(boot.parse('web_bind = 10.0.0.300\nweb_hosts = two words; bad/name\nweb_behind_proxy = maybe\nweb_require_login = some\nweb_password = hunter2hunter2\n'));
  assert.deepEqual(Object.keys(slip.patch.web), ['passwordHash']);
  assert.equal(slip.notes.length, 4);
  for (const k of ['web_bind', 'web_hosts', 'web_behind_proxy', 'web_require_login']) assert.ok(slip.notes.some(n => n.startsWith(k + ':') && /not changed/.test(n)), k);
});

// ── web.bind ─────────────────────────────────────────────────────────────────

test('web.bind: empty is every interface, as before; 127.0.0.1 keeps the dashboard off the network', { skip: !LINUX && '127.0.0.2 is this machine on Linux only' }, async () => {
  const every = await station();
  try {
    assert.equal((await ask(every.port, { to: '127.0.0.2' })).status, 200, 'every interface: another of this machine\'s addresses answers');
    assert.equal(every.said('info', /dashboard on http:\/\/.*\.local/).length, 1);
  } finally { every.stop(); }

  const only = await station({ bind: '127.0.0.1' });
  try {
    assert.equal((await ask(only.port)).status, 200, 'the rpi-alert command asks 127.0.0.1');
    assert.equal((await ask(only.port, { to: '127.0.0.2' })).error, 'ECONNREFUSED', 'no other address answers');
    const other = Object.values(os.networkInterfaces()).flat().find(a => a && !a.internal && (a.family === 'IPv4' || a.family === 4));
    if (other) assert.equal((await ask(only.port, { to: other.address })).error, 'ECONNREFUSED', 'nor the network\'s (' + other.address + ')');
    assert.deepEqual(only.said('info', /this machine only \(web\.bind\)/).length, 1);
  } finally { only.stop(); }
});

test('web.bind: an address, and this machine\'s own beside it for the rpi-alert command', { skip: !LINUX && '127.0.0.2 is this machine on Linux only' }, async () => {
  const s = await station({ bind: '127.0.0.2' });
  try {
    assert.ok(await until(async () => (await ask(s.port, { to: '127.0.0.2' })).status === 200), 'the address answers');
    assert.equal((await ask(s.port)).status, 200, 'and so does 127.0.0.1');
    assert.deepEqual([s.web.server.maxHeadersCount, s.web.also.maxHeadersCount], [0, 0], 'both keep every header line of a request');
    assert.equal((await ask(s.port, { to: '127.0.0.3' })).error, 'ECONNREFUSED', 'nothing else does');
  } finally { s.stop(); }
});

test('web.bind: an address the machine does not have — the agent carries on, the dashboard on this machine only', { skip: !LINUX && '127.0.0.2 is this machine on Linux only' }, async () => {
  const mine = new Set(Object.values(os.networkInterfaces()).flat().map(a => a && a.address));
  const absent = ['192.0.2.77', '198.51.100.77', '203.0.113.77'].find(a => !mine.has(a));
  const s = await station({ bind: absent }, { bindRetryMs: 40 });
  try {
    assert.ok(await until(() => s.said('warn', /cannot listen/).length > 0), 'it says so');
    const said = s.said('warn', /cannot listen/);
    assert.match(said[0], new RegExp('cannot listen on http://' + absent.replace(/\./g, '\\.') + ':' + s.port + '/ \\(EADDRNOTAVAIL: this machine does not have that address\\)'));
    assert.match(said[0], /the dashboard is on this machine only \(127\.0\.0\.1\) until it can/);
    assert.equal((await ask(s.port)).status, 200, 'the rpi-alert command still reaches it');
    // Failing closed: an address that cannot be had is not a reason to listen everywhere.
    assert.equal((await ask(s.port, { to: '127.0.0.2' })).error, 'ECONNREFUSED');
    await wait(200);
    assert.equal(s.said('warn', /cannot listen/).length, 1, 'said once, not at every try');
    assert.equal(s.said('error', /./).length, 0);
  } finally { s.stop(); }
});

test('web.bind: an address that cannot be had yet is taken when it can be', { skip: !LINUX && '127.0.0.2 is this machine on Linux only' }, async () => {
  // Something else holds the address and port, as an address DHCP has not given yet is not there to hold.
  const blocker = net.createServer();
  const s = await station({ bind: '127.0.0.2' }, { bindRetryMs: 40, alsoOn(onRequest, addr) {
    if (!blocker.listening && !this.blocked) { this.blocked = true; return blocker.listen(this.port, addr, () => WebServer.prototype.alsoOn.call(this, onRequest, addr)); }
    return WebServer.prototype.alsoOn.call(this, onRequest, addr);
  } });
  try {
    assert.ok(await until(() => s.said('warn', /cannot listen on http:\/\/127\.0\.0\.2:\d+\/ \(EADDRINUSE\)/).length > 0), 'refused, and said');
    assert.equal((await ask(s.port)).status, 200, '127.0.0.1 meanwhile');
    await new Promise(r => blocker.close(r));
    assert.ok(await until(async () => (await ask(s.port, { to: '127.0.0.2' })).json != null), 'taken at a later try');
    assert.equal(s.said('info', /dashboard on http:\/\/127\.0\.0\.2/).length, 1);
  } finally { s.stop(); if (blocker.listening) blocker.close(); }
});

// ── web.hosts ────────────────────────────────────────────────────────────────

test('web.hosts: a name from the organisation\'s DNS is answered, on top of the rules before', async () => {
  const req = (host) => ({ headers: { host } });
  assert.ok(!hostAllowed(req('bs01.council.example')), 'refused until it is listed');
  assert.ok(!hostAllowed(req('bs01.council.example'), []));
  const hosts = ['bs01.council.example', 'Alert.Council.Example'];
  for (const h of ['bs01.council.example', 'BS01.Council.Example:80', 'bs01.council.example.', 'alert.council.example:8443']) assert.ok(hostAllowed(req(h), hosts), h);
  for (const h of ['evil.example', 'bs01.council.example.evil.example', 'xbs01.council.example', 'council.example']) assert.ok(!hostAllowed(req(h), hosts), h + ' is still refused');
  for (const h of ['localhost', 'rpi-alert.local', '192.168.1.50', '[fe80::1]:80', os.hostname()]) assert.ok(hostAllowed(req(h), hosts), h + ' as before');

  const s = await station();
  try {
    const named = { 'X-Forwarded-For': '203.0.113.7', Host: 'bs01.council.example' };
    const before = await ask(s.port, { headers: named });
    assert.deepEqual([before.status, before.text], [403, 'unrecognised Host header']);
    assert.ok(s.config.update({ web: { hosts: ['bs01.council.example'] } }).ok);
    assert.equal((await ask(s.port, { headers: named })).status, 200, 'at once, with no restart');
    assert.equal((await ask(s.port, { headers: Object.assign({}, named, { Host: 'other.council.example' }) })).status, 403);
  } finally { s.stop(); }
});

// ── web.behindProxy ──────────────────────────────────────────────────────────

test('behindProxy off: this machine\'s own callers are told apart as before 0.24', () => {
  const off = { behindProxy: false };
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLocal(reqOf(a, {}), off), true, a);
    assert.equal(isLocal(reqOf(a, {})), true, a + ' (no settings given)');
    assert.equal(isLocal(reqOf(a, { 'X-Forwarded-For': '203.0.113.7' }), off), false, a + ' with X-Forwarded-For');
    assert.equal(isLocal(reqOf(a, { Host: 'bs01.council.example', Forwarded: 'for=203.0.113.7' }), off), true, a + ': only X-Forwarded-For counted, as before');
  }
  for (const a of ['192.168.1.20', '::ffff:192.168.1.20', '10.42.0.7', 'fe80::1', '127.0.0.2', '', undefined]) assert.equal(isLocal(reqOf(a, {}), off), false, String(a));
  // The caller's address is the connection's; a header from the network is not believed.
  assert.equal(callerAddress(reqOf('::ffff:192.168.1.20', { 'X-Forwarded-For': '10.9.9.9' }), off), '192.168.1.20');
  assert.equal(callerAddress(reqOf('127.0.0.1', { 'X-Forwarded-For': '10.9.9.9' }), off), '127.0.0.1');
});

test('behindProxy off: what it would close is still let in, as before 0.24 — and now it is said in the log', async () => {
  const s = await station();
  try {
    // The command and the screen: nothing to say.
    assert.equal((await ask(s.port, { path: '/api/config' })).status, 200);
    assert.equal((await ask(s.port, { path: '/api/config', headers: { Host: 'localhost:' + s.port } })).status, 200);
    assert.equal((await ask(s.port, { path: '/api/config', headers: { Host: os.hostname() } })).status, 200, 'by the computer\'s own name');
    assert.equal(s.said('warn', /was taken for the base station itself/).length, 0);
    // A page in a browser on this machine, its name pointed at this machine: let in as before — and said.
    const rebound = await ask(s.port, { path: '/api/config', headers: { Host: 'evil.example', Origin: 'http://evil.example' } });
    assert.equal(rebound.status, 200, 'as before 0.24');
    const said = s.said('warn', /was taken for the base station itself/);
    assert.equal(said.length, 1);
    assert.match(said[0], /^a request from this machine itself, asking for "evil\.example", was taken for the base station itself, as every such request is while web\.behindProxy is off\. If a web browser or a reverse proxy runs on this machine, turn it on: rpi-alert config set web\.behindProxy true/);
    // Now and then, not each time: anyone on the machine can send one.
    assert.equal((await ask(s.port, { path: '/api/config', headers: { Host: 'evil.example' } })).status, 200);
    assert.equal(s.said('warn', /was taken for the base station itself/).length, 1);
    // A proxy that says whom it forwards for in another header than X-Forwarded-For: the same.
    s.web.ownDoubtAt = 0;
    assert.equal((await ask(s.port, { path: '/api/config', headers: { 'X-Real-IP': '203.0.113.7', Forwarded: 'for=203.0.113.7' } })).status, 200, 'as before 0.24');
    assert.match(s.said('warn', /was taken for the base station itself/)[1], /^a request from this machine itself, with a reverse proxy's header but no X-Forwarded-For, was taken/);
    // With web.behindProxy on, neither is let in.
    assert.ok(s.config.update({ web: { behindProxy: true } }).ok);
    assert.equal((await ask(s.port, { path: '/api/config', headers: { Host: 'evil.example', Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await ask(s.port, { path: '/api/config', headers: { 'X-Real-IP': '203.0.113.7', Forwarded: 'for=203.0.113.7' } })).status, 401);
    // …and turning it on says, once, the one thing the agent cannot see for itself.
    assert.equal(s.said('info', /^web\.behindProxy is on: .*as long as the proxy adds X-Forwarded-For to every request\. Check it from another computer: curl -H 'Host: localhost'/).length, 1);
  } finally { s.stop(); }
});

test('behindProxy: a forwarded request is never this machine\'s own — every way of trying', () => {
  const on = { behindProxy: true };
  const local = (addr, headers, raw) => isLocal(reqOf(addr, headers, raw), on);
  const cli = { Host: '127.0.0.1:8080' };
  // The rpi-alert command and the screen's browser: this machine's address, no proxy's header, its own name.
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(local(a, cli), true, a + ', as the command asks');
    assert.equal(local(a, { Host: 'localhost' }), true, a + ', as the screen asks');
    assert.equal(local(a, { Host: '[::1]:80' }), true);
  }
  // Each header a proxy may add, alone, under any spelling.
  for (const h of ['X-Forwarded-For', 'x-forwarded-for', 'X-FORWARDED-FOR', 'x-FoRwArDeD-fOr', 'Forwarded', 'FORWARDED', 'X-Real-IP', 'x-real-ip', 'X-REAL-IP',
    'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Forwarded-Port', 'X-Forwarded', 'Via', 'X-Client-IP', 'True-Client-IP', 'CF-Connecting-IP']) {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(local(a, Object.assign({ [h]: '203.0.113.7' }, cli)), false, h + ' from ' + a);
    assert.equal(forwarded(reqOf('127.0.0.1', { [h]: 'x' })), true, h);
  }
  // Its value does not matter: this machine's own address, nonsense, nothing at all.
  for (const v of ['127.0.0.1', '::1', 'localhost', 'unknown', '', ' ', ',', '127.0.0.1, 127.0.0.1']) assert.equal(local('127.0.0.1', Object.assign({ 'X-Forwarded-For': v }, cli)), false, JSON.stringify(v));
  // Sent twice, or empty: Node's tidied list reads an empty header as none — the names as sent are asked.
  assert.equal(local('127.0.0.1', { host: '127.0.0.1' }, ['Host', '127.0.0.1', 'X-Forwarded-For', '', 'X-Forwarded-For', '']), false, 'twice, empty');
  assert.equal(isLocal({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1' }, rawHeaders: ['Host', '127.0.0.1', 'X-Real-Ip', ''] }, on), false, 'in the raw list only');
  assert.equal(isLocal({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1', forwarded: '' } }, on), false, 'in the tidied list only');
  // A connection that has carried a forwarded request is the proxy's for good.
  assert.equal(isLocal({ socket: { remoteAddress: '127.0.0.1', rpaProxy: true }, headers: { host: '127.0.0.1' }, rawHeaders: ['Host', '127.0.0.1'] }, on), false);
  // A proxy that passes the browser's Host on but adds no header of its own: not this machine's name.
  for (const h of ['bs01.council.example', 'rpi-alert.local', '192.168.1.50', '10.42.0.1', 'localhost.evil.example', '127.0.0.1.evil.example', 'evil.example:127', '', undefined]) {
    assert.equal(local('127.0.0.1', h === undefined ? {} : { Host: h }), false, 'Host ' + JSON.stringify(h));
  }
  assert.equal(local('127.0.0.1', { host: 'localhost' }, ['Host', 'localhost', 'Host', 'bs01.council.example']), false, 'two Hosts');
  // A proxy that adds nothing and asks for 127.0.0.1 itself: a browser still says which page sent it.
  for (const page of ['http://localhost/', 'http://localhost:8080/#set-sdr', 'http://127.0.0.1:8080', 'http://[::1]/']) {
    assert.equal(local('127.0.0.1', Object.assign({ Origin: page, Referer: page }, cli)), true, 'the screen\'s own page, ' + page);
  }
  for (const page of ['https://bs01.council.example', 'https://bs01.council.example/', 'http://192.168.1.50/', 'http://localhost.evil.example/', 'null', '', 'localhost']) {
    assert.equal(local('127.0.0.1', Object.assign({ Origin: page }, cli)), false, 'Origin ' + JSON.stringify(page));
    assert.equal(local('127.0.0.1', Object.assign({ Referer: page }, cli)), false, 'Referer ' + JSON.stringify(page));
  }
  // nginx, left as it comes, adds no header, asks for 127.0.0.1 by name — and speaks HTTP/1.0, which nothing on this machine does.
  const v = (httpVersion, web) => isLocal(Object.assign(reqOf('127.0.0.1', cli), { httpVersion }), web);
  assert.deepEqual([v('1.0', on), v('1.1', on), v('1.0', { behindProxy: false })], [false, true, true]);
  // From the network nothing is this machine's own, whatever it says of itself.
  for (const a of ['192.168.1.20', '::ffff:192.168.1.20', '203.0.113.7', 'fe80::1', '127.0.0.2', '']) assert.equal(local(a, { Host: 'localhost' }), false, a);
  assert.equal(forwarded(reqOf('127.0.0.1', { Host: 'localhost', 'User-Agent': 'node', Accept: '*/*', Cookie: 'x-forwarded-for=1', 'Accept-Language': '*' })), false, 'the command\'s own headers are none of them');
});

test('behindProxy: the caller\'s address is the one the proxy saw, and only from the proxy', () => {
  const on = { behindProxy: true };
  const from = (addr, xff) => callerAddress(reqOf(addr, xff === undefined ? {} : { 'X-Forwarded-For': xff }), on);
  assert.equal(from('127.0.0.1', '203.0.113.7'), '203.0.113.7');
  assert.equal(from('::1', '203.0.113.7'), '203.0.113.7');
  assert.equal(from('::ffff:127.0.0.1', '2001:db8::7'), '2001:db8::7');
  // The last address is the proxy's own; what comes before is whatever the caller sent.
  assert.equal(from('127.0.0.1', '10.0.0.1, 127.0.0.1, 203.0.113.7'), '203.0.113.7');
  assert.equal(from('127.0.0.1', '8.8.8.8,203.0.113.7'), '203.0.113.7', 'two header lines, joined');
  assert.equal(from('127.0.0.1', '203.0.113.7:51234'), '203.0.113.7', 'with a port');
  assert.equal(from('127.0.0.1', '[2001:db8::7]:51234'), '2001:db8::7');
  assert.equal(from('127.0.0.1', '::ffff:203.0.113.7'), '203.0.113.7');
  // Nothing usable: the connection's own address, which every such caller then shares.
  for (const junk of ['', 'unknown', 'not an address', '203.0.113.7, evil', '999.1.1.1', '<script>']) assert.equal(from('127.0.0.1', junk), '127.0.0.1', JSON.stringify(junk));
  assert.equal(from('127.0.0.1', undefined), '127.0.0.1');
  // Straight from the network, past the proxy: the header is not believed.
  assert.equal(from('192.168.1.20', '127.0.0.1'), '192.168.1.20');
  assert.equal(from('::ffff:192.168.1.20', '10.9.9.9'), '192.168.1.20');
});

test('behindProxy: over HTTP — outside callers log in, the rpi-alert command does not have to', async () => {
  fs.writeFileSync(process.env.RPI_ALERT_WEBPW_FILE, 'ABCDE-23456\n');
  const s = await station({ behindProxy: true, hosts: ['bs01.council.example'] });
  const via = (extra) => Object.assign({ 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https', Host: 'bs01.council.example' }, extra || {});
  try {
    // The command on the machine itself: let in, and shown the first password.
    const cli = await ask(s.port);
    assert.deepEqual([cli.status, cli.json.auth.local, cli.json.auth.authed, cli.json.auth.initialPassword], [200, true, true, 'ABCDE-23456']);
    assert.equal((await ask(s.port, { path: '/api/config' })).status, 200);
    assert.equal((await ask(s.port, { path: '/api/config', headers: { Host: 'localhost:' + s.port } })).status, 200, 'the screen');

    // Through the proxy: a visitor, who sees neither the settings, the first password nor where it is.
    const out = await ask(s.port, { headers: via() });
    assert.deepEqual([out.status, out.json.auth.local, out.json.auth.authed, out.json.auth.initialPassword, out.json.location.lat, out.json.system.addresses],
      [200, false, false, undefined, undefined, undefined]);
    assert.equal((await ask(s.port, { path: '/api/config', headers: via() })).status, 401);
    // …whichever header the proxy uses, however it is spelt, even empty or sent twice.
    for (const h of [{ Forwarded: 'for=203.0.113.7;proto=https' }, { 'X-Real-IP': '203.0.113.7' }, { 'x-FORWARDED-for': '127.0.0.1' }, { 'X-Forwarded-For': '' },
      { 'X-Forwarded-For': ['127.0.0.1', '127.0.0.1'] }, { 'X-Forwarded-Host': 'bs01.council.example' }, { Via: '1.1 proxy' }]) {
      const r = await ask(s.port, { path: '/api/config', headers: h });
      assert.equal(r.status, 401, JSON.stringify(h) + ' — asking for 127.0.0.1 by name does not help');
      assert.equal((await ask(s.port, { headers: h })).json.auth.initialPassword, undefined, JSON.stringify(h));
    }
    // A proxy that adds no header at all but passes the browser's Host on: a visitor — and the log says what is wrong, once.
    assert.equal(s.said('warn', /reverse proxy/).length, 0, 'nothing to say while the proxy does its part');
    assert.equal((await ask(s.port, { path: '/api/config', headers: { Host: 'bs01.council.example' } })).status, 401);
    assert.equal((await ask(s.port, { path: '/api/config', headers: { Host: 'evil.example' } })).status, 403, 'and the Host guard holds for it');
    // …or its own address in Host: the page a browser came from still gives it away.
    assert.equal((await ask(s.port, { path: '/api/config', headers: { Referer: 'https://bs01.council.example/' } })).status, 401);
    const doubt = s.said('warn', /reverse proxy/);
    assert.equal(doubt.length, 1);
    assert.match(doubt[0], /^a request from this machine itself, asking for "bs01\.council\.example", carried none of a reverse proxy's headers\. web\.behindProxy is on: .*the proxy is not adding X-Forwarded-For.* Treated as a visitor$/);
    // A WebSocket upgrade is an ordinary request here: there is nothing to upgrade to.
    assert.equal((await ask(s.port, { path: '/api/config', headers: via({ Connection: 'Upgrade', Upgrade: 'websocket' }) })).status, 401);

    // What only this machine may do stays this machine's: where readings go, and removing the password.
    const login = await ask(s.port, { path: '/api/login', headers: via({ Origin: 'https://bs01.council.example' }), body: { password: PASSWORD } });
    assert.equal(login.status, 200);
    assert.match(login.headers['set-cookie'][0], /; HttpOnly; SameSite=Strict; Secure$/, 'the proxy said HTTPS: the cookie is for HTTPS only');
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    assert.equal((await ask(s.port, { path: '/api/config', headers: via({ Cookie: cookie }) })).status, 200, 'logged in');
    const repoint = await ask(s.port, { path: '/api/config', method: 'PUT', headers: via({ Cookie: cookie }), body: { config: { meganet: { endpoints: ['https://evil.example/rest/v1'] } } } });
    assert.equal(repoint.status, 403);
    assert.equal((await ask(s.port, { path: '/api/password', headers: via({ Cookie: cookie }), body: { remove: true } })).status, 403);

    // The same-origin check: the proxy passes the browser's Host on unchanged, so its Origin matches…
    assert.equal((await ask(s.port, { path: '/api/logout', headers: via({ Origin: 'https://bs01.council.example' }), body: {} })).status, 200);
    // …and another site's does not, nor "null", nor a proxy that put its own address in Host.
    for (const h of [via({ Origin: 'https://evil.example' }), via({ Origin: 'null' }), via({ Origin: 'https://bs01.council.example', Host: '127.0.0.1:' + s.port })]) {
      const r = await ask(s.port, { path: '/api/login', headers: h, body: { password: PASSWORD } });
      assert.deepEqual([r.status, r.json.error], [403, 'cross-site request refused'], JSON.stringify(h));
    }
    // Plain HTTP through the proxy: no Secure, or the browser would never send the cookie back.
    const plain = await ask(s.port, { path: '/api/login', headers: via({ 'X-Forwarded-Proto': 'http' }), body: { password: PASSWORD } });
    assert.doesNotMatch(plain.headers['set-cookie'][0], /Secure/);
  } finally { s.stop(); fs.rmSync(process.env.RPI_ALERT_WEBPW_FILE, { force: true }); }
});

// Requests written on one connection, as a proxy keeps one open for many callers.
function onOneConnection(port, requests) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let text = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => { text += d; });
    sock.on('close', () => resolve(text.split(/(?=HTTP\/1\.1 \d{3} )/).map(r => ({ status: Number(r.slice(9, 12)), text: r }))));
    sock.on('error', () => {});
    sock.on('connect', () => sock.write(requests.join('')));
  });
}

test('behindProxy: a request with no header of the proxy\'s, behind one that had — on the proxy\'s connection it is not this machine\'s own', async () => {
  const s = await station({ behindProxy: true });
  const get = (headers, last) => 'GET /api/config HTTP/1.1\r\nHost: 127.0.0.1:' + s.port + '\r\n' + headers + (last ? 'Connection: close\r\n' : '') + '\r\n';
  try {
    // A caller's request, forwarded; then one hidden in its body, or left on the connection, with nothing to mark it.
    const mixed = await onOneConnection(s.port, [get('X-Forwarded-For: 203.0.113.7\r\n'), get('', true)]);
    assert.deepEqual(mixed.map(r => r.status), [401, 401]);
    // The command's own connection, which has carried none: let in each time.
    const own = await onOneConnection(s.port, [get(''), get('', true)]);
    assert.deepEqual(own.map(r => r.status), [200, 200]);
    // nginx with no settings of its own: no header, 127.0.0.1 for a name, HTTP/1.0. A visitor — and the log says so.
    const http10 = 'GET /api/config HTTP/1.0\r\nHost: 127.0.0.1:' + s.port + '\r\nConnection: close\r\n\r\n';
    assert.deepEqual((await onOneConnection(s.port, [http10])).map(r => r.status), [401]);
    assert.equal(s.said('warn', /asking for "127\.0\.0\.1", carried none of a reverse proxy's headers/).length, 1);
    // With the setting off, as before 0.24: each request on its own.
    s.config.update({ web: { behindProxy: false } });
    const before = await onOneConnection(s.port, [get('X-Forwarded-For: 203.0.113.7\r\n'), get('', true)]);
    assert.deepEqual(before.map(r => r.status), [401, 200]);
    assert.deepEqual((await onOneConnection(s.port, [http10])).map(r => r.status), [200]);
  } finally { s.stop(); }
});

test('behindProxy: a thousand header lines sent first do not hide the proxy\'s own behind them', async () => {
  // Node 18 and 20 keep the first thousand or so header lines of a request and drop the rest unsaid; a proxy that
  // puts its headers after the caller's (Caddy) then seems to have added none. Node 22 refuses such a request (431).
  const s = await station({ behindProxy: true });
  const junk = (n) => 'D: \r\n'.repeat(n);
  const get = (headers) => 'GET /api/config HTTP/1.1\r\nHost: localhost\r\n' + headers + 'Connection: close\r\n\r\n';
  const login = (headers) => { const body = JSON.stringify({ password: 'wrong' }); return 'POST /api/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ' + body.length + '\r\n' + headers + 'Connection: close\r\n\r\n' + body; };
  const one = async (text) => (await onOneConnection(s.port, [text]))[0].status;
  try {
    assert.equal(s.web.server.maxHeadersCount, 0, 'every header line is kept');
    assert.equal(await one(get('')), 200, 'the command, asking as it does');
    for (const n of [1023, 1100, 2100]) {
      assert.equal(await one(get(junk(n) + 'X-Forwarded-For: 203.0.113.7\r\n')), 401, n + ' lines, then the proxy\'s header: a visitor');
      // The header is not only not lost — it is read: the address in the log is the one the proxy saw.
      s.web.fails.clear(); s.log.length = 0;
      assert.equal(await one(login(junk(n) + 'X-Forwarded-For: 203.0.113.7\r\nX-Forwarded-Proto: https\r\n')), 401);
      assert.deepEqual(s.logins().map(l => l[1]), ['login refused from 203.0.113.7 (through the proxy): wrong password (1 in a row)'], n + ' lines');
    }
    // Whatever becomes of the header, a request with more lines than anything on this machine sends is not this machine's own.
    assert.equal(await one(get(junk(40))), 200, 'forty lines more than the command sends: still its own');
    assert.equal(await one(get(junk(70))), 401);
    assert.equal(await one(get(junk(1100))), 401);
    // As before 0.24 (the setting off) the same hole was there, and is closed the same way.
    s.config.update({ web: { behindProxy: false } });
    assert.equal(await one(get('')), 200);
    assert.equal(await one(get(junk(1100) + 'X-Forwarded-For: 203.0.113.7\r\n')), 401);
    assert.equal(await one(get(junk(70))), 401);
    assert.equal(await one(get(junk(40))), 200);
  } finally { s.stop(); }
  // The rule itself: 64 header lines are this machine's own, 65 are not — proxy or no proxy.
  const lines = (n) => { const raw = ['Host', '127.0.0.1']; for (let i = 1; i < n; i++) raw.push('D', ''); return { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1' }, rawHeaders: raw, httpVersion: '1.1' }; };
  for (const web of [{ behindProxy: true }, { behindProxy: false }]) assert.deepEqual([isLocal(lines(64), web), isLocal(lines(65), web)], [true, false], JSON.stringify(web));
});

test('behindProxy: the live stream — a forwarded caller is a visitor, counted by its own address', async () => {
  const s = await station({ behindProxy: true });
  const open = [];
  const from = async (addr) => { const st = await stream(s.port, { 'X-Forwarded-For': '10.1.1.1, ' + addr }).ready; open.push(st); return st; };
  try {
    const visitor = await from('203.0.113.7');
    const own = await stream(s.port).ready; open.push(own);
    assert.deepEqual([visitor.status, own.status], [200, 200]);
    s.web.broadcast('log', { msg: 'for those let in' }, true);
    s.web.broadcast('tick', { t: 1 });
    assert.ok(await until(() => /event: tick/.test(visitor.text) && /event: log/.test(own.text)));
    assert.doesNotMatch(visitor.text, /event: log/, 'the log is not for a visitor');
    // Six from one address, as before — the address the proxy saw, not the proxy's own.
    for (let i = 0; i < 5; i++) assert.equal((await from('203.0.113.7')).status, 200);
    assert.equal((await from('203.0.113.7')).status, 503, 'the seventh from one address');
    assert.equal((await from('203.0.113.8')).status, 200, 'another address is not held back by it');
  } finally { open.forEach(o => o.close()); s.stop(); }
});

// A real nginx, where there is one: as it comes, and set up as docs/configuration.md says.
const NGINX = ['/usr/sbin/nginx', '/usr/bin/nginx', '/usr/local/sbin/nginx', '/usr/local/bin/nginx'].find(f => fs.existsSync(f));

test('behindProxy: behind nginx itself — as it comes its callers are visitors; set up as the docs say, each is a visitor with its own address', { skip: !NGINX && 'no nginx here' }, async (t) => {
  const s = await station({ behindProxy: true, hosts: ['bs01.council.example'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-nginx-'));
  const bare = await freePort(), good = await freePort();
  fs.writeFileSync(path.join(dir, 'nginx.conf'), [
    'daemon off;', 'pid ' + dir + '/nginx.pid;', 'error_log ' + dir + '/error.log;',
    typeof process.getuid === 'function' && process.getuid() === 0 ? 'user root;' : '',
    'events {}',
    'http {',
    '  access_log off;',
    ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'].map(k => '  ' + k + '_temp_path ' + dir + '/' + k + ';').join('\n'),
    // nginx with no more than where to pass requests on to.
    '  server { listen 127.0.0.1:' + bare + '; location / { proxy_pass http://127.0.0.1:' + s.port + '; } }',
    // As docs/configuration.md gives it.
    '  server { listen 127.0.0.1:' + good + '; location / {',
    '    proxy_pass http://127.0.0.1:' + s.port + ';',
    '    proxy_set_header Host $http_host;',
    '    proxy_set_header X-Forwarded-For $remote_addr;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    '  } }',
    '}', ''].join('\n'));
  const nginx = require('node:child_process').spawn(NGINX, ['-e', path.join(dir, 'error.log'), '-c', path.join(dir, 'nginx.conf')], { stdio: 'ignore' });
  let gone = false; nginx.on('exit', () => { gone = true; }); nginx.on('error', () => { gone = true; });
  try {
    const up = await until(async () => gone || ((await ask(bare, { path: '/' })).status !== 0 && (await ask(good, { path: '/' })).status !== 0), 8000);
    if (!up || gone) return t.skip('nginx would not start here');
    const named = (extra) => Object.assign({ Host: 'bs01.council.example' }, extra || {});

    // As it comes: no header of its own, 127.0.0.1 for a name — and HTTP/1.0. A visitor, whatever name the caller asks for; and the log says the proxy is not doing its part.
    for (const h of [named(), { Host: 'localhost' }, { Host: '127.0.0.1' }]) assert.equal((await ask(bare, { path: '/api/config', headers: h })).status, 401, 'as it comes, asking for ' + h.Host);
    assert.equal((await ask(bare, { headers: named() })).json.auth.local, false);
    assert.equal(s.said('warn', /asking for "127\.0\.0\.1", carried none of a reverse proxy's headers/).length, 1);

    // As the docs say: a visitor, known by the address nginx saw — not one the caller made up.
    const out = await ask(good, { headers: named() });
    assert.deepEqual([out.status, out.json.auth.local, out.json.auth.authed], [200, false, false]);
    assert.equal((await ask(good, { path: '/api/config', headers: named() })).status, 401);
    assert.equal((await ask(good, { path: '/api/config', headers: { Host: 'evil.example' } })).status, 403, 'the Host guard, through the proxy');
    const wrong = await ask(good, { path: '/api/login', headers: named({ 'X-Forwarded-For': '203.0.113.99', Origin: 'http://bs01.council.example' }), body: { password: 'wrong' } });
    assert.equal(wrong.status, 401, 'the browser\'s Host was passed on, so its Origin matches: checked, not refused as cross-site');
    assert.equal(s.logins()[0][1], 'login refused from 127.0.0.1 (through the proxy): wrong password (1 in a row)');
    const login = await ask(good, { path: '/api/login', headers: named(), body: { password: PASSWORD } });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    assert.equal((await ask(good, { path: '/api/config', headers: named({ Cookie: cookie }) })).status, 200, 'logged in, through the proxy');
    // The live stream comes through at once, not held back by the proxy.
    const live = await stream(good, named()).ready;
    assert.equal(live.status, 200);
    assert.ok(await until(() => /retry: 3000/.test(live.text), 3000), 'its first line is there');
    s.web.broadcast('tick', { t: 1 });
    assert.ok(await until(() => /event: tick/.test(live.text), 3000), 'and what follows');
    live.close();

    // Beside it, the rpi-alert command asks the agent itself, and needs no login.
    assert.equal((await ask(s.port, { path: '/api/config' })).status, 200);
  } finally { nginx.kill(); s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── a log line for every login attempt ───────────────────────────────────────

test('login: every attempt is a line in the log — accepted or refused, the address, never what was typed', async () => {
  // (The count of a locked-out address's tries is said after two seconds here, a minute on a base station.)
  const s = await station({}, { lockedNoteMs: 2000 });
  const tryLogin = (password, headers) => ask(s.port, { path: '/api/login', headers, body: { password } });
  try {
    assert.equal((await tryLogin('hunter2-wrong', OUTSIDE)).status, 401);
    assert.equal((await tryLogin(PASSWORD, OUTSIDE)).status, 200);
    assert.deepEqual(s.logins(), [
      ['warn', 'login refused from 127.0.0.1: wrong password (1 in a row)'],
      ['warn', 'login accepted from 127.0.0.1'],
    ], 'both at the level of the other things asked of the web page that matter to its owner');

    // Four wrong cost nothing; the fifth locks the address out for 30 s, the sixth for 60 s…
    s.log.length = 0;
    for (let i = 1; i <= 5; i++) assert.equal((await tryLogin('hunter2-wrong-' + i)).status, 401);
    assert.match(s.logins()[3][1], /^login refused from 127\.0\.0\.1: wrong password \(4 in a row\)$/);
    assert.match(s.logins()[4][1], /^login refused from 127\.0\.0\.1: wrong password \(5 in a row; locked out for 30 s\)$/);
    // …and while it is locked out nothing is checked: the right password is refused too.
    s.log.length = 0;
    const locked = await tryLogin(PASSWORD);
    assert.deepEqual([locked.status, /^too many tries — wait \d+ s$/.test(locked.json.error)], [429, true]);
    for (let i = 0; i < 3; i++) assert.equal((await tryLogin('guess-' + i)).status, 429);
    assert.match(s.logins()[0][1], /^login refused from 127\.0\.0\.1: locked out for another \d+ s after 5 wrong passwords — not checked$/, 'the first of them is a line');
    // The rest a count, so that nobody fills the log — all three counted, in one line or (on a slow machine) more.
    const counted = () => s.logins().slice(1).map(l => /^login refused from 127\.0\.0\.1: (\d+) more (?:try|tries) while locked out — not checked$/.exec(l[1]));
    assert.ok(await until(() => counted().length > 0 && counted().every(Boolean) && counted().reduce((n, m) => n + Number(m[1]), 0) === 3, 8000), JSON.stringify(s.logins()));
    assert.ok(s.logins().length <= 3, 'and never a line each');
    assert.ok(s.logins().every(l => l[0] === 'warn'));

    // No password set at all (removed on the machine itself): refused, and it says why.
    s.web.fails.clear(); s.log.length = 0;
    s.config.update({ web: { passwordHash: '' } });
    assert.equal((await tryLogin('anything')).status, 401);
    assert.equal(s.logins()[0][1], 'login refused from 127.0.0.1: no password is set (1 in a row)');
  } finally { s.stop(); }
  const all = JSON.stringify(s.log);
  for (const typed of [PASSWORD, 'hunter2', 'guess-', 'anything']) assert.ok(!all.includes(typed), 'nothing typed is in the log');
});

test('login: one refused before its password is looked at is on record too — another site\'s page, a name not known, a request that cannot be read', async () => {
  const s = await station({ behindProxy: true, hosts: ['bs01.council.example'] }, { lockedNoteMs: 300 });
  const via = (extra) => Object.assign({ 'X-Forwarded-For': '203.0.113.7', Host: 'bs01.council.example' }, extra || {});
  const post = (headers, text) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/login', method: 'POST', headers: Object.assign({ 'Content-Length': Buffer.byteLength(text) }, headers), agent: false, setHost: false },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.end(text);
  });
  const json = { 'Content-Type': 'application/json' };
  try {
    // Sent from another site's page.
    assert.equal(await post(via(Object.assign({ Origin: 'https://evil.example' }, json)), JSON.stringify({ password: PASSWORD })), 403);
    // Asked for by a name this base station does not go by.
    assert.equal(await post(via(Object.assign({ Host: 'evil.example' }, json)), JSON.stringify({ password: PASSWORD })), 403);
    // Not JSON; JSON cut short; too much of it.
    assert.equal(await post(via({ 'Content-Type': 'application/x-www-form-urlencoded' }), 'password=' + encodeURIComponent(PASSWORD)), 415);
    assert.equal(await post(via(json), '{"password": "' + PASSWORD), 400);
    assert.deepEqual(s.logins(), [
      ['warn', 'login refused from 203.0.113.7 (through the proxy): cross-site request — the password was not looked at'],
      ['warn', 'login refused from 203.0.113.7 (through the proxy): unrecognised Host header — the password was not looked at'],
      ['warn', 'login refused from 203.0.113.7 (through the proxy): a request that could not be read (send JSON) — the password was not looked at'],
    ], 'the first of each kind is a line; the second that could not be read is counted');
    // Anyone can send these as often as they like: the rest are a count, with whom they came from.
    for (const from of ['203.0.113.8', '203.0.113.8', '203.0.113.9']) assert.equal(await post(via(Object.assign({ Origin: 'https://evil.example', 'X-Forwarded-For': from }, json)), '{}'), 403);
    assert.equal(s.logins().length, 3, 'no line each');
    assert.ok(await until(() => s.logins().length === 5, 5000), JSON.stringify(s.logins()));
    assert.deepEqual(s.logins().slice(3).map(l => l[1]).sort(), [
      'login refused: 1 more try in the last minute with a request that could not be read, from 203.0.113.7 — not looked at',
      'login refused: 3 more tries in the last minute with cross-site request, from 203.0.113.8, 203.0.113.9 — not looked at',
    ]);
    // None of them is a wrong password: nobody is locked out by them.
    assert.equal(s.web.fails.size, 0);
  } finally { s.stop(); }
  assert.ok(!JSON.stringify(s.log).includes(PASSWORD), 'nothing typed is in the log');
});

test('login: what cannot be a password is a wrong password, and a request that cannot be read is no error', async () => {
  const s = await station({}, { lockedNoteMs: 300 });
  const raw = (text) => onOneConnection(s.port, [text]).then(r => r[0]);
  const post = (path, body, cookie) => raw('POST ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: 203.0.113.7\r\n' + (cookie ? 'Cookie: ' + cookie + '\r\n' : '')
    + 'Content-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body);
  const get = (path, headers) => raw('GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: 203.0.113.7\r\n' + (headers || '') + 'Connection: close\r\n\r\n');
  try {
    // A login with no password to speak of: refused, counted and logged like any wrong one — and the fifth locks out.
    const odd = ['null', '{"password":{"toString":1}}', '[1,2]', '{"password":12345678}', '"' + PASSWORD + '"'];
    for (const body of odd) assert.equal((await post('/api/login', body)).status, 401, body);
    assert.deepEqual(s.logins().map(l => l[1]), [1, 2, 3, 4].map(n => 'login refused from 127.0.0.1: wrong password (' + n + ' in a row)')
      .concat('login refused from 127.0.0.1: wrong password (5 in a row; locked out for 30 s)'));
    assert.equal((await post('/api/login', JSON.stringify({ password: PASSWORD }))).status, 429);
    s.web.fails.clear();
    // A cookie that cannot be read is no cookie; a path or an address that cannot be read is a bad request.
    assert.equal((await get('/api/status', 'Cookie: rpa_session=%\r\n')).status, 200);
    assert.equal((await get('/api/config', 'Cookie: rpa_session=%; other=%E0%A4%A\r\n')).status, 401);
    for (const p of ['/%', '/%E0%A4%A', '/%00', '/app.js%00', '//[', 'http://[/']) assert.equal((await get(p)).status, 400, p);
    assert.equal((await get('/')).status, 200);
    // Anything but a set of named values sent to another route: the caller's mistake.
    const login = await post('/api/login', JSON.stringify({ password: PASSWORD }));
    const cookie = /set-cookie: (rpa_session=[0-9a-f]+)/i.exec(login.text)[1];
    for (const body of ['null', '[]', '7', '"x"']) {
      const r = await post('/api/config', body, cookie);
      assert.equal(r.status, 400, body);
      assert.match(r.text, /send a JSON object/);
    }
    assert.equal((await post('/api/password', '{"password":{"toString":1}}', cookie)).status, 400);
    assert.equal(s.said('error', /./).length, 0, 'none of it is an error in the log');
    assert.deepEqual(s.log.filter(l => l[0] !== 'info' && !/^login /.test(l[1])), [], 'nor any other line');

    // What does go wrong in the agent itself is said — the first in full, the rest of that minute as a count.
    s.agent.status = async () => { throw new Error('boom'); };
    for (let i = 0; i < 6; i++) assert.equal((await get('/api/status')).status, 500);
    assert.equal(s.said('error', /./).length, 1);
    assert.match(s.said('error', /./)[0], /^Error: boom\n\s+at /);
    assert.ok(await until(() => s.said('error', /./).length === 2, 5000));
    assert.equal(s.said('error', /./)[1], '5 more requests failed in the last minute — the last of them: boom');
  } finally { s.stop(); }
});

test('login: a new password is on record, and the login it gives; taking the password off, too', async () => {
  const s = await station({ behindProxy: true, hosts: ['bs01.council.example'] });
  const via = (extra) => Object.assign({ 'X-Forwarded-For': '203.0.113.7', Host: 'bs01.council.example' }, extra || {});
  try {
    const login = await ask(s.port, { path: '/api/login', headers: via(), body: { password: PASSWORD } });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    s.log.length = 0;
    const changed = await ask(s.port, { path: '/api/password', headers: via({ Cookie: cookie }), body: { password: 'another horse entirely' } });
    assert.equal(changed.status, 200);
    assert.deepEqual(s.log.filter(l => /password|login/.test(l[1])), [
      ['warn', 'password changed from 203.0.113.7 (through the proxy)'],
      ['warn', 'login accepted from 203.0.113.7 (through the proxy) (new password)'],
    ]);
    const now = changed.headers['set-cookie'][0].split(';')[0];
    assert.equal((await ask(s.port, { path: '/api/config', headers: via({ Cookie: cookie }) })).status, 401, 'the login from before it is over');
    assert.equal((await ask(s.port, { path: '/api/config', headers: via({ Cookie: now }) })).status, 200);
    // One too short changes nothing and is no line.
    s.log.length = 0;
    assert.equal((await ask(s.port, { path: '/api/password', headers: via({ Cookie: now }), body: { password: 'short' } })).status, 400);
    assert.equal(s.log.length, 0);
    // Taken off — on the base station itself only — and with none set, whoever sets the next is on record.
    assert.equal((await ask(s.port, { path: '/api/password', body: { remove: true } })).status, 200);
    assert.deepEqual(s.log.filter(l => /password|login/.test(l[1])), [['warn', 'password removed from 127.0.0.1']]);
    s.log.length = 0;
    assert.equal((await ask(s.port, { path: '/api/password', headers: via(), body: { password: 'set from the network' } })).status, 200);
    assert.deepEqual(s.log.filter(l => /password|login/.test(l[1])).map(l => l[1]), ['password changed from 203.0.113.7 (through the proxy)', 'login accepted from 203.0.113.7 (through the proxy) (new password)']);
  } finally { s.stop(); }
  const all = JSON.stringify(s.log);
  for (const typed of ['another horse', 'short', 'set from the network']) assert.ok(!all.includes(typed), 'nothing typed is in the log');
});

test('login: the lock-out stops growing at a quarter of an hour, and an address\'s wrong passwords are forgotten after an hour without one', async () => {
  const s = await station();
  const wrong = () => ask(s.port, { path: '/api/login', body: { password: 'wrong' } });
  const last = () => s.logins()[s.logins().length - 1][1];
  const MIN = 60 * 1000;
  try {
    // The 33rd wrong password locks out for 870 s, the 34th for 900 s — and so does every one after it.
    for (const [n, lock] of [[32, 840], [33, 870], [34, 900], [35, 900], [200, 900]]) {
      s.web.fails.set('127.0.0.1', { n: n - 1, at: Date.now() - 1000, until: Date.now() - 1 });
      assert.equal((await wrong()).status, 401);
      assert.equal(last(), 'login refused from 127.0.0.1: wrong password (' + n + ' in a row; locked out for ' + lock + ' s)');
      assert.ok(s.web.fails.get('127.0.0.1').until - Date.now() <= lock * 1000);
    }
    // An hour after its lock ran out with nothing more from it: forgotten, and it starts again at one.
    s.web.fails.set('127.0.0.1', { n: 200, at: Date.now() - 80 * MIN, until: Date.now() - 61 * MIN });
    assert.equal((await wrong()).status, 401);
    assert.equal(last(), 'login refused from 127.0.0.1: wrong password (1 in a row)');
    // Under the hour, it is not: the lock that follows is the next one up.
    s.web.fails.set('127.0.0.1', { n: 6, at: Date.now() - 62 * MIN, until: Date.now() - 59 * MIN });
    assert.equal((await wrong()).status, 401);
    assert.equal(last(), 'login refused from 127.0.0.1: wrong password (7 in a row; locked out for 90 s)');
    // The same for an address that was never locked out: four wrong ones an hour ago are forgotten, 59 minutes ago are not.
    s.web.fails.set('127.0.0.1', { n: 4, at: Date.now() - 61 * MIN, until: 0 });
    assert.equal((await wrong()).status, 401);
    assert.equal(last(), 'login refused from 127.0.0.1: wrong password (1 in a row)');
    s.web.fails.set('127.0.0.1', { n: 4, at: Date.now() - 59 * MIN, until: 0 });
    assert.equal((await wrong()).status, 401);
    assert.equal(last(), 'login refused from 127.0.0.1: wrong password (5 in a row; locked out for 30 s)');
  } finally { s.stop(); }
});

test('login behind a proxy: the address in the log and in the lock-out is the one the proxy saw', async () => {
  const s = await station({ behindProxy: true });
  const tryLogin = (password, xff) => ask(s.port, { path: '/api/login', headers: xff === undefined ? {} : { 'X-Forwarded-For': xff }, body: { password } });
  try {
    // A caller cannot hide behind addresses it makes up, nor pass its lock-out to another.
    for (let i = 1; i <= 5; i++) assert.equal((await tryLogin('wrong', '198.51.100.' + i + ', 203.0.113.7')).status, 401);
    assert.equal(s.logins()[4][1], 'login refused from 203.0.113.7 (through the proxy): wrong password (5 in a row; locked out for 30 s)');
    assert.equal((await tryLogin(PASSWORD, '203.0.113.7')).status, 429);
    assert.equal((await tryLogin(PASSWORD, '127.0.0.1, 203.0.113.7')).status, 429);
    const other = await tryLogin(PASSWORD, '203.0.113.7, 203.0.113.8');
    assert.equal(other.status, 200, 'another address is not locked out by it');
    assert.equal(s.log[s.log.length - 1][1], 'login accepted from 203.0.113.8 (through the proxy)');
    // The command on the machine itself needs no login; if it tries one, it is its own address.
    assert.equal((await tryLogin(PASSWORD)).status, 200);
    assert.equal(s.log[s.log.length - 1][1], 'login accepted from 127.0.0.1');
  } finally { s.stop(); }
});

test('login: wrong passwords are counted for so many addresses and no more — the one counted longest is forgotten', async () => {
  const s = await station({ behindProxy: true }, { maxFails: 3 });
  const wrong = (addr) => ask(s.port, { path: '/api/login', headers: { 'X-Forwarded-For': addr }, body: { password: 'wrong' } });
  try {
    for (const a of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) assert.equal((await wrong(a)).status, 401);
    assert.equal((await wrong('198.51.100.2')).status, 401);
    assert.deepEqual([...s.web.fails.keys()], ['198.51.100.1', '198.51.100.2', '198.51.100.3']);
    // A fourth address: the first is forgotten, the others keep their counts.
    assert.equal((await wrong('198.51.100.4')).status, 401);
    assert.deepEqual([...s.web.fails.keys()], ['198.51.100.2', '198.51.100.3', '198.51.100.4']);
    assert.equal(s.web.fails.get('198.51.100.2').n, 2);
    assert.equal((await wrong('198.51.100.1')).status, 401);
    assert.equal(s.log[s.log.length - 1][1], 'login refused from 198.51.100.1 (through the proxy): wrong password (1 in a row)');
    assert.equal(s.web.fails.size, 3);
  } finally { s.stop(); }
});

// ── web.requireLogin ─────────────────────────────────────────────────────────

const OPEN = ['/api/status', '/api/readings', '/api/history', '/api/stations/search?q=mar'];

test('requireLogin settings: looking needs no login, as before 0.24', async () => {
  const s = await station();
  try {
    for (const p of OPEN) assert.equal((await ask(s.port, { path: p, headers: OUTSIDE })).status, 200, p);
    const st = await stream(s.port, OUTSIDE).ready;
    assert.equal(st.status, 200, 'the live stream');
    st.close();
    const denied = await ask(s.port, { path: '/api/config', headers: OUTSIDE });
    assert.deepEqual([denied.status, denied.json], [401, { error: 'log in first', login: true }]);
  } finally { s.stop(); }
});

test('requireLogin all: nothing is read without a login — and the rpi-alert command still works', async () => {
  const s = await station({ requireLogin: 'all' });
  try {
    for (const p of OPEN.concat('/api/events', '/api/config', '/api/log', '/api/hotspot', '/api/nothing-here')) {
      const r = await ask(s.port, { path: p, headers: OUTSIDE });
      assert.deepEqual([r.status, r.json], [401, { error: 'log in first', login: true, all: true }], p);
    }
    // The page itself is the same in every copy of RPi ALERT and holds no data: it loads, to ask for the password.
    const page = await ask(s.port, { path: '/', headers: OUTSIDE });
    assert.equal(page.status, 200);
    assert.match(page.text, /id="login-form"/);
    assert.equal((await ask(s.port, { path: '/app.js', headers: OUTSIDE })).status, 200);
    // A wrong password opens nothing; the right one, everything.
    assert.equal((await ask(s.port, { path: '/api/login', headers: OUTSIDE, body: { password: 'wrong' } })).status, 401);
    const login = await ask(s.port, { path: '/api/login', headers: OUTSIDE, body: { password: PASSWORD } });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const mine = Object.assign({ Cookie: cookie }, OUTSIDE);
    for (const p of OPEN) assert.equal((await ask(s.port, { path: p, headers: mine })).status, 200, p + ', logged in');
    const full = await ask(s.port, { headers: mine });
    assert.equal(full.json.location.lat, -27.47, 'and the whole status');
    // The command on the base station itself: no login.
    for (const p of OPEN.concat('/api/config')) assert.equal((await ask(s.port, { path: p })).status, 200, p + ', on the machine itself');

    // A live stream lasts as long as the login it was opened with.
    const live = await stream(s.port, mine).ready;
    const own = await stream(s.port).ready;
    assert.deepEqual([live.status, own.status], [200, 200]);
    assert.equal((await ask(s.port, { path: '/api/logout', headers: mine, body: {} })).status, 200);
    assert.ok(await until(() => live.ended), 'logged out: the stream ends');
    assert.equal((await ask(s.port, { headers: mine })).status, 401);
    await wait(50);
    assert.equal(own.ended, false, 'the machine\'s own goes on');
    own.close();
  } finally { s.stop(); }
});

test('requireLogin all: a live stream whose login has run out is ended — and the agent goes on', async () => {
  // The line every live stream is sent, every 40 ms here (25 s on a base station): before it, the streams whose login is over are ended.
  const s = await station({ requireLogin: 'all' }, { keepAliveMs: 40 });
  const errors = [];
  const uncaught = (e) => errors.push(e);
  process.on('uncaughtException', uncaught);
  try {
    const login = await ask(s.port, { path: '/api/login', headers: OUTSIDE, body: { password: PASSWORD } });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const live = await stream(s.port, Object.assign({ Cookie: cookie }, OUTSIDE)).ready;
    const own = await stream(s.port).ready;
    assert.deepEqual([live.status, own.status, s.web.clients.size], [200, 200, 2]);
    assert.ok(await until(() => /keep-alive/.test(live.text)), 'it is sent its line');
    // Seven days on: the login is over.
    for (const id of s.web.sessions.keys()) s.web.sessions.set(id, Date.now() - 1);
    assert.ok(await until(() => live.ended), 'the stream ends at the next line');
    const before = own.text.length;
    await wait(200);   // …and several more lines go out, to those that are left
    assert.ok(own.text.length > before, 'the machine\'s own stream goes on');
    assert.equal(s.web.clients.size, 1, 'and the ended one is no longer written to');
    assert.equal((await ask(s.port, { headers: Object.assign({ Cookie: cookie }, OUTSIDE) })).status, 401);
    // Ended and written to in the same breath, as the agent's own tick and the sweep can fall: nothing goes wrong.
    const again = await ask(s.port, { path: '/api/login', headers: OUTSIDE, body: { password: PASSWORD } });
    const live2 = await stream(s.port, Object.assign({ Cookie: again.headers['set-cookie'][0].split(';')[0] }, OUTSIDE)).ready;
    assert.equal(live2.status, 200);
    const mine = [...s.web.clients].find(c => !c._local);
    s.web.sessions.clear();
    s.web.sweep();
    s.web.send(mine, ': after the end\n\n');
    s.web.broadcast('tick', { t: 1 });
    assert.ok(await until(() => live2.ended));
    assert.doesNotMatch(live2.text, /after the end/);
    await wait(100);
    assert.deepEqual(errors.map(e => e.code || e.message), [], 'no error that nobody was listening for');
    assert.equal(s.said('error', /./).length, 0);
    own.close();
  } finally { process.removeListener('uncaughtException', uncaught); s.stop(); }
});

test('requireLogin all: a visitor who has stopped reading is ended like any other, and closed shortly after', async () => {
  const s = await station({}, { keepAliveMs: 40, endGraceMs: 150 });
  const errors = [];
  const uncaught = (e) => errors.push(e);
  process.on('uncaughtException', uncaught);
  // A visitor whose device takes nothing in: connected, asked for the stream, and never reads.
  const sock = net.connect(s.port, '127.0.0.1');
  let closed = false;
  sock.on('close', () => { closed = true; });
  sock.on('error', () => {});
  try {
    await new Promise(r => sock.on('connect', r));
    sock.pause();
    sock.write('GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:' + s.port + '\r\nX-Forwarded-For: 203.0.113.7\r\n\r\n');
    assert.ok(await until(() => s.web.clients.size === 1));
    // Much more than it and the system between will hold: it backs up in the agent.
    const lump = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 160; i++) s.web.broadcast('tick', { lump });
    const c = [...s.web.clients][0], theirs = c.socket;
    assert.ok(c.writableLength > 0, 'waiting to go');
    // A login for everything is turned on: its stream is ended — off the list at once, though it cannot take the end.
    assert.ok(s.config.update({ web: { requireLogin: 'all' } }).ok);
    assert.equal(s.web.clients.size, 0);
    s.web.broadcast('tick', { t: 1 });
    assert.equal(theirs.destroyed, false, 'given a moment to take what it was sent');
    assert.ok(await until(() => theirs.destroyed, 5000), 'and then its connection is closed, not left open for good');
    sock.resume();
    assert.ok(await until(() => closed, 5000), 'which it finds when it reads again');
    assert.deepEqual(errors.map(e => e.code || e.message), []);
    assert.equal(s.said('error', /./).length, 0);
  } finally { process.removeListener('uncaughtException', uncaught); sock.destroy(); s.stop(); }
});

test('requireLogin all: turned on, it ends what was open; with no password there is no login, and only the machine itself is let in', async () => {
  const s = await station();
  try {
    const visitor = await stream(s.port, OUTSIDE).ready;
    assert.equal(visitor.status, 200);
    assert.ok(s.config.update({ web: { requireLogin: 'all' } }).ok);
    assert.ok(await until(() => visitor.ended), 'a visitor\'s stream ends when the setting is turned on');
    // Before 0.24's setting, no password meant anyone; with a login for everything it means nobody from outside.
    s.config.update({ web: { passwordHash: '' } });
    assert.equal((await ask(s.port, { headers: OUTSIDE })).status, 401);
    assert.equal((await ask(s.port, { path: '/api/login', headers: OUTSIDE, body: { password: '' } })).status, 401);
    assert.equal((await ask(s.port)).status, 200);
    s.config.update({ web: { requireLogin: 'settings' } });
    const open = await ask(s.port, { path: '/api/config', headers: OUTSIDE });
    assert.equal(open.status, 200, 'and with the setting off, no password is anyone, as before');
  } finally { s.stop(); }
});

test('all four together: the dashboard behind a proxy, on this machine only, a login for everything — and the command line and the updater still read it', async () => {
  const s = await station({ bind: '127.0.0.1', hosts: ['bs01.council.example'], behindProxy: true, requireLogin: 'all' });
  const via = (extra) => Object.assign({ 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https', Host: 'bs01.council.example' }, extra || {});
  try {
    // rpi-alert status, and the updater's "is the new version answering": http://127.0.0.1:<port>/api/status, no login.
    const own = await ask(s.port);
    assert.deepEqual([own.status, own.json.version, own.json.auth.local], [200, 'test', true]);
    assert.equal((await ask(s.port, { path: '/api/readings?limit=10' })).status, 200);
    // From outside, through the proxy: the page to log in on, and nothing else until then.
    assert.equal((await ask(s.port, { path: '/', headers: via() })).status, 200);
    for (const p of OPEN.concat('/api/events', '/api/config')) assert.equal((await ask(s.port, { path: p, headers: via() })).status, 401, p);
    const login = await ask(s.port, { path: '/api/login', headers: via({ Origin: 'https://bs01.council.example' }), body: { password: PASSWORD } });
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    for (const p of OPEN.concat('/api/config')) assert.equal((await ask(s.port, { path: p, headers: via({ Cookie: cookie }) })).status, 200, p + ', logged in');
    assert.equal((await ask(s.port, { headers: via({ Cookie: cookie }) })).json.auth.local, false);
    assert.deepEqual(s.logins().map(l => l[1]), ['login accepted from 203.0.113.7 (through the proxy)']);
    if (LINUX) assert.equal((await ask(s.port, { to: '127.0.0.2' })).error, 'ECONNREFUSED', 'and nothing but the proxy can reach it');
  } finally { s.stop(); }
});

// The rpi-alert command itself, as somebody logged in on the base station runs it.
function cli(port, args) {
  return new Promise((resolve) => {
    require('node:child_process').execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'rpi-alert')].concat(args),
      { env: Object.assign({}, process.env, { RPI_ALERT_PORT: String(port) }), encoding: 'utf8', timeout: 30000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, stdout, stderr }));
  });
}

test('the rpi-alert command on the base station: reads and sets with all four on, and is how they are set', async () => {
  const s = await station({ bind: '127.0.0.1', behindProxy: true, requireLogin: 'all' });
  try {
    const st = await cli(s.port, ['status', '--json']);
    assert.equal(st.code, 0, st.stderr);
    assert.deepEqual(JSON.parse(st.stdout).auth, { authed: true, local: true, passwordSet: true, all: true });
    const get = await cli(s.port, ['config', 'get', 'web.requireLogin']);
    assert.deepEqual([get.code, get.stdout.trim()], [0, 'all'], get.stderr);
    // Names as they are typed: one, several, none.
    const set = await cli(s.port, ['config', 'set', 'web.hosts', 'BS01.council.example, alert.council.example']);
    assert.deepEqual([set.code, set.stdout.trim()], [0, 'Saved: web.hosts'], set.stderr);
    assert.deepEqual(s.config.get().web.hosts, ['bs01.council.example', 'alert.council.example']);
    assert.equal((await cli(s.port, ['config', 'set', 'web.hosts', 'none'])).code, 0);
    assert.deepEqual(s.config.get().web.hosts, []);
    // The other three, back to as they were before 0.24.
    for (const [key, value, now] of [['web.requireLogin', 'settings', 'settings'], ['web.behindProxy', 'false', false], ['web.bind', '', '']]) {
      const r = await cli(s.port, ['config', 'set', key, value]);
      // Where it listens is taken when the agent starts, and the command says so; the others hold from the next request.
      assert.deepEqual([r.code, r.stdout.trim().split('\n')], [0, ['Saved: ' + key].concat(key === 'web.bind' ? 'The dashboard moves there when the agent next starts: sudo systemctl restart rpi-alert' : [])], key + ' ' + r.stderr);
      assert.deepEqual(s.config.get().web[key.split('.')[1]], now);
    }
    // A proxy in front, turned on: the command says the one check the agent cannot make for itself.
    const proxy = await cli(s.port, ['config', 'set', 'web.behindProxy', 'true']);
    assert.deepEqual([proxy.code, proxy.stdout.trim().split('\n').length], [0, 2], proxy.stderr);
    assert.match(proxy.stdout, /^Saved: web\.behindProxy\nNow check the proxy, from another computer: curl -H 'Host: localhost' .*must answer "log in first", not the settings/);
    // A value that cannot be: refused with the reason, and nothing changed.
    const bad = await cli(s.port, ['config', 'set', 'web.bind', 'eth0']);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr + bad.stdout, /web\.bind: one of this machine's addresses/);
    assert.equal(s.config.get().web.bind, '');
  } finally { s.stop(); }
});

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
