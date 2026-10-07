'use strict';
// Secure by default (security appraisal H-4): a base station must never ship
// with an open dashboard. If no web password is set, the agent generates one at
// start-up and keeps the plaintext in a 0600 file so it can be shown locally —
// on the Pi's own screen (the kiosk), and by `rpi-alert status` over SSH — while
// the network only ever sees that a password is set, never the value.
//
// The safety property that makes this lockout-proof: local requests (loopback,
// the kiosk) stay auto-authed in the web server, so whoever has the screen, a
// shell, or the SD card can always read or change the password. Only
// unauthenticated network users are shut out, which is the point.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('./state');
const { hashPassword } = require('./config');

const FILE = process.env.RPI_ALERT_WEBPW_FILE || path.join(DATA_DIR, 'web-password.txt');

// No 0/O/1/I/L — a password read off a screen and typed on a phone. 10 symbols
// from a 30-char alphabet is ~49 bits, ample behind the login's 5-try lockout.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generate() {
  const b = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s.slice(0, 5) + '-' + s.slice(5);
}

// Called once at start-up. When no password is set, make one, store its hash in
// the config and the plaintext in FILE (0600). Returns the plaintext it
// generated, or null when a password was already set.
function ensure(config) {
  if (config.get().web.passwordHash) return null;
  const pw = generate();
  config.update({ web: { passwordHash: hashPassword(pw) } });
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, pw + '\n', { mode: 0o600 });
    fs.chmodSync(FILE, 0o600);
  } catch (_) { /* the hash is set regardless; the plaintext is a convenience */ }
  return pw;
}

// The auto-generated password while it is still in force (a password is set and
// the plaintext file is still there), else null once a human sets their own.
function initial(config) {
  if (!config.get().web.passwordHash) return null;
  try { return fs.readFileSync(FILE, 'utf8').trim() || null; } catch (_) { return null; }
}

// Forget the stored plaintext — called when a human sets or removes the password.
function forget() { try { fs.unlinkSync(FILE); } catch (_) { /* already gone */ } }

module.exports = { ensure, initial, forget, generate, FILE };
