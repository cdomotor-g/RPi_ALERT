'use strict';
// The root helper's three network verbs (os/libexec/rpi-alert-priv), which the
// agent runs by itself when it has lost touch with MegaNet: the real script,
// against a stand-in for NetworkManager that answers what a Pi's would and
// writes down what it was asked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PRIV = path.join(__dirname, '..', '..', 'os', 'libexec', 'rpi-alert-priv');

const NMCLI = `#!/bin/bash
echo "$*" >> "$FAKE/log"
a="$*"
last() { echo "\${a##* }"; }
case "$a" in
  "-t -f DEVICE,TYPE device") cat "$FAKE/devtypes" ;;
  "-g connection.uuid connection show rpi-alert-hotspot") echo hs-uuid ;;
  "-t -f NAME connection show --active") cat "$FAKE/active" 2>/dev/null ;;
  "connection down rpi-alert-hotspot") : > "$FAKE/active" ;;
  "radio wifi on") ;;
  "--escape no -t -f SSID device wifi list ifname wlan0 --rescan yes") cat "$FAKE/seen" ;;
  "--escape no -t -f SSID device wifi list ifname wlan0 --rescan auto") cat "$FAKE/seen-later" 2>/dev/null ;;
  "-t -f TIMESTAMP,UUID,TYPE connection show") cat "$FAKE/saved" ;;
  "-g 802-11-wireless.mode connection show uuid "*) cat "$FAKE/mode-$(last)" 2>/dev/null || echo infrastructure ;;
  "--escape no -g 802-11-wireless.ssid connection show uuid "*) cat "$FAKE/ssid-$(last)" ;;
  "-g 802-11-wireless.hidden connection show uuid "*) cat "$FAKE/hidden-$(last)" 2>/dev/null || echo no ;;
  "--wait 30 connection up uuid "*|"--wait 45 connection up uuid "*) u=$(echo "$a" | awk '{print $6}'); [ -e "$FAKE/joins-$u" ] ;;
  "-t -f DEVICE,TYPE,STATE,CON-UUID device") cat "$FAKE/devices" ;;
  *) echo "nmcli: not expected: $a" >&2; exit 9 ;;
esac
`;
const SYSTEMCTL = `#!/bin/bash
echo "systemctl $*" >> "$FAKE/log"
case "$*" in
  "is-active --quiet NetworkManager.service") [ -e "$FAKE/nm-runs" ] ;;
  "restart NetworkManager.service") [ ! -e "$FAKE/nm-stuck" ] ;;
  *) echo "systemctl: not expected: $*" >&2; exit 9 ;;
esac
`;

// A Pi with Wi-Fi and Ethernet; `files` are what NetworkManager would answer.
function pi(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-priv-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'nmcli'), NMCLI, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'systemctl'), SYSTEMCTL, { mode: 0o755 });
  // The helper sets its own PATH; the stand-ins go in front of it.
  const src = fs.readFileSync(PRIV, 'utf8');
  assert.match(src, /^export PATH=\/usr\/sbin:/m);
  const script = path.join(dir, 'rpi-alert-priv');
  fs.writeFileSync(script, src.replace(/^export PATH=/m, 'export PATH=' + bin + ':'), { mode: 0o755 });
  const all = Object.assign({ devtypes: 'eth0:ethernet\nwlan0:wifi\nlo:loopback\n', active: '', seen: '', saved: '', devices: '' }, files || {});
  for (const [k, v] of Object.entries(all)) fs.writeFileSync(path.join(dir, k), v);
  const run = (...args) => {
    const r = spawnSync('bash', [script, ...args], { env: Object.assign({}, process.env, { FAKE: dir }), encoding: 'utf8' });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const log = () => fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n');
  return { dir, run, log, has: (f) => fs.readFileSync(path.join(dir, f), 'utf8') };
}

test('wifi-rejoin: takes the hotspot down and joins the saved network in range, by name', () => {
  const p = pi({
    active: 'rpi-alert-hotspot\n',
    seen: 'Neighbours\nDepot WiFi: 5G\n\n',
    // Used most recently first, whatever order NetworkManager lists them in.
    saved: '100:u-old:802-11-wireless\n0:hs-uuid:802-11-wireless\n900:u-depot:802-11-wireless\n500:u-wired:802-3-ethernet\n',
    'ssid-u-old': 'Old Office\n', 'ssid-u-depot': 'Depot WiFi: 5G\n', 'joins-u-depot': '',
  });
  const r = p.run('wifi-rejoin');
  assert.deepEqual([r.code, r.out], [0, 'joined Depot WiFi: 5G']);
  assert.equal(p.has('active'), '', 'the hotspot came down first');
  const ups = p.log().filter(l => /connection up/.test(l));
  assert.deepEqual(ups, ['--wait 30 connection up uuid u-depot ifname wlan0'], 'only the one in range is tried — never the hotspot, never Ethernet');
});

test('wifi-rejoin: nothing saved is in range — 3, and nothing tried', () => {
  const p = pi({ seen: 'Neighbours\n', saved: '900:u-depot:802-11-wireless\n', 'ssid-u-depot': 'Depot\n', 'joins-u-depot': '' });
  const r = p.run('wifi-rejoin');
  assert.equal(r.code, 3);
  assert.match(r.err, /no saved Wi-Fi network is in range/);
  assert.ok(!p.log().some(l => /connection up/.test(l)));
});

test('wifi-rejoin: in range but it will not have the Pi — 4; the next saved one is tried, three at most', () => {
  const saved = [1, 2, 3, 4].map(i => (10 - i) + ':u' + i + ':802-11-wireless').join('\n') + '\n';
  const files = { seen: 'A\nB\nC\nD\n', saved };
  ['A', 'B', 'C', 'D'].forEach((n, i) => { files['ssid-u' + (i + 1)] = n + '\n'; });
  const p = pi(files);
  const r = p.run('wifi-rejoin');
  assert.equal(r.code, 4);
  assert.match(r.err, /could not be joined: 3 saved/);
  assert.equal(p.log().filter(l => /connection up/.test(l)).length, 3);
  // The second one works.
  const q = pi(Object.assign({}, files, { 'joins-u2': '' }));
  assert.deepEqual([q.run('wifi-rejoin').code, q.log().filter(l => /connection up/.test(l)).length], [0, 2]);
});

test('wifi-rejoin: a hidden network is tried though no scan shows it; an access point of its own is not', () => {
  const p = pi({ seen: '\n', saved: '9:u-ap:802-11-wireless\n5:u-hid:802-11-wireless\n', 'ssid-u-ap': 'Some AP\n', 'mode-u-ap': 'ap\n',
    'ssid-u-hid': 'Quiet\n', 'hidden-u-hid': 'yes\n', 'joins-u-hid': '' });
  const r = p.run('wifi-rejoin');
  assert.deepEqual([r.code, r.out], [0, 'joined Quiet']);
  assert.deepEqual(p.log().filter(l => /connection up/.test(l)), ['--wait 30 connection up uuid u-hid ifname wlan0']);
});

test('wifi-rejoin: a first scan that shows nothing is asked for once more', () => {
  const p = pi({ seen: '', 'seen-later': 'Depot\n', saved: '9:u-depot:802-11-wireless\n', 'ssid-u-depot': 'Depot\n', 'joins-u-depot': '' });
  assert.deepEqual([p.run('wifi-rejoin').code, p.log().filter(l => /wifi list/.test(l)).length], [0, 2]);
});

test('wifi-rejoin: no Wi-Fi, said so', () => {
  const r = pi({ devtypes: 'eth0:ethernet\n' }).run('wifi-rejoin');
  assert.equal(r.code, 2);
  assert.match(r.err, /no Wi-Fi/);
});

test('net-reconnect: each connection the Pi has is brought up again — not the hotspot, not what is down', () => {
  const p = pi({ devices: 'eth0:ethernet:connected:u-wired\nwlan0:wifi:connected:hs-uuid\nwlan1:wifi:disconnected:\nlo:loopback:connected (externally):u-lo\n', 'joins-u-wired': '' });
  const r = p.run('net-reconnect');
  assert.deepEqual([r.code, r.out], [0, 'renewed 1 of 1']);
  assert.deepEqual(p.log().filter(l => /connection up/.test(l)), ['--wait 45 connection up uuid u-wired ifname eth0']);
  const none = pi({ devices: 'wlan0:wifi:disconnected:\n' }).run('net-reconnect');
  assert.equal(none.code, 2);
  assert.match(none.err, /no network connection to renew/);
  const failed = pi({ devices: 'wlan0:wifi:connected:u-depot\n' }).run('net-reconnect');
  assert.equal(failed.code, 2);
  assert.match(failed.err, /could not be renewed/);
});

test('net-restart: NetworkManager is restarted where it runs the network, and never started where it does not', () => {
  const p = pi({ 'nm-runs': '' });
  const r = p.run('net-restart');
  assert.deepEqual([r.code, r.out], [0, 'NetworkManager restarted']);
  assert.ok(p.log().includes('systemctl restart NetworkManager.service'));
  const other = pi();
  const o = other.run('net-restart');
  assert.equal(o.code, 2);
  assert.match(o.err, /does not run this Pi's network/);
  assert.ok(!other.log().includes('systemctl restart NetworkManager.service'));
});

test('none of the three takes anything from its caller', () => {
  // Arguments are ignored, not passed on: which networks, and their passwords, are NetworkManager's.
  const p = pi({ seen: 'Depot\n', saved: '9:u-depot:802-11-wireless\n', 'ssid-u-depot': 'Depot\n', 'joins-u-depot': '' });
  assert.equal(p.run('wifi-rejoin', 'Evil; reboot', '--wait 0').code, 0);
  assert.ok(p.log().every(l => !/Evil/.test(l)));
});
