'use strict';
// Asking MegaNet for the token (MegaNet 0048) against the stand-in, which
// holds the real calls' contract: the Pi makes its own token and only asks
// with it; the code is shown; once an administrator approves, the token is the
// setting and what was kept is sent with it. Denied, withdrawn, expired, a
// restart in the middle, a network outage in the middle, an older MegaNet, and
// request_token = yes asking by itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const stub = require('./helpers/meganet-stub');
const { Config, merge } = require('../lib/config');
const { Uplink } = require('../lib/uplink');
const { TokenRequest } = require('../lib/token-request');
const bootconf = require('../lib/bootconf');

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 5000)) { if (fn()) return true; await wait(20); } return false; }
const TOKEN = /^mgn_[0-9a-f]{64}$/;

function rig(m, over, dir) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-tr-'));
  const cfg = new Config(path.join(dir, 'config.json')).load();
  // No token, and the stand-in as MegaNet — never the real one.
  cfg.update(merge({ name: 'Bench Pi', meganet: { token: '', endpoints: [m.url + '/rest/v1'] } }, over || {}));
  const clock = Object.assign(new EventEmitter(), { trusted: () => true, now: () => Date.now(), mono: () => Number(process.hrtime.bigint() / 1000000n), bootId: () => 'boot-a',
    wallOf(mono) { return Date.now() - (this.mono() - mono); } });
  const up = new Uplink({ config: cfg, clock, log: quiet, dataDir: dir });
  const make = () => new TokenRequest({ config: cfg, api: up.api, dataDir: dir, log: quiet, pollMs: 40,
    describe: () => ({ label: cfg.get().name, host_station_id: 'loudoun_br_al', detail: { app: 'RPi ALERT', version: 'test', receivers: [{ kind: 'rtl-sdr', name: 'RTL-SDR' }] } }) });
  return { dir, cfg, up, tr: make(), make };
}

test('token request: the Pi asks with a token it made, shows the code, and on approval sends what it kept with it', async (t) => {
  const m = await stub.start();
  const { dir, cfg, up, tr } = rig(m);
  // However it ends: a failed assertion must not leave the poller holding the run.
  t.after(() => { tr.stop(); up.stop(); return m.close(); });
  up.load().start();
  tr.load().start();
  up.addReading({ point: 'rpi-abc-sdr1', protocol: 'alert', alert_id: 6129, value_raw: 1599, ts: Date.now() });
  await wait(100);
  assert.equal(m.calls.filter(c => c.fn === 'ingest_http').length, 0, 'nothing is sent without a token');

  const st = await tr.request();
  assert.equal(st.state, 'pending');
  assert.equal(st.code, 'WDJB-MJHT');
  assert.equal(st.link, 'https://floodwarning.net/#pair=WDJB-MJHT');
  const ask = m.calls.find(c => c.fn === 'request_ingest_token');
  const token = ask.headers['x-ingest-token'];
  assert.match(token, TOKEN, 'a token of its own, in X-Ingest-Token');
  assert.ok(!ask.headers.authorization);
  assert.deepEqual([ask.body.payload.label, ask.body.payload.host_station_id, ask.body.payload.detail.app], ['Bench Pi', 'loudoun_br_al', 'RPi ALERT']);
  assert.equal(cfg.get().meganet.token, '', 'not a setting until it is approved');
  const saved = path.join(dir, 'token-request.json');
  assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).token, token);
  assert.equal(fs.statSync(saved).mode & 0o777, 0o600, 'kept where only the agent can read it');

  assert.ok(await until(() => m.calls.some(c => c.fn === 'ingest_token_request_status' && c.headers['x-ingest-token'] === token)), 'it asks how it is going, holding that token');
  m.approve('WDJB-MJHT', 'Bench Pi (renamed)');
  assert.ok(await until(() => cfg.get().meganet.token === token), 'approved: the token it made is the setting');
  assert.equal(tr.status().state, 'idle');
  assert.equal(tr.status().last.status, 'approved');
  assert.match(tr.status().last.message, /Bench Pi \(renamed\)/);
  assert.ok(!fs.existsSync(saved), 'nothing left waiting');
  assert.ok(await until(() => m.calls.some(c => c.fn === 'ingest_http' && c.headers['x-ingest-token'] === token)), 'what was kept is sent with it');
  assert.ok(await until(() => up.status().accepted === 1));
});

test('token request: asking again while one waits is the same request; Stop asking withdraws it', async () => {
  const m = await stub.start();
  const { dir, tr } = rig(m);
  tr.load().start();
  const a = await tr.request();
  const b = await tr.request();
  assert.equal(a.code, b.code);
  assert.equal(m.requests.length, 1);
  const token = m.requests[0].token;
  const st = await tr.cancel();
  assert.equal(st.state, 'idle');
  assert.equal(st.last.status, 'withdrawn');
  assert.equal(m.requests[0].status, 'withdrawn', 'MegaNet is told, so the request leaves the Admin tab');
  assert.ok(m.calls.some(c => c.fn === 'withdraw_ingest_token_request' && c.headers['x-ingest-token'] === token));
  assert.ok(!fs.existsSync(path.join(dir, 'token-request.json')));
  tr.stop(); await m.close();
});

test('token request: a restart carries on asking; a denial ends it and says so', async () => {
  const m = await stub.start();
  const { dir, cfg, tr, make } = rig(m);
  tr.load();
  const a = await tr.request();
  tr.stop();
  const again = make().load();
  assert.equal(again.status().state, 'pending', 'the request survives the agent restarting');
  assert.equal(again.status().code, a.code);
  again.start();
  m.deny(a.code);
  assert.ok(await until(() => again.status().state === 'idle'));
  assert.equal(again.status().last.status, 'denied');
  assert.match(again.status().last.message, /turned the request down/);
  assert.equal(cfg.get().meganet.token, '');
  assert.ok(!fs.existsSync(path.join(dir, 'token-request.json')));
  again.stop(); await m.close();
});

test('token request: no answer is not an answer — through an outage it keeps asking, and takes the approval when MegaNet is back', async () => {
  const m = await stub.start();
  const { cfg, tr } = rig(m);
  tr.load().start();
  const a = await tr.request();
  m.opts.down = true;
  await wait(400);
  assert.equal(tr.status().state, 'pending', 'still waiting, token kept');
  m.approve(a.code);
  m.opts.down = false;
  assert.ok(await until(() => tr.status().last && tr.status().last.status === 'approved', 8000));
  assert.match(cfg.get().meganet.token, TOKEN);
  tr.stop(); await m.close();
});

test('token request: a token pasted by hand while one waits withdraws the request', async () => {
  const m = await stub.start();
  const { cfg, tr } = rig(m);
  tr.load().start();
  await tr.request();
  cfg.update({ meganet: { token: 'mgn_test_token' } });
  assert.ok(await until(() => tr.status().state === 'idle'));
  assert.ok(await until(() => m.requests[0].status === 'withdrawn'));
  assert.equal(cfg.get().meganet.token, 'mgn_test_token', 'the pasted token stays');
  tr.stop(); await m.close();
});

test('token request: an older MegaNet without 0048, or a full waiting list, says so and keeps nothing', async () => {
  const m = await stub.start({ noRequests: true });
  const { dir, tr } = rig(m);
  tr.load().start();
  const st = await tr.request();
  assert.equal(st.state, 'idle');
  assert.equal(st.last.status, 'unsupported');
  assert.match(st.last.message, /0048/);
  assert.ok(!fs.existsSync(path.join(dir, 'token-request.json')));
  tr.stop(); await m.close();

  const m2 = await stub.start({ waitingFull: true });
  const r2 = rig(m2);
  r2.tr.load();
  const st2 = await r2.tr.request();
  assert.equal(st2.last.status, 'busy');
  assert.match(st2.last.message, /try again in a few minutes/);
  await m2.close();
});

test('token request: request_token = yes asks by itself with no token, asks again when one runs out, and stops once approved', async () => {
  const conf = bootconf.toPatch(bootconf.parse('request_token = yes\nname = Hut Pi\n'));
  assert.equal(conf.patch.meganet.autoRequest, true);
  const m = await stub.start();
  const { cfg, tr } = rig(m, conf.patch);
  tr.load().start();
  assert.ok(await until(() => tr.status().state === 'pending'), 'it asks without being asked');
  assert.equal(m.requests[0].label, 'Hut Pi');
  m.expire(tr.status().code);
  assert.ok(await until(() => m.requests.length === 2 && tr.status().state === 'pending'), 'run out, it asks again with a new code');
  assert.notEqual(m.requests[1].token, m.requests[0].token, 'with a new token: a token asks once');
  assert.equal(tr.status().code, 'BCDF-GHJK');
  m.approve('BCDF-GHJK');
  assert.ok(await until(() => cfg.get().meganet.token === m.requests[1].token));
  assert.equal(cfg.get().meganet.autoRequest, false, 'approved, it stops asking');
  await wait(200);
  assert.equal(m.requests.length, 2);
  tr.stop(); await m.close();
});

test('token request: an administrator turning down a request made by itself stops it asking again', async () => {
  const m = await stub.start();
  const { cfg, tr } = rig(m, { meganet: { autoRequest: true } });
  tr.load().start();
  assert.ok(await until(() => tr.status().state === 'pending'));
  m.deny(tr.status().code);
  assert.ok(await until(() => cfg.get().meganet.autoRequest === false));
  await wait(200);
  assert.equal(m.requests.length, 1, 'no second request after a denial');
  tr.stop(); await m.close();
});

test('token request, end to end: `rpi-alert request-token` shows the code and a QR code, and the daemon keeps the approved token', { timeout: 60000 }, async (t) => {
  const { spawn } = require('node:child_process');
  const m = await stub.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-tr-e2e-'));
  for (const d of ['dev', 'data', 'etc', 'sys']) fs.mkdirSync(path.join(dir, d));
  const port = 20000 + Math.floor(Math.random() * 2000);
  fs.writeFileSync(path.join(dir, 'etc', 'config.json'), JSON.stringify({
    name: 'Bench Pi', web: { port }, receivers: { sdr: { enabled: false } },
    meganet: { token: '', endpoints: [m.url + '/rest/v1'], stationsUrls: [m.url + '/stations.json'] },
  }));
  const env = Object.assign({}, process.env, {
    RPI_ALERT_CONFIG: path.join(dir, 'etc', 'config.json'), RPI_ALERT_DATA: path.join(dir, 'data'), RPI_ALERT_DEV: path.join(dir, 'dev'),
    RPI_ALERT_SYSFS: path.join(dir, 'sys'), RPI_ALERT_ASSUME_CLOCK: '1', RPI_ALERT_PRIV: '/nonexistent', RPI_ALERT_PORT: String(port),
  });
  const bin = path.join(__dirname, '..', 'bin', 'rpi-alert');
  const agent = spawn(process.execPath, [bin, 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  agent.stderr.on('data', (d) => { log += d; });
  t.after(async () => { agent.kill('SIGTERM'); await m.close(); });
  const api = async (p) => { try { return await (await fetch('http://127.0.0.1:' + port + p)).json(); } catch (_) { return null; } };
  const upAt = Date.now();
  let before = null;
  while (!before && Date.now() - upAt < 15000) { before = await api('/api/status'); if (!before) await wait(100); }
  assert.ok(before, 'the web API comes up:\n' + log);
  assert.equal(before.tokenRequest.state, 'idle');
  assert.equal(before.meganet.tokenSet, false);

  const cli = spawn(process.execPath, [bin, 'request-token'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  cli.stdout.on('data', (d) => { out += d; });
  cli.stderr.on('data', (d) => { out += d; });
  const exited = new Promise(r => cli.on('exit', r));
  assert.ok(await until(() => /WDJB-MJHT/.test(out) && /Admin → Ingest tokens/.test(out), 15000), 'the CLI shows the code:\n' + out);
  assert.ok(/[█▀▄]{20,}/.test(out), 'and a QR code made of blocks');
  const mid = await api('/api/status');
  assert.equal(mid.tokenRequest.state, 'pending');
  assert.equal(mid.tokenRequest.link, 'https://floodwarning.net/#pair=WDJB-MJHT');
  m.approve('WDJB-MJHT', 'Bench Pi');
  assert.equal(await Promise.race([exited, wait(20000).then(() => 'timeout')]), 0, 'the CLI ends happily once approved:\n' + out);
  assert.match(out, /Approved/);
  const after = await api('/api/status');
  assert.equal(after.meganet.tokenSet, true);
  assert.equal(after.tokenRequest.state, 'idle');
  const cfg = await api('/api/config');
  const token = m.requests[0].token;
  assert.match(token, TOKEN);
  assert.equal(cfg.config.meganet.tokenSet, true);
  assert.ok(!JSON.stringify(cfg).includes(token), 'the token never comes back out of the API whole');
  const asked = m.requests[0].payload;
  assert.deepEqual([asked.label, asked.detail.app], ['Bench Pi', 'RPi ALERT'], 'asked under the base station\'s name, saying what it is');
});
