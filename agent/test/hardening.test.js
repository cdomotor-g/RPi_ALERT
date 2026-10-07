'use strict';
// Security-hardening fixes from the 2026-10 appraisal: the DNS-rebinding Host
// guard (H-5), the boot-config secret redaction aliases (L-1), the extraPorts
// traversal guard (L-2), and carrier-grade NAT no longer counting as a private
// network for fetched SSH keys (M-9).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { hostAllowed } = require('../lib/web/server');
const { validate, defaults, merge } = require('../lib/config');
const { redactText } = require('../lib/bootconf');
const access = require('../lib/access');

const asReq = (host) => ({ headers: host === undefined ? {} : { host } });

test('H-5: the Host guard allows real access patterns and refuses a rebinding domain', () => {
  // Legitimate ways to reach the Pi.
  assert.ok(hostAllowed(asReq('localhost')), 'localhost');
  assert.ok(hostAllowed(asReq('localhost:80')), 'localhost with a port');
  assert.ok(hostAllowed(asReq('rpi-alert.local')), 'the mDNS name');
  assert.ok(hostAllowed(asReq(os.hostname() + '.local')), 'this Pi\'s .local name');
  assert.ok(hostAllowed(asReq(os.hostname())), 'the bare hostname');
  assert.ok(hostAllowed(asReq('192.168.1.50')), 'a LAN IPv4 literal');
  assert.ok(hostAllowed(asReq('10.42.0.1:80')), 'the hotspot address');
  assert.ok(hostAllowed(asReq('[fe80::1]:80')), 'an IPv6 literal with a port');
  assert.ok(hostAllowed(asReq(undefined)), 'no Host header (local tools)');
  // A website the operator visited, rebinding its own name to the Pi's address.
  assert.ok(!hostAllowed(asReq('evil.example')), 'an attacker domain is refused');
  assert.ok(!hostAllowed(asReq('rpi-alert.evil.example')), 'a look-alike domain is refused');
});

test('L-1: every accepted spelling of a secret key is redacted from the card', () => {
  for (const line of [
    'token = mgn_aaaaaaaaaaaaaaaa',
    'meganet_token = mgn_bbbbbbbbbbbbbbbb',
    'ingest_token = mgn_cccccccccccccccc',
    'web_password = hunter2hunter2',
    'password = hunter2hunter2',
    'wifi_password = correct-horse',
    'wifi_psk = correct-horse',
    'alert_password = let-me-in-please',
    'hotspot_password = correct-horse-7',
    'gps_bluetooth_pin = 123456',
  ]) {
    const secret = line.split('=')[1].trim();
    const red = redactText(line);
    assert.ok(!red.includes(secret), 'redacts: ' + line.split('=')[0].trim());
    assert.match(red, /removed from the card/);
  }
  // A non-secret key is left as it was.
  assert.match(redactText('name = Mount Tabletop'), /name = Mount Tabletop/);
  assert.match(redactText('ssh_password_login = on'), /ssh_password_login = on/);
});

test('L-2: extraPorts rejects a path with a ".." segment', () => {
  const ok = (ports) => validate(merge(defaults(), { receivers: { extraPorts: ports } }))
    .every(e => !/extraPorts/.test(e));
  assert.ok(ok(['/dev/serial0']), 'a plain device node');
  assert.ok(ok(['/dev/serial/by-id/usb-foo']), 'a by-id path');
  assert.ok(!ok(['/dev/../etc/shadow']), 'traversal out of /dev is refused');
  assert.ok(!ok(['/dev/tty/../../etc/passwd']), 'a nested traversal is refused');
});

test('M-9: carrier-grade NAT is no longer a private network', () => {
  assert.ok(!access.PRIVATE_FROM.includes('100.64'), '100.64.0.0/10 is not in the private set');
  assert.ok(access.PRIVATE_FROM.includes('192.168.0.0/16'), 'RFC 1918 still is');
});
