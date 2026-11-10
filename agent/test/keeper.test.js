'use strict';
// Getting back in touch by itself (lib/keeper.js): what it does when no
// MegaNet door answers, in what order, how long it waits — and all the times
// it must not restart anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Keeper, FIRST_MS, REBOOT_AFTER_MS } = require('../lib/keeper');
const { Config } = require('../lib/config');
const { toPatch, parse } = require('../lib/bootconf');
const { checkPatch } = require('../lib/remote');

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const MIN = 60e3, HOUR = 60 * MIN;

// A base station on Wi-Fi with one saved network, that has reached MegaNet
// before; `w` is the world around it, and `calls` what it asked root to do.
function rig(opts) {
  opts = opts || {};
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-keep-'));
  const config = new Config(path.join(dir, 'config.json')).load();
  config.update({ meganet: { token: 'mgn_test_token' } });
  let t = opts.t || 1_800_000_000_000, m = 0;
  const w = Object.assign({ up: true, net: { wifi: 'wlan0', active: false, clients: 0, saved: 1, connected: [] }, internet: false, names: true, fresh: false,
    updating: false, survey: false, boot: 'boot-a', fix: null, sent: 0, persisted: 0 }, opts.world || {});
  const api = { unreachableSince: null, lastAnswerAt: null, lastFailure: 'ENETUNREACH', endpoints: () => [{ url: 'https://flood.example/rest/v1', i: 0 }],
    async reach() { if (w.up) { this.lastAnswerAt = t; this.unreachableSince = null; return true; } if (this.unreachableSince == null) this.unreachableSince = t; return false; } };
  const agent = { config, log: quiet, dataDir: dir, uplink: { api, enabled: () => !!config.get().meganet.token && config.get().meganet.enabled, sendNow() { w.sent++; }, persistNow() { w.persisted++; } },
    survey: { running: () => w.survey }, clock: { bootId: () => w.boot } };
  const calls = [];
  const exec = async (verb) => {
    calls.push([verb, Math.round(m / MIN)]);
    // The step that mends it, when the test names one.
    if (w.fix === verb) { w.up = true; return { code: 0, stdout: verb === 'wifi-rejoin' ? 'joined Depot\n' : '', stderr: '' }; }
    if (verb === 'wifi-rejoin') return { code: 3, stdout: '', stderr: 'no saved Wi-Fi network is in range' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const k = new Keeper(agent, { exec, now: () => t, mono: () => m,
    probe: { net: async () => w.net, internet: async () => w.internet, door: async () => !!w.door, names: async () => w.names, fresh: async () => w.fresh, updating: () => w.updating } }).load();
  const r = { dir, k, w, api, calls, config, advance(ms) { t += ms; m += ms; }, wall(ms) { t += ms; }, now: () => t,
    // Half-minute looks, as the agent takes them, for this long.
    async run(ms) { for (let i = 0; i < ms / 30e3; i++) { r.advance(30e3); await k.tick(); } },
    // MegaNet stops answering now.
    lose() { w.up = false; api.unreachableSince = t; },
    did: () => calls.map(c => c[0] + '@' + c[1]) };
  return r;
}
// …that reached MegaNet a moment ago.
async function reachedRig(opts) { const r = rig(opts); await r.api.reach(); await r.k.tick(); return r; }

test('while MegaNet answers, nothing is done and nothing is written but the odd "it answered"', async () => {
  const r = await reachedRig();
  await r.run(30 * MIN);
  assert.deepEqual(r.calls, []);
  assert.equal(r.k.status().state, 'ok');
  assert.equal(r.k.status().history.length, 0);
});

test('no network: joins a saved Wi-Fi network at two minutes and every ten, restarts networking at fifteen, reboots at forty-five', async () => {
  const r = await reachedRig();
  r.lose();
  await r.run(46 * MIN);
  assert.deepEqual(r.did(), ['wifi-rejoin@2', 'wifi-rejoin@12', 'net-restart@15', 'wifi-rejoin@22', 'wifi-rejoin@32', 'wifi-rejoin@42', 'reboot@45']);
  assert.equal(r.k.status().state, 'down');
  assert.equal(r.k.status().kind, 'no-network');
  assert.ok(r.w.persisted >= 1, 'the queue is written before the reboot');
  const kept = JSON.parse(fs.readFileSync(path.join(r.dir, 'keeper.json'), 'utf8'));
  assert.equal(kept.reboots, 1);
  assert.equal(kept.out.steps[kept.out.steps.length - 1].what, 'reboot');
});

test('what it says while it waits is what it will do next', async () => {
  const r = await reachedRig();
  r.lose();
  await r.run(5 * MIN);
  assert.match(r.k.status().note, /on no network\. Restarting its networking in 10 min .* Rebooting the Pi in 40 min/);
});

test('each reboot in one outage waits longer than the last: 45 min, then 3 h, then 12 h, then a day', async () => {
  let r = await reachedRig();
  r.lose();
  const dir = r.dir;
  const waits = [];
  for (let n = 0; n < 4; n++) {
    await r.run(REBOOT_AFTER_MS[Math.min(n, REBOOT_AFTER_MS.length - 1)] + MIN);
    const boot = r.calls.find(c => c[0] === 'reboot');
    assert.ok(boot, 'reboot ' + (n + 1));
    waits.push(boot[1]);
    // The Pi comes up again, still with no network.
    r = rig({ dir, t: r.now(), world: { up: false, boot: 'boot-' + n } });
    assert.equal(r.k.status().state, 'down', 'the outage is carried over the reboot');
  }
  assert.deepEqual(waits, [45, 180, 720, 1440]);
});

test('a link that comes back is noticed at once, recorded with what brought it back, and the queue told to send', async () => {
  const r = await reachedRig({ world: { fix: 'net-restart' } });
  r.lose();
  await r.run(16 * MIN);
  assert.deepEqual(r.did(), ['wifi-rejoin@2', 'wifi-rejoin@12', 'net-restart@15']);
  const s = r.k.status();
  assert.equal(s.state, 'ok');
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].how, 'net-restart');
  assert.equal(s.history[0].kind, 'no-network');
  // The same step failing the same way twice is one line, counted.
  assert.deepEqual(s.history[0].steps.map(x => [x.what, x.ok, x.n]), [['wifi-rejoin', false, 2], ['net-restart', true, undefined]]);
  assert.match(s.history[0].steps[0].note, /no saved Wi-Fi network is in range/);
  assert.equal(r.w.sent, 1);
  const b = r.k.brief();
  assert.equal(b.mode, 'full');
  assert.deepEqual(JSON.parse(JSON.stringify(b.outages[0].steps)), [{ what: 'wifi-rejoin', ok: false, n: 2 }, { what: 'net-restart', ok: true }]);
});

test('a blip under two minutes is not an outage', async () => {
  const r = await reachedRig();
  r.lose();
  await r.run(90e3);
  r.w.up = true; r.api.lastAnswerAt = r.now(); r.api.unreachableSince = null;
  await r.run(5 * MIN);
  assert.deepEqual(r.calls, []);
  assert.equal(r.k.status().history.length, 0);
});

test('requests timing out on a slow database, while a door still answers, are not an outage — nothing recorded, nothing hurried', async () => {
  const r = await reachedRig();
  // The queue's requests fail (no answer in time); the small request the keeper makes is answered.
  for (let i = 0; i < 40; i++) {
    if (r.api.unreachableSince == null) r.api.unreachableSince = r.now();   // another post timed out
    await r.run(30e3);
  }
  assert.deepEqual(r.calls, []);
  assert.equal(r.k.status().state, 'ok');
  assert.equal(r.k.status().history.length, 0, 'no outage is recorded');
  assert.equal(r.w.sent, 0, 'and the queue is not told to send at once');
  assert.match(r.k.status().note, /answering, slowly or with errors/);
});

test('a network that lets nothing out but MegaNet\'s own door: the door taking a connection means the trouble is its far side — no restart', async () => {
  const r = await reachedRig({ world: { internet: false, door: true, names: true, fresh: false, net: { wifi: null, active: false, clients: 0, saved: 0, connected: ['eth0:ethernet:Office'] } } });
  r.lose();
  await r.run(6 * HOUR);
  assert.deepEqual(r.calls, []);
  assert.equal(r.k.status().kind, 'far-end');
});

test('on a network that passes nothing: the connection is renewed at five minutes, then every fifteen', async () => {
  const r = await reachedRig({ world: { net: { wifi: 'wlan0', active: false, clients: 0, saved: 1, connected: ['wlan0:wifi:Depot'] } } });
  r.lose();
  await r.run(21 * MIN);
  assert.deepEqual(r.did(), ['net-reconnect@5', 'net-restart@15', 'net-reconnect@20']);
  assert.equal(r.k.status().kind, 'dead-link');
});

test('with the hotspot up, joining Wi-Fi is the hotspot\'s to do; with a phone on it, nothing is touched', async () => {
  const r = await reachedRig({ world: { net: { wifi: 'wlan0', active: true, clients: 0, saved: 1, connected: [] } } });
  r.lose();
  await r.run(14 * MIN);
  assert.deepEqual(r.calls, [], 'lib/hotspot.js steps aside and joins by itself');
  r.w.net.clients = 1;
  await r.run(4 * HOUR);
  assert.deepEqual(r.calls, []);
  assert.match(r.k.status().note, /Somebody is on its hotspot/);
  // A hotspot that is always on is the site's Wi-Fi, not somebody at the Pi.
  r.config.update({ hotspot: { mode: 'on' } });
  await r.run(MIN);
  assert.ok(r.calls.length > 0);
});

test('network: everything but the reboot. off: nothing, as before 0.23', async () => {
  const r = await reachedRig();
  r.config.update({ recover: { mode: 'network' } });
  r.lose();
  await r.run(3 * HOUR);
  assert.ok(r.did().includes('net-restart@15') && r.did().includes('net-restart@135'), 'networking restarted, and again two hours on');
  assert.ok(!r.calls.some(c => c[0] === 'reboot'));
  assert.match(r.k.status().note, /will not reboot the Pi: that is turned off/);
  const n = r.calls.length;
  r.config.update({ recover: { mode: 'off' } });
  await r.run(3 * HOUR);
  assert.equal(r.calls.length, n);
  assert.equal(r.k.status().state, 'off');
});

test('a Pi that has never reached MegaNet — a survey on a hill — is never rebooted', async () => {
  const r = rig({ world: { up: false } });
  r.api.unreachableSince = r.now();
  await r.run(5 * HOUR);
  assert.ok(!r.calls.some(c => c[0] === 'reboot'));
  assert.match(r.k.status().note, /has not reached Flood-Net in the last week/);
});

test('nor one that last reached it over a week ago', async () => {
  const r = await reachedRig();
  r.wall(8 * 24 * HOUR);
  r.lose();
  await r.run(2 * HOUR);
  assert.ok(!r.calls.some(c => c[0] === 'reboot'));
});

test('during a survey nothing is restarted; while an update installs, no reboot', async () => {
  const r = await reachedRig({ world: { survey: true } });
  r.lose();
  await r.run(2 * HOUR);
  assert.ok(r.calls.every(c => c[0] === 'wifi-rejoin'), 'only joining a saved network: ' + r.did().join(' '));
  assert.match(r.k.status().note, /A survey is running/);
  const u = await reachedRig({ world: { updating: true } });
  u.lose();
  await u.run(2 * HOUR);
  assert.ok(!u.calls.some(c => c[0] === 'reboot'));
  assert.match(u.k.status().note, /An update is installing/);
  u.w.updating = false;
  await u.run(MIN);
  assert.ok(u.calls.some(c => c[0] === 'reboot'));
});

test('not sending by choice — no token, or sending turned off — is not an outage', async () => {
  const r = await reachedRig();
  r.config.update({ meganet: { enabled: false } });
  r.lose();
  await r.run(3 * HOUR);
  assert.deepEqual(r.calls, []);
  assert.equal(r.k.status().state, 'ok');
});

test('the internet is there and MegaNet answers nobody: its end — nothing here is restarted', async () => {
  const r = await reachedRig({ world: { internet: true, names: true, fresh: false, net: { wifi: 'wlan0', active: false, clients: 0, saved: 1, connected: ['wlan0:wifi:Depot'] } } });
  r.lose();
  await r.run(24 * HOUR);
  assert.deepEqual(r.calls, []);
  assert.equal(r.k.status().kind, 'far-end');
  assert.match(r.k.status().note, /the trouble is at its end/);
});

test('the internet is there but MegaNet\'s name is not found: renew at ten minutes, restart networking at twenty, never reboot', async () => {
  const r = await reachedRig({ world: { internet: true, names: false, net: { wifi: null, active: false, clients: 0, saved: 0, connected: ['eth0:ethernet:Wired'] } } });
  r.lose();
  await r.run(6 * HOUR);
  assert.deepEqual(r.did(), ['net-reconnect@10', 'net-restart@20']);
});

test('another program reaches MegaNet and the agent does not: the agent is restarted — at 10 min, then 30, then 2 h, then left for a person', async () => {
  const world = { internet: true, names: true, fresh: true, net: { wifi: null, active: false, clients: 0, saved: 0, connected: ['eth0:ethernet:Wired'] } };
  let r = await reachedRig({ world });
  r.lose();
  const dir = r.dir, at = [];
  for (let n = 0; n < 3; n++) {
    // Until it restarts the agent — which, on a Pi, ends this process.
    for (let i = 0; i < 6 * 60 && !r.calls.length; i++) await r.run(30e3);
    assert.deepEqual(r.calls.map(c => c[0]), ['restart-agent']);
    at.push(r.calls[0][1]);
    r = rig({ dir, t: r.now(), world: Object.assign({}, world, { up: false }) });   // the same boot: the agent only
  }
  assert.deepEqual(at, [10, 30, 120]);
  await r.run(24 * HOUR);
  assert.deepEqual(r.calls, []);
  assert.match(r.k.status().note, /needs a person/);
});

test('the record tells a reboot of its own from the Pi switched off and on by somebody', async () => {
  let r = await reachedRig();
  r.lose();
  await r.run(20 * MIN);                       // rejoined twice, networking restarted — no good
  const dir = r.dir;
  r = rig({ dir, t: r.now() + 8 * HOUR, world: { up: true, boot: 'boot-b' } });   // somebody power-cycles it in the morning
  await r.k.tick();
  const h = r.k.status().history[0];
  assert.equal(h.how, 'power');
  assert.deepEqual(h.steps.map(s => s.what), ['wifi-rejoin', 'net-restart', 'power']);
  assert.ok(h.ended - h.began > 8 * HOUR);
  assert.equal(r.w.sent, 1);
});

test('the wall clock set forward by days — NTP, a GPS — brings no reboot forward', async () => {
  const r = await reachedRig();
  r.lose();
  await r.run(5 * MIN);
  r.wall(3 * 24 * HOUR);
  await r.run(5 * MIN);
  assert.ok(!r.calls.some(c => c[0] === 'reboot' || c[0] === 'net-restart'), r.did().join(' '));
});

test('a keeper.json that is not what it should be is ignored, not fatal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-keep-'));
  fs.writeFileSync(path.join(dir, 'keeper.json'), '{"history":"x","out":{"since":"soon","steps":7},"reboots":-4}');
  const r = rig({ dir });
  assert.equal(r.k.status().state, 'ok');
  assert.equal(r.k.status().reboots, 0);
  fs.writeFileSync(path.join(dir, 'keeper.json'), 'not json');
  assert.equal(rig({ dir }).k.status().history.length, 0);
});

test('settings: full by default; the card and MegaNet may set it; nothing else is taken', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-keep-'));
  const c = new Config(path.join(dir, 'config.json')).load();
  assert.equal(c.get().recover.mode, 'full');
  assert.equal(c.update({ recover: { mode: 'sometimes' } }).ok, false);
  assert.equal(c.update({ recover: { mode: 'network' } }).ok, true);
  assert.equal(checkPatch({ recover: { mode: 'off' } }), null, 'an administrator can turn it down from the Base Stations tab');
  assert.equal(toPatch(parse('self_recovery = network\n')).patch.recover.mode, 'network');
  assert.equal(toPatch(parse('self_recovery = no\n')).patch.recover.mode, 'off');
  assert.match(toPatch(parse('self_recovery = maybe\n')).notes.join(' '), /self_recovery: full, network or off/);
  assert.equal(FIRST_MS, 2 * MIN);
});
