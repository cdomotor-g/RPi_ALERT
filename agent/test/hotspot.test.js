'use strict';
// The Pi's own Wi-Fi network (lib/hotspot.js): up when there is no other,
// down the moment there is, stepping aside so a known network can be found,
// never handing its password to MegaNet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Hotspot, parseStatus, makePassword } = require('../lib/hotspot');
const { Config } = require('../lib/config');
const { toPatch, parse, redactText } = require('../lib/bootconf');

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };

// The root helper, stood in for: what NetworkManager would say, and what was asked of it.
function rig(net) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-hs-'));
  const config = new Config(path.join(dir, 'config.json')).load();
  const agent = Object.assign(new EventEmitter(), { config, log: quiet, state: { data: { hostId: '6dfef7f4' } } });
  const w = Object.assign({ wifi: 'wlan0', active: false, clients: 0, saved: 1, connected: [], country: 'AU' }, net || {});
  const calls = [];
  let t = 1_000_000;
  const exec = async (verb, ...args) => {
    calls.push([verb, ...args]);
    if (verb === 'hotspot-up') { w.active = true; return { code: 0, stdout: '', stderr: '' }; }
    if (verb === 'hotspot-down') { w.active = false; return { code: 0, stdout: '', stderr: '' }; }
    return { code: 2, stdout: '', stderr: 'unknown verb' };
  };
  // What NetworkManager would say, read without root.
  const read = async () => { calls.push(['read']); return Object.assign({}, w, { connected: w.connected.slice() }); };
  const hs = new Hotspot(agent, { exec, read, now: () => t });
  return { hs, w, calls, config, advance: (ms) => { t += ms; }, ups: () => calls.filter(c => c[0] === 'hotspot-up').length, downs: () => calls.filter(c => c[0] === 'hotspot-down').length };
}

test('a password is made the first time, one to read off a screen', () => {
  const r = rig();
  r.hs.start(); r.hs.stop();
  const pw = r.config.get().hotspot.password;
  assert.match(pw, /^[a-km-z2-9]{4}-[a-km-z2-9]{4}-[a-km-z2-9]{4}$/);
  assert.ok(!/[01lIoO]/.test(pw));
  assert.notEqual(makePassword(), makePassword());
});

test('no network: up after three minutes, as RPi-ALERT-<host>, with its password', async () => {
  const r = rig();
  r.hs.start(); r.hs.stop();
  await r.hs.tick();
  assert.equal(r.ups(), 0, 'not at once — a network may be on its way');
  assert.match(r.hs.status().note, /comes up in 3 min/);
  r.advance(3 * 60e3 + 1);
  await r.hs.tick();
  assert.equal(r.ups(), 1);
  const up = r.calls.find(c => c[0] === 'hotspot-up');
  assert.deepEqual(up, ['hotspot-up', 'RPi-ALERT-6DFE', r.config.get().hotspot.password]);
  assert.equal(r.hs.status().active, true);
  assert.equal(r.hs.status().password, undefined, 'the status keeps the password unless asked');
  assert.equal(r.hs.status(true).password, r.config.get().hotspot.password);
});

test('a network appears: the hotspot goes', async () => {
  const r = rig({ active: true });
  r.hs.start(); r.hs.stop();
  r.w.connected = ['eth0:ethernet:Wired connection 1'];
  await r.hs.tick();
  assert.equal(r.downs(), 1);
  assert.match(r.hs.status().note, /On a network \(eth0\)/);
});

test('with nobody on it, it steps aside to let a known network be found, then comes back', async () => {
  const r = rig();
  r.hs.start(); r.hs.stop();
  r.advance(3 * 60e3 + 1); await r.hs.tick();
  assert.equal(r.ups(), 1);
  r.advance(9 * 60e3); await r.hs.tick();
  assert.equal(r.downs(), 0, 'not before ten minutes');
  r.advance(60e3 + 1); await r.hs.tick();
  assert.equal(r.downs(), 1, 'stepped aside');
  r.advance(60e3); await r.hs.tick();
  assert.equal(r.ups(), 1, 'still aside: NetworkManager is looking');
  r.advance(31e3); await r.hs.tick();
  assert.equal(r.ups(), 2, 'nothing found: back');
});

test('…and found one: stays down', async () => {
  const r = rig();
  r.hs.start(); r.hs.stop();
  r.advance(3 * 60e3 + 1); await r.hs.tick();
  r.advance(10 * 60e3 + 1); await r.hs.tick();
  r.w.connected = ['wlan0:wifi:Depot'];
  r.advance(2 * 60e3); await r.hs.tick();
  r.advance(30 * 60e3); await r.hs.tick();
  assert.equal(r.ups(), 1);
  assert.equal(r.hs.status().active, false);
});

test('a phone on it, or no Wi-Fi network saved: it does not step aside', async () => {
  const a = rig({ clients: 1 });
  a.hs.start(); a.hs.stop();
  a.advance(3 * 60e3 + 1); await a.hs.tick();
  a.advance(60 * 60e3); await a.hs.tick();
  assert.equal(a.downs(), 0);
  assert.match(a.hs.status().note, /1 connected/);
  const b = rig({ saved: 0 });
  b.hs.start(); b.hs.stop();
  b.advance(3 * 60e3 + 1); await b.hs.tick();
  b.advance(60 * 60e3); await b.hs.tick();
  assert.equal(b.downs(), 0);
});

test('on and off are what they say; no Wi-Fi, no hotspot', async () => {
  const on = rig({ connected: ['eth0:ethernet:Wired'] });
  on.config.update({ hotspot: { mode: 'on' } });
  on.hs.start(); on.hs.stop();
  await on.hs.tick();
  assert.equal(on.ups(), 1, 'on: even with Ethernet');
  const off = rig({ active: true });
  off.config.update({ hotspot: { mode: 'off' } });
  off.hs.start(); off.hs.stop();
  off.advance(60 * 60e3); await off.hs.tick();
  assert.equal(off.downs(), 1); assert.equal(off.ups(), 0);
  const none = rig({ wifi: null });
  none.hs.start(); none.hs.stop();
  none.advance(60 * 60e3); await none.hs.tick();
  assert.equal(none.ups(), 0);
  assert.equal(none.hs.status().available, false);
});

test('a new name or password is applied to a hotspot that is up', async () => {
  const r = rig();
  r.hs.start(); r.hs.stop();
  r.advance(3 * 60e3 + 1); await r.hs.tick();
  r.config.update({ hotspot: { ssid: 'Mt Mee survey', password: 'correct-horse-7' } });
  await new Promise(res => setTimeout(res, 20));
  const last = r.calls.filter(c => c[0] === 'hotspot-up').pop();
  assert.deepEqual(last, ['hotspot-up', 'Mt Mee survey', 'correct-horse-7']);
});

test('what NetworkManager says, read; none, said so', async () => {
  const devices = 'wlan0:wifi:connected:rpi-alert-hotspot\neth0:ethernet:unavailable:\nlo:loopback:connected (externally):lo\n';
  const conns = 'rpi-alert-hotspot:802-11-wireless\nDepot\\: 2.4 GHz:802-11-wireless\nWired connection 1:802-3-ethernet\nlo:loopback\n';
  const st = 'Station 3a:11:22:33:44:55 (on wlan0)\n\tinactive time:\t100 ms\nStation 9e:aa:bb:cc:dd:ee (on wlan0)\n';
  assert.deepEqual(parseStatus(devices, conns, st, 'global\ncountry AU: DFS-ETSI\n'),
    { wifi: 'wlan0', active: true, clients: 2, saved: 1, connected: [], country: 'AU' });
  const joined = parseStatus('eth0:ethernet:connected:Wired connection 1\nwlan0:wifi:connected:Depot\\: 2.4 GHz\n', conns, '', 'country 00: DFS-UNSET');
  assert.deepEqual(joined.connected, ['eth0:ethernet:Wired connection 1', 'wlan0:wifi:Depot: 2.4 GHz']);
  assert.equal(joined.active, false);
  assert.equal(joined.country, '00');
  assert.equal(parseStatus('eth0:ethernet:connected:Wired\n', '', '', '').wifi, null);
  const r = rig();
  r.hs.read = async () => ({ error: 'NetworkManager (nmcli) is not installed' });
  await r.hs.tick();
  assert.equal(r.hs.status().available, false);
  assert.match(r.hs.status().error, /not installed/);
});

test('settings: its shape is held; MegaNet sees whether a password is set, never it, and cannot change it', () => {
  const r = rig();
  assert.equal(r.config.update({ hotspot: { mode: 'sometimes' } }).ok, false);
  assert.equal(r.config.update({ hotspot: { ssid: 'bad"name' } }).ok, false);
  assert.equal(r.config.update({ hotspot: { password: 'has space in it' } }).ok, false);
  assert.equal(r.config.update({ hotspot: { password: 'abcd-efgh-ijkm', ssid: 'Mt Mee_1' } }).ok, true);
  const remote = require('../lib/remote');
  const rc = remote.remoteConfig(r.config.get());
  assert.deepEqual(rc.hotspot, { mode: 'auto', ssid: 'Mt Mee_1', passwordSet: true });
  assert.ok(!JSON.stringify(rc).includes('abcd-efgh-ijkm'));
  assert.match(remote.checkPatch({ hotspot: { mode: 'off' } }), /set on the base station itself/);
});

test('the SD card: hotspot, its name and its password, the password wiped once applied', () => {
  const { patch, notes } = toPatch(parse('hotspot = on\nhotspot_ssid = Mt Mee survey\nhotspot_password = correct-horse-7\n'));
  assert.deepEqual(patch.hotspot, { mode: 'on', ssid: 'Mt Mee survey', password: 'correct-horse-7' });
  assert.deepEqual(notes, []);
  assert.equal(toPatch(parse('hotspot = no\n')).patch.hotspot.mode, 'off');
  assert.equal(toPatch(parse('hotspot = yes\n')).patch.hotspot.mode, 'auto');
  assert.match(redactText('hotspot_password = correct-horse-7\n'), /removed from the card/);
});
