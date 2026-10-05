'use strict';
// The dashboard and settings, on port 80: a JSON API, a Server-Sent Events
// stream for live readings, and the static page in agent/web.
//
// Who may change things:
//   * this Pi itself (the kiosk browser on the monitor, the rpi-alert CLI over
//     SSH) — always: whoever has the keyboard or a shell has the Pi anyway;
//   * anyone on the network until a web password is set (first-time setup),
//     with the page saying so plainly;
//   * after that, only someone who has logged in with it.
// The ingest token is never sent back out, whoever asks: only a masked form.
// Mutations must be JSON, which a cross-site form cannot send, and sessions
// are SameSite=Strict cookies.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const logm = require('../log');
const { hashPassword, checkPassword } = require('../config');
const system = require('../system');

const STATIC = path.join(__dirname, '..', '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const SESSION_MS = 7 * 24 * 3600 * 1000;

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1') && !req.headers['x-forwarded-for'];
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

class WebServer {
  constructor(agent) {
    this.agent = agent;
    this.log = logm.logger('web');
    this.sessions = new Map();   // id → expiry
    this.fails = new Map();      // ip → { n, until }
    this.clients = new Set();
    this.server = null;
    this.port = null;
  }

  start() {
    const want = this.agent.config.get().web.port;
    this.server = http.createServer((req, res) => this.handle(req, res).catch(e => {
      this.log.error(e.stack || e);
      if (!res.headersSent) this.json(res, 500, { error: 'internal error: ' + e.message });
      else res.end();
    }));
    this.server.on('error', (e) => {
      if ((e.code === 'EACCES' || e.code === 'EADDRINUSE') && this.port !== 8080 && want !== 8080) {
        this.log.warn('cannot listen on port ' + want + ' (' + e.code + ') — using 8080 instead');
        this.port = 8080;
        this.server.listen(8080);
      } else this.log.error('web server: ' + e.message);
    });
    this.port = want;
    this.server.listen(want, () => this.log.info('dashboard on http://' + require('node:os').hostname() + '.local' + (this.port === 80 ? '' : ':' + this.port) + '/'));
    this.wire();
    return this;
  }

  stop() { for (const c of this.clients) c.end(); if (this.server) this.server.close(); }

  // ── live events ─────────────────────────────────────────────────────────

  wire() {
    const a = this.agent;
    a.on('reading', (r) => this.broadcast('reading', r));
    a.on('token-request', (t) => this.broadcast('token-request', t));
    a.on('burst', (b) => this.broadcast('burst', b));
    a.on('tick', () => this.broadcast('tick', { t: Date.now() }));
    let devTimer = null;
    a.on('devices', () => { if (!devTimer) devTimer = setTimeout(() => { devTimer = null; this.broadcast('devices', {}); }, 500); });
    logm.on((line) => this.broadcast('log', line, true));
    setInterval(() => { for (const c of this.clients) c.write(': keep-alive\n\n'); }, 25000).unref();
  }

  broadcast(type, data, needAuth) {
    const msg = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const c of this.clients) if (!needAuth || c.authed) c.write(msg);
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  json(res, code, body, headers) {
    const s = JSON.stringify(body);
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
    res.end(s);
  }

  authed(req) {
    if (isLocal(req)) return true;
    if (!this.agent.config.get().web.passwordHash) return true;
    const id = cookies(req).rpa_session;
    const exp = id && this.sessions.get(id);
    if (exp && exp > Date.now()) return true;
    if (exp) this.sessions.delete(id);
    return false;
  }

  body(req) {
    return new Promise((resolve, reject) => {
      const ct = String(req.headers['content-type'] || '');
      if (!/^application\/json/i.test(ct)) return reject(Object.assign(new Error('send JSON'), { status: 415 }));
      let n = 0; const parts = [];
      req.on('data', (d) => { n += d.length; if (n > 65536) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else parts.push(d); });
      req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('bad JSON'), { status: 400 })); } });
      req.on('error', reject);
    });
  }

  sameOrigin(req) {
    const o = req.headers.origin;
    if (!o) return true;
    try { return new URL(o).host === req.headers.host; } catch (_) { return false; }
  }

  // ── routes ──────────────────────────────────────────────────────────────

  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (!p.startsWith('/api/')) return this.static(p, res);
    const a = this.agent;
    const authed = this.authed(req);
    const mutate = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutate && !this.sameOrigin(req)) return this.json(res, 403, { error: 'cross-site request refused' });
    const needAuth = () => { if (authed) return false; this.json(res, 401, { error: 'log in first', login: true }); return true; };
    let body = {};
    if (mutate) {
      try { body = await this.body(req); } catch (e) { return this.json(res, e.status || 400, { error: e.message }); }
    }

    if (p === '/api/status' && req.method === 'GET') {
      const s = await a.status();
      s.auth = { authed, local: isLocal(req), passwordSet: !!a.config.get().web.passwordHash };
      if (!authed) redactPlace(s);
      return this.json(res, 200, s);
    }
    if (p === '/api/readings') {
      const n = Math.min(500, Number(url.searchParams.get('limit')) || 200);
      return this.json(res, 200, { readings: a.recent.slice(0, n), bursts: a.bursts.slice(0, 50) });
    }
    if (p === '/api/events') return this.sse(req, res, authed);
    if (p === '/api/login' && req.method === 'POST') return this.login(req, res, body);
    if (p === '/api/logout' && req.method === 'POST') {
      const id = cookies(req).rpa_session; if (id) this.sessions.delete(id);
      return this.json(res, 200, { ok: true }, { 'Set-Cookie': 'rpa_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' });
    }
    if (p === '/api/stations/search') return this.json(res, 200, { stations: a.stations.search(url.searchParams.get('q'), 12), register: a.stations.status() });

    // Everything below needs to be allowed in.
    if (needAuth()) return;

    if (p === '/api/config' && req.method === 'GET') return this.json(res, 200, { config: a.config.redacted(), board: a.board });
    if (p === '/api/config' && (req.method === 'PUT' || req.method === 'POST')) return this.saveConfig(res, body);
    if (p === '/api/log') return this.json(res, 200, { lines: logm.recent(Number(url.searchParams.get('n')) || 200) });
    if (p === '/api/password' && req.method === 'POST') return this.setPassword(req, res, body);
    if (p === '/api/token/test' && req.method === 'POST') {
      const token = String(body.token || a.config.get().meganet.token || '').trim();
      if (!token) return this.json(res, 400, { error: 'no token to test' });
      const sample = [...a.devices.all()].find(s => s.state === 'running' && (s.kind === 'sdr' || s.type && s.type !== 'gps'));
      const payload = sample ? a.describe(sample, sample.kind === 'sdr' ? 'sdr' : sample.type, typeof sample.point === 'function' ? sample.point() : sample.point)
        : { point_id: 'rpi-' + a.state.data.hostId + '-test', name: a.baseName() + ' — token check', receiver: 'serial', detail: { app: 'RPi ALERT', check: true }, location_source: 'none' };
      try { return this.json(res, 200, await a.uplink.testToken(token, payload)); }
      catch (e) { return this.json(res, 200, { ok: false, error: 'Could not reach MegaNet: ' + e.message }); }
    }
    // Ask MegaNet for a token (0048): the answer is the request's status — its
    // code, and the link its QR code carries. Asking again while one waits
    // answers the one that waits.
    if (p === '/api/token/request' && req.method === 'POST') return this.json(res, 200, await a.tokenRequest.request());
    if (p === '/api/token/request/cancel' && req.method === 'POST') return this.json(res, 200, await a.tokenRequest.cancel());
    if (p === '/api/send-now' && req.method === 'POST') { a.uplink.sendNow(); return this.json(res, 200, { ok: true }); }
    if (p === '/api/stations/refresh' && req.method === 'POST') { a.stations.refresh(); return this.json(res, 200, { ok: true }); }
    if (p === '/api/devices/rescan' && req.method === 'POST') { a.devices.scan(); return this.json(res, 200, { ok: true }); }
    if (p === '/api/devices/restart' && req.method === 'POST') {
      const s = a.devices.all().find(x => x.key === body.key);
      if (!s) return this.json(res, 404, { error: 'no such device' });
      if (s.state === 'unplugged') return this.json(res, 409, { error: s.name() + ' is not plugged in' });
      await s.restart();
      return this.json(res, 200, { ok: true });
    }
    // Remove a receiver that is not plugged in: the agent forgets it.
    if (p === '/api/devices/forget' && req.method === 'POST') {
      const r = a.devices.forget(String(body.key || ''));
      return this.json(res, r.ok ? 200 : r.status, r.ok ? { ok: true, name: r.name } : { error: r.error });
    }
    if (p === '/api/audio/test' && req.method === 'POST') { a.audio.test(body.kind); return this.json(res, 200, { ok: true }); }
    if (p === '/api/audio/devices') return this.json(res, 200, { devices: await audioDevices() });
    if (p === '/api/network' && req.method === 'GET') {
      const r = await system.priv('net-status');
      return this.json(res, 200, { ok: r.code === 0, text: r.stdout, error: r.code ? r.stderr.trim() : null, addresses: system.addresses() });
    }
    if (p === '/api/network/wifi' && req.method === 'GET') {
      const r = await system.priv('wifi-scan');
      return this.json(res, 200, { ok: r.code === 0, networks: parseWifi(r.stdout), error: r.code ? r.stderr.trim() : null });
    }
    if (p === '/api/network/wifi' && req.method === 'POST') {
      const ssid = String(body.ssid || ''), pw = String(body.password || '');
      if (!ssid || ssid.length > 32) return this.json(res, 400, { error: 'a network name (SSID) of 1–32 characters' });
      if (pw && (pw.length < 8 || pw.length > 63)) return this.json(res, 400, { error: 'a Wi-Fi password is 8–63 characters' });
      const r = await system.priv('wifi-connect', ssid, pw);
      return this.json(res, 200, { ok: r.code === 0, message: (r.stdout || r.stderr).trim().slice(0, 300) });
    }
    if (p === '/api/system/hostname' && req.method === 'POST') {
      const h = String(body.hostname || '');
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(h)) return this.json(res, 400, { error: 'lower-case letters, digits and dashes' });
      const r = await system.priv('hostname', h);
      return this.json(res, 200, { ok: r.code === 0, message: (r.stdout || r.stderr).trim() });
    }
    if (p === '/api/system/power' && req.method === 'POST') {
      if (!['reboot', 'poweroff', 'restart-agent'].includes(body.action)) return this.json(res, 400, { error: 'reboot, poweroff or restart-agent' });
      this.log.warn(body.action + ' requested from the web page');
      setTimeout(() => system.priv(body.action), 500);
      return this.json(res, 200, { ok: true });
    }
    // Over-the-air updates. GET: the nightly timer and the last install's outcome.
    if (p === '/api/system/update' && req.method === 'GET') return this.json(res, 200, await updateStatus());
    if (p === '/api/system/update' && req.method === 'POST') {
      const r = await system.priv('update-check');
      return this.json(res, 200, { ok: r.code === 0, message: (r.stdout || r.stderr).trim().slice(0, 2000), version: require('../../package.json').version });
    }
    if (p === '/api/system/update/install' && req.method === 'POST') {
      this.log.warn('software update install requested from the web page');
      const r = await system.priv('update-install');
      return this.json(res, r.code === 0 ? 200 : 500, r.code === 0 ? { ok: true } : { error: (r.stderr || r.stdout).trim().slice(0, 300) || 'could not start the update' });
    }
    if (p === '/api/system/update/auto' && req.method === 'POST') {
      const on = !!body.on;
      const r = await system.priv('update-auto', on ? 'on' : 'off');
      if (r.code !== 0) return this.json(res, 500, { error: (r.stderr || r.stdout).trim().slice(0, 300) || 'could not change automatic updates' });
      this.log.info('automatic updates ' + (on ? 'on' : 'off'));
      return this.json(res, 200, await updateStatus());
    }
    return this.json(res, 404, { error: 'no such API' });
  }

  async saveConfig(res, body) {
    const patch = body && body.config;
    if (!patch || typeof patch !== 'object') return this.json(res, 400, { error: 'send {config: {…}}' });
    // A masked token coming back from the form is "unchanged", not a new token.
    if (patch.meganet && typeof patch.meganet.token === 'string') {
      const t = patch.meganet.token.trim();
      if (!t || t.includes('…')) delete patch.meganet.token; else patch.meganet.token = t;
      if (body.clearToken) patch.meganet.token = '';
    }
    if (patch.web) delete patch.web.passwordHash;
    const r = this.agent.config.update(patch);
    if (!r.ok) return this.json(res, 400, { error: 'Not saved: ' + r.errors.join('; '), errors: r.errors });
    return this.json(res, 200, { ok: true, changed: r.changed, config: this.agent.config.redacted() });
  }

  async setPassword(req, res, body) {
    const cfg = this.agent.config;
    const pw = String(body.password || '');
    if (body.remove) {
      if (!isLocal(req)) return this.json(res, 403, { error: 'the password can only be removed from the Pi itself (its screen, or rpi-alert over SSH)' });
      cfg.update({ web: { passwordHash: '' } });
      this.sessions.clear();
      return this.json(res, 200, { ok: true });
    }
    if (pw.length < 6) return this.json(res, 400, { error: 'at least 6 characters' });
    cfg.update({ web: { passwordHash: hashPassword(pw) } });
    this.sessions.clear();
    const id = crypto.randomBytes(24).toString('hex');
    this.sessions.set(id, Date.now() + SESSION_MS);
    return this.json(res, 200, { ok: true }, { 'Set-Cookie': 'rpa_session=' + id + '; Path=/; Max-Age=' + SESSION_MS / 1000 + '; HttpOnly; SameSite=Strict' });
  }

  login(req, res, body) {
    const ip = req.socket.remoteAddress || '?';
    const f = this.fails.get(ip);
    if (f && f.until > Date.now()) return this.json(res, 429, { error: 'too many tries — wait ' + Math.ceil((f.until - Date.now()) / 1000) + ' s' });
    const hash = this.agent.config.get().web.passwordHash;
    if (!hash || !checkPassword(String(body.password || ''), hash)) {
      const n = (f ? f.n : 0) + 1;
      this.fails.set(ip, { n, until: n >= 5 ? Date.now() + 30000 * (n - 4) : 0 });
      return this.json(res, 401, { error: 'wrong password' });
    }
    this.fails.delete(ip);
    const id = crypto.randomBytes(24).toString('hex');
    this.sessions.set(id, Date.now() + SESSION_MS);
    return this.json(res, 200, { ok: true }, { 'Set-Cookie': 'rpa_session=' + id + '; Path=/; Max-Age=' + SESSION_MS / 1000 + '; HttpOnly; SameSite=Strict' });
  }

  sse(req, res, authed) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    res.authed = authed;
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  static(p, res) {
    let rel = decodeURIComponent(p);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(STATIC, rel));
    if (!file.startsWith(STATIC + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) {
        // A page route the single-page app owns.
        if (!path.extname(rel)) return this.static('/index.html', res);
        res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
      res.end(data);
    });
  }
}

// Where a receiver is can be somebody's house: not for strangers once a password is set.
function redactPlace(s) {
  if (s.location) { delete s.location.lat; delete s.location.lon; delete s.location.accuracy_m; delete s.location.station; }
  for (const p of (s.devices && s.devices.ports) || []) if (p.detail && p.detail.fix) p.detail.fix = p.detail.fix ? { hidden: true } : null;
  if (s.system) { delete s.system.addresses; }
}

function audioDevices() {
  return new Promise((resolve) => {
    execFile('aplay', ['-l'], { timeout: 5000 }, (err, out) => {
      const list = [{ id: 'default', label: 'System default' }];
      if (!err) {
        for (const m of String(out).matchAll(/^card (\d+): (\S+) \[([^\]]+)\], device (\d+): [^\[]*\[([^\]]+)\]/gm)) {
          list.push({ id: 'plughw:CARD=' + m[2] + ',DEV=' + m[4], label: m[3] + ' — ' + m[5] });
        }
      }
      resolve(list);
    });
  });
}

// rpi-alert-priv update-status: the timer's state, whether an install is running,
// then the last outcome (update-status.json, written by rpi-alert-update).
async function updateStatus() {
  const r = await system.priv('update-status');
  if (r.code !== 0) return { available: false, error: (r.stderr || '').trim().slice(0, 300) || 'not available on this machine' };
  const [timer = '', running = '', ...rest] = r.stdout.split('\n');
  let last = null;
  try { last = JSON.parse(rest.join('\n')); } catch (_) {}
  return { available: true, auto: timer.trim() === 'enabled', running: running.trim() === 'running', last: last && last.state ? last : null };
}

function parseWifi(text) {
  const seen = new Map();
  for (const line of String(text || '').split('\n')) {
    // nmcli -t escapes ':' inside fields as '\:'
    const f = line.split(/(?<!\\):/).map(x => x.replace(/\\:/g, ':'));
    if (f.length < 4 || !f[1]) continue;
    const net = { inUse: f[0] === '*', ssid: f[1], signal: Number(f[2]) || 0, security: f[3] || '' };
    const prev = seen.get(net.ssid);
    if (!prev || net.signal > prev.signal || net.inUse) seen.set(net.ssid, Object.assign(net, { inUse: net.inUse || (prev && prev.inUse) }));
  }
  return [...seen.values()].sort((a, b) => b.signal - a.signal);
}

module.exports = { WebServer, isLocal, parseWifi };
