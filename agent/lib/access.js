'use strict';
// Who may log in to this base station over SSH — and how a team keeps that
// right when the person who set the Pi up has moved on.
//
// The problem it answers: Raspberry Pi Imager asks whoever writes the card for
// a user name and a password. A year later that person has left, nobody knows
// either, and the base station on the hill can only be reached by driving to
// it. A password everybody shares would fix the forgetting and break
// everything else: one leak opens every base station, and nobody who leaves can
// be shut out without changing it everywhere. So, instead:
//
//   * Every RPi ALERT has the same maintenance account, `alert`, with no
//     password: it logs in with SSH keys only, and may use sudo. A user name
//     nobody has to remember, and nothing to forget.
//   * The keys that open it are a list on the Pi that anyone can read
//     (`rpi-alert access`, the web page, MegaNet's Base Stations tab) — each
//     key one person's, with where it came from. Somebody leaves: their key
//     comes off the list, and only theirs.
//   * The list is made from four places, each optional:
//       local     keys put on the SD card (`ssh_key = …` in rpi-alert.conf),
//                 or with `sudo rpi-alert access add-key` — whoever holds the
//                 card or a sudo shell owns the Pi already
//       GitHub    the public keys of GitHub accounts the card names
//                 (`ssh_github = …`), fetched from github.com/<name>.keys —
//                 a team's own accounts, with nothing to run
//       MegaNet   the team keys MegaNet's administrators keep (public keys
//                 only), when this Pi says it takes them (`ssh_meganet_keys`)
//   * Keys fetched from somewhere (GitHub, MegaNet) work only from a private
//     network — the site's LAN, a VPN — unless the card says otherwise
//     (`ssh_from = any`). A Pi that ends up with a public address is not then
//     opened to the internet by a list somebody else keeps.
//   * Forgotten everything? The SD card: `alert_password = …` in rpi-alert.conf
//     gives the account a password for the console (and for SSH, if password
//     login is on), and is wiped from the card once applied.
//
// What never happens: key material never arrives through the web page, the
// agent or a MegaNet command. Only root writes the list — this module, run by
// the SD card's import at boot, by `sudo rpi-alert access …`, or by
// rpi-alert-access.service fetching the lists named in a policy file only root
// can change. The agent (an unprivileged user facing the network) may ask for
// a sync, turn the MegaNet list on or off, and set password login and where
// fetched keys work from; it can never put a key of its choosing on the list,
// so a fault in it is never a way to a shell. MegaNet is never told a secret
// of the Pi's either: it holds public keys, and the Pi fetches them.
//
// Files (root-owned; the directory is outside /etc/rpi-alert, which the agent
// owns, because sshd refuses a key file in a directory another user could
// write to — and so should we):
//
//   /etc/ssh/rpi-alert/policy.json    what to fetch and how far to trust it
//   /etc/ssh/rpi-alert/local.keys     the local keys
//   /etc/ssh/rpi-alert/alert.keys     the list sshd reads, written from the three
//   /etc/ssh/sshd_config.d/10-rpi-alert.conf
//                                     AuthorizedKeysFile adds …/%u.keys; and
//                                     PasswordAuthentication, when the policy
//                                     says (otherwise Imager's choice stands)
//   /var/lib/rpi-alert-access/        the last good copy of each fetched list,
//                                     so a network outage removes nobody

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ACCOUNT = 'alert';
const DIR = process.env.RPI_ALERT_ACCESS_DIR || '/etc/ssh/rpi-alert';
const STATE = process.env.RPI_ALERT_ACCESS_STATE || '/var/lib/rpi-alert-access';
const DROPIN = process.env.RPI_ALERT_SSHD_DROPIN || '/etc/ssh/sshd_config.d/10-rpi-alert.conf';
const SSHD_CONFIG = process.env.RPI_ALERT_SSHD_CONFIG || '/etc/ssh/sshd_config';
const FILES = {
  policy: path.join(DIR, 'policy.json'),
  local: path.join(DIR, 'local.keys'),
  keys: path.join(DIR, ACCOUNT + '.keys'),
  github: path.join(STATE, 'github.json'),
  meganet: path.join(STATE, 'meganet.json'),
  sync: path.join(STATE, 'last-sync.json'),
};

// The site's own network and the usual VPNs: RFC 1918, carrier-grade NAT
// (Tailscale's range), link-local, loopback, and their IPv6 counterparts.
const PRIVATE_FROM = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16,127.0.0.0/8,fc00::/7,fe80::/10,::1';
const KEY_TYPES = ['ssh-ed25519', 'sk-ssh-ed25519@openssh.com', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521', 'sk-ecdsa-sha2-nistp256@openssh.com', 'ssh-rsa'];
const MAX_KEYS = 100;
const GITHUB_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const PASSWORD_LOGIN = ['unchanged', 'off', 'on'];
const FROM = ['private', 'any'];

// ── a public key ─────────────────────────────────────────────────────────────

function sshString(buf, off) {
  if (off + 4 > buf.length) return null;
  const n = buf.readUInt32BE(off);
  if (off + 4 + n > buf.length) return null;
  return { v: buf.subarray(off + 4, off + 4 + n), next: off + 4 + n };
}

// The bits in an mpint: its length, less leading zero bytes and bits.
function mpintBits(b) {
  let i = 0;
  while (i < b.length && b[i] === 0) i++;
  if (i === b.length) return 0;
  return (b.length - i) * 8 - (Math.clz32(b[i]) - 24);
}

// The way ssh-keygen -l writes it: SHA256: and the digest in base64, no padding.
function fingerprintOf(blob) {
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

function cleanComment(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

// One line of an authorized_keys-style list → { type, b64, comment,
// fingerprint } or { error }. A line with options in front of the key is
// refused, not stripped: options are this module's to add, never a source's.
function parseKey(line) {
  const s = String(line || '').trim();
  const m = /^(\S+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+(.*))?$/.exec(s);
  if (!m) return { error: 'not a public key (expected: type, then the key, then an optional comment)' };
  const [, type, b64, rest] = m;
  if (!KEY_TYPES.includes(type)) return { error: 'a ' + type.slice(0, 40) + ' key is not accepted — use ssh-ed25519 (or ECDSA, or RSA of 2048 bits or more)' };
  const blob = Buffer.from(b64, 'base64');
  if (b64.length % 4 || blob.toString('base64') !== b64) return { error: 'the key is cut short or mistyped' };
  const t = sshString(blob, 0);
  if (!t || t.v.toString('latin1') !== type) return { error: 'the key does not match its type (' + type + ')' };
  if (type === 'ssh-rsa') {
    const e = sshString(blob, t.next), n = e && sshString(blob, e.next);
    if (!n) return { error: 'the RSA key is cut short' };
    if (mpintBits(n.v) < 2048) return { error: 'RSA keys under 2048 bits are refused' };
  } else if (type === 'ssh-ed25519') {
    const k = sshString(blob, t.next);
    if (!k || k.v.length !== 32) return { error: 'the Ed25519 key is cut short' };
  } else if (blob.length < 40) return { error: 'the key is cut short' };
  return { type, b64, comment: cleanComment(rest), fingerprint: fingerprintOf(blob) };
}

// Text → { keys, errors }: blank lines and # comments skipped; each key once.
function parseKeys(text, why) {
  const keys = [], errors = [], seen = new Set();
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const k = parseKey(line);
    if (k.error) { errors.push((why ? why + ' ' : '') + 'line ' + (i + 1) + ': ' + k.error); return; }
    if (seen.has(k.fingerprint)) return;
    seen.add(k.fingerprint);
    keys.push(k);
  });
  return { keys, errors };
}

const keyLine = (k, comment) => k.type + ' ' + k.b64 + (comment || k.comment ? ' ' + (comment || k.comment) : '');

// ── the policy ───────────────────────────────────────────────────────────────

function defaultPolicy() {
  return {
    // Install MegaNet's team keys. Off until this Pi says otherwise: the keys
    // then come from a list kept on another system, which is this Pi's owner's
    // call to make, not MegaNet's.
    meganetKeys: false,
    // GitHub accounts whose public keys may log in.
    github: [],
    // Where keys fetched from GitHub or MegaNet work from: private networks
    // only, or anywhere.
    from: 'private',
    // SSH password login: as Raspberry Pi Imager left it, or off, or on.
    passwordLogin: 'unchanged',
    // MegaNet's address for the team keys, if not the one in the agent's
    // defaults — never read from the agent's own settings, which the agent can
    // change. For testing.
    meganetEndpoints: null,
  };
}

function policyErrors(p) {
  const errs = [];
  if (typeof p.meganetKeys !== 'boolean') errs.push('meganetKeys: true or false');
  if (!Array.isArray(p.github) || p.github.length > 20 || !p.github.every(u => GITHUB_USER.test(u))) errs.push('github: up to 20 GitHub user names');
  if (!FROM.includes(p.from)) errs.push('from: private or any');
  if (!PASSWORD_LOGIN.includes(p.passwordLogin)) errs.push('passwordLogin: unchanged, off or on');
  if (p.meganetEndpoints !== null && !(Array.isArray(p.meganetEndpoints) && p.meganetEndpoints.every(u => /^https?:\/\/\S+$/.test(u)))) errs.push('meganetEndpoints: URLs');
  return errs;
}

function readJson(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return dflt; } }

function loadPolicy() {
  const p = Object.assign(defaultPolicy(), readJson(FILES.policy, {}));
  return policyErrors(p).length ? defaultPolicy() : p;
}

function writeFile(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function writeIfChanged(file, text, mode) {
  let cur = null;
  try { cur = fs.readFileSync(file, 'utf8'); } catch (_) {}
  if (cur === text) return false;
  writeFile(file, text, mode);
  return true;
}

function savePolicy(p) {
  const errs = policyErrors(p);
  if (errs.length) throw new Error(errs.join('; '));
  fs.mkdirSync(DIR, { recursive: true, mode: 0o755 });
  writeFile(FILES.policy, JSON.stringify(p, null, 2) + '\n', 0o644);
  return p;
}

// ── the list sshd reads ──────────────────────────────────────────────────────

function readLocal() { try { return parseKeys(fs.readFileSync(FILES.local, 'utf8'), 'local.keys').keys; } catch (_) { return []; } }

function writeLocal(keys) {
  const text = '# The local keys for the ' + ACCOUNT + ' account: from the SD card (ssh_key = … in rpi-alert.conf)\n'
    + '# or sudo rpi-alert access add-key. Edit with those, not here.\n' + keys.map(k => keyLine(k) + '\n').join('');
  fs.mkdirSync(DIR, { recursive: true, mode: 0o755 });
  writeFile(FILES.local, text, 0o644);
}

// Keys fetched from somewhere are held to the policy; local ones are as given.
function restriction(policy) {
  return (policy.from === 'private' ? 'from="' + PRIVATE_FROM + '",' : '') + 'no-agent-forwarding';
}

// The three sources → the authorized keys file. A key on two lists is written
// once, under the first: local, then GitHub, then MegaNet.
function render(policy, sources) {
  const out = ['# The keys that may log in as ' + ACCOUNT + ' over SSH — written by rpi-alert-access from',
    '# ' + FILES.local + ', the GitHub accounts and MegaNet\'s team keys in ' + FILES.policy + '.',
    '# Do not edit: the next sync writes it again. See `rpi-alert access`.'];
  const seen = new Set();
  let n = 0;
  const add = (k, opts, comment) => {
    if (seen.has(k.fingerprint) || n >= MAX_KEYS) return;
    seen.add(k.fingerprint); n++;
    out.push((opts ? opts + ' ' : '') + keyLine(k, comment));
  };
  for (const k of sources.local || []) add(k, '', k.comment || 'local');
  for (const [user, keys] of Object.entries(sources.github || {})) for (const k of keys) add(k, restriction(policy), 'github:' + user);
  for (const k of sources.meganet || []) add(k, restriction(policy), 'meganet:' + (cleanComment(k.comment).replace(/\s+/g, '_') || 'team'));
  return out.join('\n') + '\n';
}

// What is on the list now, read back from the file sshd reads.
function listed() {
  let text = '';
  try { text = fs.readFileSync(FILES.keys, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const opt = /^(\S*from="[^"]*"\S*|no-agent-forwarding)\s+(.*)$/.exec(line);
    const k = parseKey(opt ? opt[2] : line);
    if (k.error) continue;
    const source = /^github:/.test(k.comment) ? 'github' : /^meganet:/.test(k.comment) ? 'meganet' : 'local';
    out.push({ fingerprint: k.fingerprint, type: k.type, comment: k.comment, source, restricted: !!(opt && /from="/.test(opt[1])) });
  }
  return out;
}

// ── fetching ─────────────────────────────────────────────────────────────────

async function fetchText(url, init) {
  const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(20000) }, init || {}));
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(url.replace(/^https?:\/\//, '') + ' answered ' + res.status), { status: res.status, text });
  return text;
}

async function fetchGithub(user) {
  const { keys, errors } = parseKeys(await fetchText('https://github.com/' + encodeURIComponent(user) + '.keys'), 'github:' + user);
  return { keys: keys.slice(0, 20), errors };
}

// MegaNet's team keys, asked for with this Pi's ingest token. The address is
// the policy's or the built-in one — never the agent's settings — and the
// token is read from the agent's settings file, which root can read.
async function fetchMeganet(policy) {
  const { MEGANET_ENDPOINTS, MEGANET_APIKEY, CONFIG_PATH } = require('./config');
  const cfg = readJson(process.env.RPI_ALERT_CONFIG || CONFIG_PATH, {});
  const token = cfg && cfg.meganet && cfg.meganet.token;
  if (!token) throw Object.assign(new Error('no MegaNet token yet'), { status: 0 });
  let last = null;
  for (const ep of policy.meganetEndpoints || MEGANET_ENDPOINTS) {
    try {
      const text = await fetchText(ep.replace(/\/+$/, '') + '/rpc/base_station_keys', {
        method: 'POST', body: JSON.stringify({ payload: {} }), redirect: 'error',
        headers: { apikey: MEGANET_APIKEY, 'X-Ingest-Token': token, 'Content-Profile': 'meganet', 'Content-Type': 'application/json', Accept: 'application/json' },
      });
      const body = JSON.parse(text);
      const keys = [], errors = [];
      for (const k of (body && Array.isArray(body.keys) ? body.keys : []).slice(0, 50)) {
        const p = parseKey(k && k.key);
        if (p.error) errors.push('meganet ' + ((k && k.fingerprint) || '?') + ': ' + p.error);
        else keys.push(Object.assign(p, { comment: cleanComment(k.comment) || p.comment }));
      }
      return { keys, errors, hash: body && body.hash || null };
    } catch (e) {
      // A refused token is MegaNet's answer, not a fault of the route: no other
      // address would say otherwise.
      if (e.status === 401 || e.status === 403) throw e;
      last = e;
    }
  }
  throw last || new Error('no MegaNet address');
}

// ── sync: fetch what the policy names, write the list ────────────────────────

// Each fetched list is kept as last fetched, so a network outage removes
// nobody's key. An answer that the source no longer has it does: a GitHub
// account that is gone (404), MegaNet refusing this Pi's token (401/403) — a
// Pi MegaNet has disowned keeps no key MegaNet gave it.
// { fetch: false } writes the list from what is already kept — after a local
// key is added, or at boot before there is a network.
async function sync(opts) {
  const fetching = !(opts && opts.fetch === false);
  const policy = loadPolicy();
  const notes = [];
  let failed = false;
  const gh = readJson(FILES.github, {});
  const githubKeys = {};
  for (const user of policy.github) {
    if (fetching) {
      try {
        const r = await fetchGithub(user);
        gh[user] = { at: Date.now(), keys: r.keys.map(k => keyLine(k)) };
        notes.push(...r.errors);
      } catch (e) {
        if (e.status === 404) { delete gh[user]; notes.push('GitHub has no account ' + user + ' — its keys are off the list'); }
        else { failed = true; notes.push('GitHub ' + user + ': ' + e.message + (gh[user] ? ' — keeping the keys fetched ' + new Date(gh[user].at).toISOString() : '')); }
      }
    }
    if (gh[user]) githubKeys[user] = parseKeys(gh[user].keys.join('\n')).keys;
  }
  for (const user of Object.keys(gh)) if (!policy.github.includes(user)) delete gh[user];

  let mg = policy.meganetKeys ? readJson(FILES.meganet, null) : null;
  if (policy.meganetKeys && fetching) {
    try {
      const r = await fetchMeganet(policy);
      mg = { at: Date.now(), hash: r.hash, keys: r.keys.map(k => ({ key: k.type + ' ' + k.b64, comment: k.comment })) };
      notes.push(...r.errors);
    } catch (e) {
      if (e.status === 401 || e.status === 403) { mg = null; notes.push('MegaNet refused this Pi\'s token — its team keys are off the list'); }
      else { failed = true; notes.push('MegaNet team keys: ' + e.message + (mg ? ' — keeping the ones fetched ' + new Date(mg.at).toISOString() : '')); }
    }
  }
  const meganetKeys = mg ? mg.keys.map(k => Object.assign(parseKey(k.key), { comment: k.comment })).filter(k => !k.error) : [];

  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  writeFile(FILES.github, JSON.stringify(gh) + '\n', 0o600);
  if (mg) writeFile(FILES.meganet, JSON.stringify(mg) + '\n', 0o600); else { try { fs.unlinkSync(FILES.meganet); } catch (_) {} }
  const text = render(policy, { local: readLocal(), github: githubKeys, meganet: meganetKeys });
  fs.mkdirSync(DIR, { recursive: true, mode: 0o755 });
  const changed = writeIfChanged(FILES.keys, text, 0o644);
  const summary = { at: Date.now(), ok: !failed, fetched: fetching, changed, notes: notes.slice(0, 20), keys: listed().length, meganetHash: mg ? mg.hash : null };
  writeFile(FILES.sync, JSON.stringify(summary) + '\n', 0o600);
  return summary;
}

// ── sshd ─────────────────────────────────────────────────────────────────────

function dropinText(policy) {
  const lines = ['# RPi ALERT — written by rpi-alert-access from ' + FILES.policy + ' (docs/access.md).',
    '# The ' + ACCOUNT + ' account\'s keys are kept outside its home, where only root can change them;',
    '# every other account keeps its own ~/.ssh/authorized_keys as before.',
    'AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2 ' + DIR + '/%u.keys'];
  if (policy.passwordLogin === 'off') lines.push('# Password login turned off (ssh_password_login = off): keys only.', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no');
  if (policy.passwordLogin === 'on') lines.push('# Password login turned on (ssh_password_login = on).', 'PasswordAuthentication yes');
  return lines.join('\n') + '\n';
}

function run(cmd, args, input) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000, input, stdio: ['pipe', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || e.message || '').trim(), missing: e.code === 'ENOENT' };
  }
}

function sshdBin() {
  for (const p of ['/usr/sbin/sshd', '/usr/bin/sshd']) if (fs.existsSync(p)) return p;
  return null;
}

// `sshd -t` (check) or `sshd -T` (check, and print what it would use), with a
// throwaway host key when the system has none yet — an image being built:
// Raspberry Pi OS makes the Pi's own at its first boot.
function sshdTest(flag) {
  const bin = sshdBin();
  if (!bin) return { ok: true, skipped: true, out: '' };
  const args = [flag || '-t', '-f', SSHD_CONFIG];
  let tmp = null;
  const have = ['ed25519', 'ecdsa', 'rsa'].some(t => fs.existsSync('/etc/ssh/ssh_host_' + t + '_key'));
  if (!have) {
    tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rpa-hk-'));
    if (run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', tmp + '/hk']).ok) args.push('-h', tmp + '/hk');
  }
  const r = run(bin, args);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  return r;
}

// Write the drop-in from the policy; keep it only if sshd accepts the whole
// configuration with it, and tell a running sshd. A drop-in that would stop
// sshd starting is the one way this could lock everybody out, so it is never
// left in place unchecked.
function applyDropin(policy) {
  const text = dropinText(policy || loadPolicy());
  let before = null;
  try { before = fs.readFileSync(DROPIN, 'utf8'); } catch (_) {}
  if (before === text) return { ok: true, changed: false };
  if (!fs.existsSync(path.dirname(DROPIN))) {
    if (!sshdBin()) return { ok: true, changed: false, note: 'no SSH server installed' };
    fs.mkdirSync(path.dirname(DROPIN), { recursive: true, mode: 0o755 });
  }
  writeFile(DROPIN, text, 0o644);
  const t = sshdTest();
  if (!t.ok) {
    if (before === null) fs.unlinkSync(DROPIN); else writeFile(DROPIN, before, 0o644);
    return { ok: false, changed: false, error: 'sshd refused the new settings, so they were not kept: ' + (t.err || 'sshd -t failed').slice(0, 300) };
  }
  // A running sshd re-reads its configuration on reload; existing sessions stay.
  if (process.env.RPI_ALERT_ACCESS_NO_RELOAD !== '1') run('systemctl', ['try-reload-or-restart', 'ssh.service']);
  return { ok: true, changed: true };
}

// ── the account ──────────────────────────────────────────────────────────────

function shadowState(user) {
  try {
    const line = fs.readFileSync('/etc/shadow', 'utf8').split('\n').find(l => l.startsWith(user + ':'));
    if (!line) return null;
    const pw = line.split(':')[1];
    return pw === '' ? 'empty' : /^[!*]/.test(pw) ? 'none' : 'set';
  } catch (_) { return null; }
}

function passwdEntries() {
  try {
    return fs.readFileSync('/etc/passwd', 'utf8').split('\n').filter(Boolean).map(l => {
      const f = l.split(':');
      return { user: f[0], uid: Number(f[2]), home: f[5], shell: f[6] };
    });
  } catch (_) { return []; }
}

const canLogIn = (e) => e.uid >= 1000 && e.uid < 60000 && !/(nologin|false)$/.test(e.shell || '');

function homeKeyCount(home) {
  let n = 0;
  for (const f of ['.ssh/authorized_keys', '.ssh/authorized_keys2']) {
    try { n += parseKeys(fs.readFileSync(path.join(home, f), 'utf8')).keys.length; } catch (_) {}
  }
  return n;
}

// The maintenance account, made if it is missing — install.sh makes it, and
// this is for a Pi whose install predates it. No password ('*': not one that
// can be typed, and not a locked account, which sshd would refuse even a key).
// A system user id, so the first person Raspberry Pi Imager sets up still gets
// 1000, which Raspberry Pi OS's own tools take to be the Pi's user.
function ensureAccount() {
  if (passwdEntries().some(e => e.user === ACCOUNT)) return { ok: true, created: false };
  const r = run('useradd', ['--system', '--create-home', '--home-dir', '/home/' + ACCOUNT, '--shell', '/bin/bash',
    '--comment', 'RPi ALERT maintenance (SSH keys; docs/access.md)', ACCOUNT]);
  if (!r.ok) return { ok: false, error: r.err };
  run('usermod', ['-p', '*', ACCOUNT]);
  for (const g of ['adm', 'systemd-journal', 'dialout', 'plugdev', 'video', 'audio']) run('usermod', ['-aG', g, ACCOUNT]);
  return { ok: true, created: true };
}

// The break-glass password, from the SD card or `sudo rpi-alert access
// alert-password`: '' or null takes it away again.
function setAccountPassword(pw) {
  const e = ensureAccount();
  if (!e.ok) return e;
  if (!pw) {
    const r = run('usermod', ['-p', '*', ACCOUNT]);
    return r.ok ? { ok: true, password: false } : { ok: false, error: r.err };
  }
  if (/[\n\r:]/.test(pw) || pw.length < 8 || pw.length > 128) return { ok: false, error: 'a password of 8–128 characters, on one line' };
  const r = run('chpasswd', [], ACCOUNT + ':' + pw + '\n');
  return r.ok ? { ok: true, password: true } : { ok: false, error: r.err || 'chpasswd failed' };
}

// ── the SSH server ───────────────────────────────────────────────────────────

function sshdEffective() {
  if (!sshdBin()) return null;
  const r = sshdTest('-T');
  if (!r.ok) return { error: (r.err || '').slice(0, 200) };
  const get = (k) => { const m = new RegExp('^' + k + ' (.*)$', 'm').exec(r.out); return m ? m[1].trim() : null; };
  return {
    passwordLogin: get('passwordauthentication') === 'yes' || get('kbdinteractiveauthentication') === 'yes',
    keys: get('pubkeyauthentication') !== 'no',
    port: Number(get('port')) || 22,
    managed: (get('authorizedkeysfile') || '').includes(DIR + '/%u.keys'),
  };
}

function serviceState() {
  const q = (args) => run('systemctl', args).out.trim();
  const enabled = ['ssh.service', 'ssh.socket'].some(u => q(['is-enabled', u]) === 'enabled');
  const active = ['ssh.service', 'ssh.socket'].some(u => q(['is-active', u]) === 'active');
  return { enabled, active };
}

function setSsh(on) {
  const r = run('systemctl', [on ? 'enable' : 'disable', '--now', 'ssh.service']);
  return r.ok ? { ok: true } : { ok: false, error: r.err };
}

// ── what the web page, the CLI and MegaNet are shown ─────────────────────────

function status() {
  const policy = loadPolicy();
  const entries = passwdEntries();
  const acct = entries.find(e => e.user === ACCOUNT);
  const keys = listed();
  const sync = readJson(FILES.sync, null);
  const gh = readJson(FILES.github, {});
  const mg = readJson(FILES.meganet, null);
  const svc = serviceState();
  return {
    account: { name: ACCOUNT, exists: !!acct, password: acct ? shadowState(ACCOUNT) : null,
      sudo: fs.existsSync('/etc/sudoers.d/rpi-alert-maint'), keys: keys.length },
    ssh: Object.assign({ enabled: svc.enabled, active: svc.active }, sshdEffective() || { installed: false }),
    policy: { meganetKeys: policy.meganetKeys, github: policy.github, from: policy.from, passwordLogin: policy.passwordLogin },
    keys,
    sources: {
      github: Object.fromEntries(policy.github.map(u => [u, gh[u] ? { at: gh[u].at, keys: gh[u].keys.length } : null])),
      meganet: policy.meganetKeys ? (mg ? { at: mg.at, keys: mg.keys.length, hash: mg.hash } : null) : undefined,
    },
    lastSync: sync,
    // Every account that can log in, and how — so "what is the user name on
    // this one?" is answered on the screen rather than by whoever set it up.
    logins: entries.filter(e => canLogIn(e) || e.user === ACCOUNT).map(e => ({ user: e.user, password: shadowState(e.user), keys: e.user === ACCOUNT ? keys.length : homeKeyCount(e.home) })),
  };
}

// ── changing it ──────────────────────────────────────────────────────────────

// The few things the agent may change (through rpi-alert-priv): none of them
// puts a key of its choosing on the list.
function setPolicy(what, value) {
  const p = loadPolicy();
  if (what === 'meganet') {
    if (!['on', 'off'].includes(value)) throw new Error('meganet on|off');
    p.meganetKeys = value === 'on';
  } else if (what === 'from') {
    if (!FROM.includes(value)) throw new Error('from private|any');
    p.from = value;
  } else if (what === 'password') {
    if (!PASSWORD_LOGIN.includes(value)) throw new Error('password on|off|unchanged');
    // Keys only, with no key anywhere, is SSH nobody can use: say so first.
    if (value === 'off' && !listed().length && !passwdEntries().filter(canLogIn).some(e => homeKeyCount(e.home))) {
      throw new Error('no account has an SSH key yet, so turning password login off would shut everybody out of SSH — add a key first');
    }
    p.passwordLogin = value;
  } else if (what === 'github') {
    const users = (Array.isArray(value) ? value : String(value || '').split(/[\s,]+/)).map(u => u.trim().replace(/^@/, '')).filter(u => u && u !== 'none');
    const bad = users.filter(u => !GITHUB_USER.test(u));
    if (bad.length) throw new Error('not a GitHub user name: ' + bad.join(', '));
    p.github = [...new Set(users)].slice(0, 20);
  } else throw new Error('unknown setting ' + what);
  savePolicy(p);
  return p;
}

function addLocalKeys(lines) {
  const { keys, errors } = parseKeys([].concat(lines).join('\n'));
  if (errors.length) return { ok: false, error: errors.join('; ') };
  if (!keys.length) return { ok: false, error: 'no key given' };
  const have = readLocal();
  const fps = new Set(have.map(k => k.fingerprint));
  const added = keys.filter(k => !fps.has(k.fingerprint));
  writeLocal(have.concat(added));
  return { ok: true, added: added.map(k => k.fingerprint) };
}

// By fingerprint (SHA256:…, or the start of one) or by the key's comment.
function removeLocalKey(ref) {
  const r = String(ref || '').trim();
  if (!r) return { ok: false, error: 'which key? its fingerprint (rpi-alert access shows them) or its comment' };
  const have = readLocal();
  const hit = have.filter(k => k.fingerprint === r || (r.startsWith('SHA256:') && r.length >= 15 && k.fingerprint.startsWith(r)) || k.comment === r);
  if (!hit.length) return { ok: false, error: 'no local key ' + r + ' (GitHub and MegaNet keys come off their own lists)' };
  writeLocal(have.filter(k => !hit.includes(k)));
  return { ok: true, removed: hit.map(k => k.fingerprint) };
}

function replaceLocalKeys(lines) {
  const { keys, errors } = parseKeys([].concat(lines).join('\n'));
  writeLocal(keys);
  return { ok: !errors.length, keys: keys.length, errors };
}

module.exports = {
  ACCOUNT, DIR, STATE, DROPIN, FILES, PRIVATE_FROM, KEY_TYPES,
  parseKey, parseKeys, fingerprintOf, defaultPolicy, policyErrors, loadPolicy, savePolicy, render, dropinText, listed,
  sync, applyDropin, sshdTest, ensureAccount, setAccountPassword, setSsh, status, setPolicy,
  addLocalKeys, removeLocalKey, replaceLocalKeys, readLocal, GITHUB_USER,
};
