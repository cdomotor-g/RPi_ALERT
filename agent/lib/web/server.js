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
//
// On a managed network (0.24; each as before until set, and set on this
// machine only): web.bind — the address it listens on; web.hosts — more names
// it answers to; web.behindProxy — a reverse proxy on this machine publishes
// it, so "from this machine" no longer means "this Pi itself"; and
// web.requireLogin "all" — nothing is read without a login. Every login
// attempt is logged with the caller's address.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const logm = require('../log');
const { hashPassword, checkPassword, ALERT_CHANNELS_HZ } = require('../config');
const { NEAR_KM } = require('../stations');
const webpw = require('../web-password');
const system = require('../system');

const STATIC = path.join(__dirname, '..', '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const SESSION_MS = 7 * 24 * 3600 * 1000;

// ── who is asking ───────────────────────────────────────────────────────────

// This machine's own address, as a caller's: IPv4, IPv6, and IPv4 arriving on
// an IPv6 socket.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function fromLoopback(req) { return LOOPBACK.has((req.socket && req.socket.remoteAddress) || ''); }

// The headers a reverse proxy adds to say whom it is asking for. Nothing on
// this machine sends one — not the rpi-alert command, not the screen's browser.
const FORWARDED = /^(forwarded|via|x-forwarded.*|x-original-forwarded-for|x-real-ip|x-client-ip|x-cluster-client-ip|true-client-ip|cf-connecting-ip)$/i;
// Is one there? By name alone, as the caller spelt it: Node drops a repeat of
// some headers and reads an empty one as none, so its tidied list is not asked.
function forwarded(req) {
  const raw = req.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) if (FORWARDED.test(raw[i])) return true;
  return Object.keys(req.headers || {}).some(k => FORWARDED.test(k));
}

// A Host header, as the name alone: no port, no brackets, lower case.
function hostName(raw) {
  return String(raw || '').trim().replace(/:\d+$/, '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}
const thisMachine = (h) => h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
// The names this machine's own callers ask for it by: the rpi-alert command
// asks 127.0.0.1, the screen's browser localhost — once, and only once. And
// what a browser says of the page that sent it (Origin, Referer): the
// screen's page is this machine's too; the page of a browser on the far side
// of a proxy has the proxy's name.
function asksThisMachine(req) {
  const raw = req.rawHeaders || [];
  let hosts = 0;
  for (let i = 0; i < raw.length; i += 2) if (/^host$/i.test(raw[i])) hosts++;
  if (hosts > 1 || !thisMachine(hostName(req.headers.host))) return false;
  for (const h of ['origin', 'referer']) {
    if (req.headers[h] === undefined) continue;
    let page;
    try { page = new URL(req.headers[h]).hostname; } catch (_) { return false; }
    if (!thisMachine(page.toLowerCase().replace(/^\[/, '').replace(/\]$/, ''))) return false;
  }
  return true;
}

// More header lines than this machine's own callers ever send (the rpi-alert
// command about seven, the screen's browser about twenty). Node 18 and 20 keep
// only the first thousand or so of a request and drop the rest unsaid, so a
// caller who sends that many first could push the header a proxy adds after
// them out of sight. The web server keeps them all (maxHeadersCount, in
// start()); and whatever Node does, a request with this many is no caller of
// this machine's own.
const MAX_OWN_HEADERS = 64;
const headerLines = (req) => Math.floor((req.rawHeaders || []).length / 2);

// Is this the Pi itself — its screen, or the rpi-alert command?
//
// As before 0.24: a caller from this machine's own address, with no
// X-Forwarded-For — and, either way, with no more header lines than this
// machine's own callers send (MAX_OWN_HEADERS).
//
// Behind a reverse proxy on this machine (web.behindProxy) every outside
// caller comes from that address too, so more is asked. A request is the
// machine's own only if it carries none of the headers a proxy adds — under
// any spelling, repeated or empty; if its connection has never carried one
// (a proxy sends many callers down one connection, and a request hidden in
// another's body rides behind it); if it asks for this machine by its own
// name, as the command and the screen do, and a browser on the far side of a
// proxy does not; and if it is not in HTTP/1.0, which nothing on this machine
// speaks and nginx, left as it comes, does.
//
// That is as far as the agent can see. A proxy that adds none of its headers
// and asks for 127.0.0.1 by name in HTTP/1.1 sends what the rpi-alert command
// sends, and whoever is behind it can make it send that: the proxy has to do
// its part, and docs/configuration.md says what that is and how to check it.
function isLocal(req, web) {
  if (!fromLoopback(req) || headerLines(req) > MAX_OWN_HEADERS) return false;
  if (!(web && web.behindProxy)) return !req.headers['x-forwarded-for'];
  if ((req.socket && req.socket.rpaProxy) || forwarded(req)) return false;
  if (req.httpVersion === '1.0') return false;
  return asksThisMachine(req);
}

// A caller's address without the IPv6 wrapping of an IPv4 one.
function plainAddress(a) {
  a = String(a || '');
  return a.startsWith('::ffff:') && net.isIPv4(a.slice(7)) ? a.slice(7) : a;
}

// The caller's address, for the log and the limits: the other end of the
// connection. Behind a proxy on this machine (web.behindProxy) that end is
// the proxy, so it is the last address in X-Forwarded-For — the one the proxy
// itself saw and added; anything before it is what the caller chose to send —
// and that header is believed only because the request came from this
// machine. Sent straight from the network, it is ignored.
function callerAddress(req, web) {
  const peer = plainAddress(req.socket && req.socket.remoteAddress) || '?';
  if (!(web && web.behindProxy) || !fromLoopback(req)) return peer;
  const xff = req.headers['x-forwarded-for'];
  if (xff === undefined) return peer;
  const last = String(xff).split(',').pop().trim();
  const m = /^\[([0-9a-f:.]+)\](?::\d+)?$/i.exec(last) || /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(last);
  const ip = plainAddress(m ? m[1] : last);
  return net.isIP(ip) ? ip : peer;
}

// Reject a Host the Pi is not known by, so a website the operator visits cannot
// rebind its own name to the Pi's address and then read the API as same-origin
// (DNS rebinding — security appraisal H-5). Legitimate access is by IP literal,
// a *.local name, localhost, or the Pi's hostname; a rebinding attack arrives
// with the attacker's own domain in Host, which none of those match. Reaching
// the Pi by a bare IP is not a rebinding vector (the attacker cannot serve their
// page from it), so IP literals are allowed.
//
// more (web.hosts, 0.24): names the Pi is also known by — the one a council's
// DNS gives it. Each is a name its owner chose on the Pi itself, which is what
// a rebinding attacker's domain can never be.
function hostAllowed(req, more) {
  const raw = String(req.headers.host || '');
  if (!raw) return true;
  let host = raw.replace(/:\d+$/, '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return true;  // IPv4/IPv6 literal
  if (host === require('node:os').hostname().toLowerCase()) return true;
  if (Array.isArray(more) && more.some(h => typeof h === 'string' && h.toLowerCase().replace(/\.$/, '') === host.replace(/\.$/, ''))) return true;
  return false;
}

// Live-event stream caps, so an unauthenticated visitor cannot hold every
// socket and starve a small Pi of memory and file descriptors (appraisal M-7).
const MAX_SSE = 24;
const MAX_SSE_PER_IP = 6;
// An address web.bind names that the machine does not have: asked for again this often.
const BIND_RETRY_MS = 30000;
// A proxy that seems not to say whom it forwards for: said in the log this often at most.
const PROXY_DOUBT_MS = 10 * 60 * 1000;
// Tries from a locked-out address are not checked, and are logged as a count this often.
const LOCKED_NOTE_MS = 60000;
// Wrong passwords are counted for this many addresses at most: past it, the
// one counted longest is forgotten, so made-up addresses cannot fill the memory.
const MAX_FAIL_ADDRESSES = 5000;
// From the fifth wrong password an address is locked out, 30 s longer each
// time — up to a quarter of an hour, and no longer (0.24: it grew for ever).
const LOCK_STEP_MS = 30000, LOCK_MAX_MS = 15 * 60 * 1000;
// An address's wrong passwords are forgotten after an hour with none from it
// and no lock on it (0.24: they were kept until the agent restarted).
const FAILS_FORGET_MS = 60 * 60 * 1000;
// A live stream is sent a line this often, so that nothing between closes it for being quiet.
const KEEP_ALIVE_MS = 25000;
// A live stream that was ended and has not taken the end — its reader has stopped reading — is closed after this long.
const END_GRACE_MS = 5000;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// A request that cannot be read is the caller's mistake, not the agent's: it
// is answered 400 and is no line in the log.
function badRequest(res, why) {
  res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(why || 'bad request');
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    // One that cannot be read ("%") is no cookie at all.
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) {}
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
    this.also = null;            // web.bind's own address, beside 127.0.0.1
    this.bindError = null;
    this.bindTimer = null;
    this.bindRetryMs = BIND_RETRY_MS;
    this.lockedNoteMs = LOCKED_NOTE_MS;
    this.maxFails = MAX_FAIL_ADDRESSES;
    this.keepAliveMs = KEEP_ALIVE_MS;
    this.endGraceMs = END_GRACE_MS;
    this.paces = new Map();      // kind → { more, who, timer }: see pace()
    this.proxyDoubtAt = 0;
    this.ownDoubtAt = 0;
    this.stopped = false;
  }

  // A web server that keeps every header line of a request, however many
  // (inside Node's own limit on their size, 16 KB): see MAX_OWN_HEADERS.
  serve(onRequest) {
    const s = http.createServer(onRequest);
    s.maxHeadersCount = 0;
    return s;
  }

  // A line now, and for the minute after it a count, said when the minute is
  // up: for what any caller can bring about as often as it likes, so that the
  // log cannot be filled with it and the lines that matter pushed out. who:
  // the caller's address, of which the count names the first few.
  pace(kind, first, rest, who) {
    const p = this.paces.get(kind);
    if (p) {
      p.more++;
      if (who && !p.who.includes(who)) { if (p.who.length < 4) p.who.push(who); else p.others = true; }
      return;
    }
    const q = { more: 0, who: [], others: false, timer: null };
    this.paces.set(kind, q);
    first();
    q.timer = setTimeout(() => {
      this.paces.delete(kind);
      if (q.more) rest(q.more, q.who.length ? ', from ' + q.who.join(', ') + (q.others ? ' and others' : '') : '');
    }, this.lockedNoteMs);
    q.timer.unref?.();
  }

  // A request the agent itself tripped over: answered 500, and logged — the
  // first in full, the rest of that minute as a count.
  failed(e) {
    this.lastFailure = String(e && e.message || e).slice(0, 200);
    this.pace('error', () => this.log.error(e && e.stack || e),
      (n) => this.log.error(n + ' more request' + (n === 1 ? '' : 's') + ' failed in the last minute — the last of them: ' + this.lastFailure));
  }

  start() {
    const web = this.agent.config.get().web;
    const want = web.port;
    // web.bind (0.24). Empty: every interface, as before. An address: this
    // machine's own 127.0.0.1 first — where the rpi-alert command and the
    // screen ask, whatever the address — then the address itself (alsoOn).
    const bind = web.bind || '';
    const listen = (port, cb) => (bind ? this.server.listen(port, '127.0.0.1', cb) : this.server.listen(port, cb));
    const onRequest = (req, res) => this.handle(req, res).catch(e => {
      this.failed(e);
      if (!res.headersSent) this.json(res, 500, { error: 'internal error: ' + e.message });
      else res.end();
    });
    this.server = this.serve(onRequest);
    this.server.on('error', (e) => {
      if ((e.code === 'EACCES' || e.code === 'EADDRINUSE') && this.port !== 8080 && want !== 8080) {
        this.log.warn('cannot listen on port ' + want + ' (' + e.code + ') — using 8080 instead');
        this.port = 8080;
        listen(8080);
      } else this.log.error('web server: ' + e.message);
    });
    this.port = want;
    listen(want, () => {
      const at = (h) => 'http://' + h + (this.port === 80 ? '' : ':' + this.port) + '/';
      if (!bind) return this.log.info('dashboard on ' + at(require('node:os').hostname() + '.local'));
      this.log.info('dashboard on ' + at('127.0.0.1') + ' — this machine' + (bind === '127.0.0.1' ? ' only' : ', and ' + bind) + ' (web.bind)');
      if (bind !== '127.0.0.1') this.alsoOn(onRequest, bind);
    });
    this.wire();
    if (web.behindProxy) this.proxyReminder();
    return this;
  }

  // With web.behindProxy on, what the agent cannot see for itself is whether
  // the proxy adds its header to every request. One that adds none sends, for
  // a caller who asks it for "localhost", what the rpi-alert command sends —
  // and that caller is let in as this machine itself. Said when the setting
  // is in force, with the one check that shows it.
  proxyReminder() {
    this.log.info('web.behindProxy is on: what a reverse proxy on this machine passes on is a visitor\'s, never this machine\'s own — as long as the proxy adds '
      + 'X-Forwarded-For to every request. Check it from another computer: curl -H \'Host: localhost\' http(s)://<the proxy>/api/config must answer "log in first", '
      + 'not the settings (docs/configuration.md)');
  }

  // As it comes (web.behindProxy off) every request from this machine's own
  // address without X-Forwarded-For is this machine itself, as before 0.24 —
  // one that asks for a name this machine does not go by, as a web page in a
  // browser on this machine does when its name has been pointed here (DNS
  // rebinding), and one a proxy passed on with another header than
  // X-Forwarded-For. Nothing is changed for them; it is said, now and then,
  // because web.behindProxy is what closes both.
  ownDoubt(req) {
    if (Date.now() - this.ownDoubtAt < PROXY_DOUBT_MS) return;
    this.ownDoubtAt = Date.now();
    this.log.warn('a request from this machine itself, ' + (forwarded(req) ? 'with a reverse proxy\'s header but no X-Forwarded-For' : 'asking for ' + JSON.stringify(hostName(req.headers.host).slice(0, 80)))
      + ', was taken for the base station itself, as every such request is while web.behindProxy is off. '
      + 'If a web browser or a reverse proxy runs on this machine, turn it on: rpi-alert config set web.behindProxy true (docs/configuration.md)');
  }

  // Behind a proxy, a request from this machine with none of a proxy's headers
  // that is not the command's or the screen's either — it asks for another
  // name, or a browser sent it from a page with another name: most likely the
  // proxy, not saying whom it forwards for. It is treated as a visitor; and it
  // is said, because a caller who asked for 127.0.0.1 by name through such a
  // proxy would be taken for this machine itself. Now and then, not each time:
  // anyone can send one.
  proxyDoubt(req) {
    if (Date.now() - this.proxyDoubtAt < PROXY_DOUBT_MS) return;
    this.proxyDoubtAt = Date.now();
    this.log.warn('a request from this machine itself, asking for ' + JSON.stringify(hostName(req.headers.host).slice(0, 80)) + ', carried none of a reverse proxy\'s headers. '
      + 'web.behindProxy is on: if it came through the proxy, the proxy is not adding X-Forwarded-For, and must on every route (docs/configuration.md). Treated as a visitor');
  }

  // The address web.bind names, beside 127.0.0.1. One the machine does not
  // have — yet (an address from DHCP comes after the agent starts) or ever (a
  // slip in the setting) — costs the network its dashboard and the agent
  // nothing: it goes on receiving and sending, with the dashboard on this
  // machine alone, says so, and asks for the address again every half minute.
  // Never the other way: an address that cannot be had is not a reason to
  // listen on every interface.
  alsoOn(onRequest, addr) {
    if (this.stopped) return;
    const s = this.serve(onRequest);
    const url = 'http://' + (addr.includes(':') ? '[' + addr + ']' : addr) + (this.port === 80 ? '' : ':' + this.port) + '/';
    s.on('error', (e) => {
      if (s.listening) return this.log.error('web server (' + addr + '): ' + e.message);
      const why = e.code || e.message;
      if (why !== this.bindError) {
        this.log.warn('cannot listen on ' + url + ' (' + why + (why === 'EADDRNOTAVAIL' ? ': this machine does not have that address' : '')
          + ') — the dashboard is on this machine only (127.0.0.1) until it can; asking again every ' + Math.round(this.bindRetryMs / 1000) + ' s (web.bind)');
      }
      this.bindError = why;
      this.bindTimer = setTimeout(() => this.alsoOn(onRequest, addr), this.bindRetryMs);
      this.bindTimer.unref?.();
    });
    s.listen(this.port, addr, () => {
      this.also = s;
      this.bindError = null;
      this.log.info('dashboard on ' + url + ' (web.bind)');
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.bindTimer);
    clearInterval(this.keepAlive);
    for (const p of this.paces.values()) clearTimeout(p.timer);
    for (const f of this.fails.values()) clearTimeout(f.timer);
    for (const c of this.clients) c.end();
    this.clients.clear();
    if (this.server) this.server.close();
    if (this.also) this.also.close();
  }

  // ── live events ─────────────────────────────────────────────────────────

  wire() {
    const a = this.agent;
    a.on('reading', (r) => this.broadcast('reading', r));
    a.on('token-request', (t) => this.broadcast('token-request', t));
    a.on('remote', () => this.broadcast('remote', {}));
    a.on('survey', () => this.broadcast('survey', {}));
    a.on('burst', (b) => this.broadcast('burst', b));
    a.on('burst-outcome', (o) => this.broadcast('burst-outcome', o));
    a.on('tick', () => this.broadcast('tick', { t: Date.now() }));
    let devTimer = null;
    a.on('devices', () => { if (!devTimer) devTimer = setTimeout(() => { devTimer = null; this.broadcast('devices', {}); }, 500); });
    logm.on((line) => this.broadcast('log', line, true));
    a.on('config', (changed) => {
      if ((changed || []).includes('web.requireLogin')) this.sweep();
      if ((changed || []).includes('web.behindProxy') && a.config.get().web.behindProxy) this.proxyReminder();
    });
    this.keepAlive = setInterval(() => { this.sweep(); for (const c of this.clients) this.send(c, ': keep-alive\n\n'); }, this.keepAliveMs);
    this.keepAlive.unref();
  }

  // With a login for everything (web.requireLogin "all") a live stream lasts
  // as long as the login it was opened with: logged out, a new password, or
  // seven days, and it ends. This machine's own are never ended.
  sweep() {
    if (this.agent.config.get().web.requireLogin !== 'all') return;
    for (const c of this.clients) if (!c._local && !(c._session && this.sessions.get(c._session) > Date.now())) this.drop(c);
  }

  // End a live stream. It is off the list before it is ended, so that nothing
  // more is written to it: a write after the end is an error nobody would be
  // listening for, and that stops the agent. One whose reader has stopped
  // reading never takes the end, and is closed shortly after.
  drop(c) {
    this.clients.delete(c);
    c.end();
    const t = setTimeout(() => c.destroy(), this.endGraceMs);
    t.unref?.();
    c.once('close', () => clearTimeout(t));
  }

  // A line to one live stream — never to one that has ended.
  send(c, msg) {
    if (c.writableEnded || c.destroyed) return this.clients.delete(c);
    c.write(msg);
  }

  broadcast(type, data, needAuth) {
    const msg = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const c of this.clients) if (!needAuth || c.authed) this.send(c, msg);
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  json(res, code, body, headers) {
    const s = JSON.stringify(body);
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
    res.end(s);
  }

  local(req) { return isLocal(req, this.agent.config.get().web); }

  authed(req) {
    const web = this.agent.config.get().web;
    if (isLocal(req, web)) return true;
    // No password: anyone, as at first-time set-up — unless everything needs
    // a login (web.requireLogin "all"): then there is none to give, and only
    // this machine itself is let in.
    if (!web.passwordHash) return web.requireLogin !== 'all';
    return !!this.session(req);
  }

  // The caller's login, while it lasts: its id, or null.
  session(req) {
    const id = cookies(req).rpa_session;
    const exp = id && this.sessions.get(id);
    if (exp && exp > Date.now()) return id;
    if (exp) this.sessions.delete(id);
    return null;
  }

  // A new login, and the cookie that carries it. Behind a proxy that says the
  // caller came over HTTPS (X-Forwarded-Proto), the cookie is for HTTPS only.
  newSession(req) {
    const web = this.agent.config.get().web;
    const id = crypto.randomBytes(24).toString('hex');
    this.sessions.set(id, Date.now() + SESSION_MS);
    const https = web.behindProxy && fromLoopback(req) && /^https$/i.test(String(req.headers['x-forwarded-proto'] || '').split(',').pop().trim());
    return 'rpa_session=' + id + '; Path=/; Max-Age=' + SESSION_MS / 1000 + '; HttpOnly; SameSite=Strict' + (https ? '; Secure' : '');
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
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (_) { return badRequest(res); }
    const p = url.pathname;
    const a = this.agent;
    const web = a.config.get().web;
    // A connection that has carried one forwarded request is the proxy's for
    // good: nothing that follows on it is this machine's own (isLocal).
    if (web.behindProxy && forwarded(req)) req.socket.rpaProxy = true;
    const local = isLocal(req, web);
    if (web.behindProxy && !local && fromLoopback(req) && !req.socket.rpaProxy) this.proxyDoubt(req);
    if (!web.behindProxy && local && (forwarded(req) || !hostAllowed(req, web.hosts))) this.ownDoubt(req);
    // A login attempt refused before its password is looked at is on record too.
    const login = p === '/api/login' && req.method === 'POST';
    // DNS-rebinding guard (H-5). Local requests (the kiosk, the CLI) are exempt.
    if (!local && !hostAllowed(req, web.hosts)) {
      if (login) this.loginUnread(req, 'unrecognised Host header');
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('unrecognised Host header');
    }
    if (!p.startsWith('/api/')) return this.static(p, res);
    const authed = this.authed(req);
    const mutate = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutate && !this.sameOrigin(req)) {
      if (login) this.loginUnread(req, 'cross-site request');
      return this.json(res, 403, { error: 'cross-site request refused' });
    }
    const all = web.requireLogin === 'all';
    const needAuth = () => { if (authed) return false; this.json(res, 401, Object.assign({ error: 'log in first', login: true }, all ? { all: true } : {})); return true; };
    let body = {};
    if (mutate) {
      try { body = await this.body(req); } catch (e) {
        if (login) this.loginUnread(req, 'a request that could not be read (' + e.message + ')');
        return this.json(res, e.status || 400, { error: e.message });
      }
    }

    if (login) return this.login(req, res, body);
    // Anything else sent is a set of named values: null, a list or a bare
    // value is the caller's mistake.
    if (!isObj(body)) return this.json(res, 400, { error: 'send a JSON object' });
    if (p === '/api/logout' && req.method === 'POST') {
      const id = cookies(req).rpa_session; if (id) this.sessions.delete(id);
      this.sweep();
      return this.json(res, 200, { ok: true }, { 'Set-Cookie': 'rpa_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' });
    }
    // web.requireLogin "all" (0.24): nothing is read without a login — not the
    // status, the readings, the graphs, the live stream or the station search
    // just below, which answer anyone otherwise. (The page itself is no
    // secret: it is the same in every copy of RPi ALERT, and holds no data.)
    if (all && needAuth()) return;

    if (p === '/api/status' && req.method === 'GET') {
      const s = await a.status();
      s.auth = { authed, local, passwordSet: !!web.passwordHash };
      if (all) s.auth.all = true;   // for the page: when its live stream is refused, the login has ended
      // The auto-generated password is shown only to a local caller — the kiosk
      // screen or the CLI over the loopback — never over the network (H-4).
      if (local) { const pw = webpw.initial(a.config); if (pw) s.auth.initialPassword = pw; }
      if (!authed) redactPlace(s);
      return this.json(res, 200, s);
    }
    if (p === '/api/readings') {
      const n = Math.min(500, Number(url.searchParams.get('limit')) || 200);
      // The bursts of the last half hour: the dashboard's live charts.
      const since = Date.now() - 30 * 60 * 1000;
      return this.json(res, 200, { readings: a.recent.slice(0, n), bursts: a.bursts.filter(b => b.t >= since) });
    }
    if (p === '/api/history' && req.method === 'GET') return this.json(res, 200, a.history.get(url.searchParams.get('since')));
    if (p === '/api/events') return this.sse(req, res, authed);
    if (p === '/api/stations/search') return this.json(res, 200, { stations: a.stations.search(url.searchParams.get('q'), 12), register: a.stations.status() });

    // Everything below needs to be allowed in.
    if (needAuth()) return;

    if (p === '/api/config' && req.method === 'GET') return this.json(res, 200, { config: a.config.redacted(), board: a.board });
    // The channels to offer a stick: the frequencies MegaNet's stations use,
    // those near this receiver first; and MegaNet's four, should the station
    // register not have come yet.
    if (p === '/api/sdr/frequencies' && req.method === 'GET') {
      return this.json(res, 200, { frequencies: a.stations.frequencies(a.location()), register: a.stations.status(), standard: ALERT_CHANNELS_HZ, nearKm: NEAR_KM });
    }
    if (p === '/api/config' && (req.method === 'PUT' || req.method === 'POST')) return this.saveConfig(req, res, body);
    if (p === '/api/log') return this.json(res, 200, { lines: logm.recent(Number(url.searchParams.get('n')) || 200) });
    // Bursts kept as IQ (lib/recorder.js): the list, one file to download, and deleting them.
    if (p === '/api/recordings' && req.method === 'GET') return this.json(res, 200, { recordings: a.recorder.status(), files: a.recorder.list(500) });
    if (p === '/api/recordings/delete' && req.method === 'POST') {
      const n = body.all === true ? a.recorder.clear() : a.recorder.remove(Array.isArray(body.names) ? body.names.slice(0, 1000) : []);
      return this.json(res, 200, { ok: true, removed: n });
    }
    if (p.startsWith('/api/recordings/') && req.method === 'GET') {
      const name = p.slice('/api/recordings/'.length);
      const f = a.recorder.file(name);
      if (!f) return this.json(res, 404, { error: 'no such recording' });
      return fs.stat(f.path, (err, st) => {
        if (err) return this.json(res, 404, { error: 'no such recording' });
        res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'attachment; filename="' + name + '"' });
        fs.createReadStream(f.path).pipe(res);
      });
    }
    if (p === '/api/password' && req.method === 'POST') return this.setPassword(req, res, body);
    if (p === '/api/token/test' && req.method === 'POST') {
      const token = String(body.token || a.config.get().meganet.token || '').trim();
      if (!token) return this.json(res, 400, { error: 'no token to test' });
      const found = [...a.devices.all()].find(s => s.state === 'running' && (s.kind === 'sdr' || s.type && s.type !== 'gps'));
      // A stick is a receiver per channel: its first.
      const sample = found && found.kind === 'sdr' ? found.channels[0] : found;
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
    if (p === '/api/hotspot' && req.method === 'GET') return this.json(res, 200, a.hotspot.status(true));
    if (p === '/api/survey' && req.method === 'GET') return this.json(res, 200, await a.survey.status());
    if (p === '/api/survey' && req.method === 'POST') {
      try {
        if (body.action === 'end') a.survey.end('ended from the dashboard');
        else if (body.action === 'start') a.survey.open({ name: body.name, hours: body.hours, readings: !!body.readings }, body.when === 'boot' ? 'boot' : 'now');
        else return this.json(res, 400, { error: 'action: start or end' });
      } catch (e) { return this.json(res, e.status || 500, { error: e.message }); }
      return this.json(res, 200, await a.survey.status());
    }
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
    // MegaNet's Base Stations tab (lib/remote.js): how it is going, and how much
    // MegaNet may do — set here, on the Pi, and never from MegaNet.
    if (p === '/api/remote' && req.method === 'GET') return this.json(res, 200, a.remote.statusForPage());
    if (p === '/api/remote' && req.method === 'POST') {
      const patch = {};
      if (body.mode !== undefined) patch.mode = body.mode;
      if (body.idleS !== undefined) patch.idleS = Number(body.idleS);
      const r = a.config.update({ remote: patch });
      if (!r.ok) return this.json(res, 400, { error: 'Not saved: ' + r.errors.join('; ') });
      if (r.changed.length) this.log.info('remote management: ' + r.changed.map(k => k + ' ' + JSON.stringify(a.config.get().remote[k.split('.')[1]])).join(', '));
      return this.json(res, 200, a.remote.statusForPage());
    }
    // SSH access (lib/access.js, through rpi-alert-priv): who may log in, and the
    // few settings the web page may change. No key is ever added here — the SD
    // card or `sudo rpi-alert access add-key` does that — so the web password
    // is never a way to a shell.
    if (p === '/api/access' && req.method === 'GET') return this.json(res, 200, await system.accessStatus());
    if (p === '/api/access' && req.method === 'POST') {
      let r;
      if (body.sync) r = await system.priv('access-sync');
      else {
        const what = String(body.set || ''), value = String(body.value || '');
        const ok = { meganet: ['on', 'off'], from: ['private', 'any'], password: ['on', 'off', 'unchanged'], ssh: ['on', 'off'] };
        if (!ok[what] || !ok[what].includes(value)) return this.json(res, 400, { error: 'set meganet on|off, from private|any, password on|off|unchanged, or ssh on|off' });
        this.log.warn('SSH access: ' + what + ' ' + value + ' (from the web page)');
        r = await system.priv('access-set', what, value);
      }
      if (r.code !== 0) return this.json(res, r.missing ? 501 : 400, { error: (r.stderr || r.stdout).trim().slice(0, 400) || 'not changed' });
      // MegaNet sees the change at the next check-in.
      a.remote.slowAt = 0; a.remote.wantFull = true;
      return this.json(res, 200, await system.accessStatus());
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

  async saveConfig(req, res, body) {
    const patch = body && body.config;
    if (!patch || typeof patch !== 'object') return this.json(res, 400, { error: 'send {config: {…}}' });
    // Where readings go — the endpoints and the publishable key — can only be
    // changed from the Pi itself. Repointing them would send the ingest token to
    // a chosen host, so the network must not be able to do it even once signed
    // in (security appraisal H-4). Only an actual change is refused; a form
    // echoing the current values saves as before.
    const local = this.local(req);
    if (patch.meganet && !local) {
      const cur = this.agent.config.get().meganet;
      const changes = (k) => k in patch.meganet && JSON.stringify(patch.meganet[k]) !== JSON.stringify(cur[k]);
      if (changes('endpoints') || changes('apikey')) {
        return this.json(res, 403, { error: 'where readings go (endpoints/apikey) can only be changed from the Pi itself — its screen, or rpi-alert over SSH' });
      }
    }
    // A masked token coming back from the form is "unchanged", not a new token.
    if (patch.meganet && typeof patch.meganet.token === 'string') {
      const t = patch.meganet.token.trim();
      if (!t || t.includes('…')) delete patch.meganet.token; else patch.meganet.token = t;
      if (body.clearToken) patch.meganet.token = '';
    }
    // Where the dashboard listens, the names it answers to, the proxy in front
    // of it and whether looking needs a login (0.24) are this machine's to
    // say, like the endpoints: a login from the network must not be a way to
    // open what its owner closed. Only an actual change is refused.
    if (patch.web && typeof patch.web === 'object' && !local) {
      const cur = this.agent.config.get().web;
      const k = ['bind', 'hosts', 'behindProxy', 'requireLogin'].find(x => x in patch.web && JSON.stringify(patch.web[x]) !== JSON.stringify(cur[x]));
      if (k) {
        return this.json(res, 403, { error: 'web.' + k + ' can only be changed on the base station itself — rpi-alert config set over SSH, or its settings file' });
      }
    }
    if (patch.web) delete patch.web.passwordHash;
    const r = this.agent.config.update(patch);
    if (!r.ok) return this.json(res, 400, { error: 'Not saved: ' + r.errors.join('; '), errors: r.errors });
    return this.json(res, 200, { ok: true, changed: r.changed, config: this.agent.config.redacted() });
  }

  // A new password, or (on this machine only) none. Who is let in changes
  // with it, so it is on record like a login (0.24): from which address, and
  // the login handed out with the new password.
  async setPassword(req, res, body) {
    const cfg = this.agent.config;
    const pw = typeof body.password === 'string' ? body.password : '';
    const from = this.whoAsks(req).from;
    if (body.remove) {
      if (!this.local(req)) return this.json(res, 403, { error: 'the password can only be removed from the Pi itself (its screen, or rpi-alert over SSH)' });
      cfg.update({ web: { passwordHash: '' } });
      webpw.forget();
      this.sessions.clear();
      this.sweep();
      this.log.warn('password removed from ' + from);
      return this.json(res, 200, { ok: true });
    }
    if (pw.length < 6) return this.json(res, 400, { error: 'at least 6 characters' });
    cfg.update({ web: { passwordHash: hashPassword(pw) } });
    webpw.forget();   // a human chose this one; the auto-generated plaintext is no longer in force
    this.sessions.clear();
    this.sweep();
    this.log.warn('password changed from ' + from);
    this.log.warn('login accepted from ' + from + ' (new password)');
    return this.json(res, 200, { ok: true }, { 'Set-Cookie': this.newSession(req) });
  }

  // The caller as the log names it: its address, and whether a proxy passed
  // it on.
  whoAsks(req) {
    const web = this.agent.config.get().web;
    const ip = callerAddress(req, web);
    return { ip, from: ip + (web.behindProxy && fromLoopback(req) && forwarded(req) ? ' (through the proxy)' : '') };
  }

  // A login attempt refused before its password was looked at — it asked for
  // a name this base station does not go by, came from another site's page,
  // or could not be read. On record like the others, and paced like the tries
  // of a locked-out address: anyone can send them.
  loginUnread(req, why) {
    const { ip, from } = this.whoAsks(req);
    this.pace('login: ' + why.replace(/ \(.*$/, ''), () => this.log.warn('login refused from ' + from + ': ' + why + ' — the password was not looked at'),
      (n, who) => this.log.warn('login refused: ' + n + ' more ' + (n === 1 ? 'try' : 'tries') + ' in the last minute with ' + why.replace(/ \(.*$/, '') + who + ' — not looked at'), ip);
  }

  // Logging in. Wrong passwords are counted for each address: the first four
  // cost nothing; from the fifth, each locks that address out for 30 s longer
  // than the one before (30 s, 60 s, 90 s, …), up to a quarter of an hour,
  // until a right password from it, an hour with no wrong one from it and no
  // lock on it, or a restart of the agent. A locked-out address's tries are
  // not checked at all — the right password is refused too. There is no limit
  // across addresses: somebody with many addresses gets four tries from each.
  // The counts are in memory, for the 5000 addresses counted most recently.
  //
  // Every attempt is logged (0.24) — accepted or refused, with the caller's
  // address, never anything that was typed — at the level of the other things
  // asked of the web page that matter to its owner (a reboot, SSH access).
  // Tries from a locked-out address would let anyone fill the log, so the
  // first of them is a line and the rest a count, once a minute.
  login(req, res, body) {
    const web = this.agent.config.get().web;
    const { ip, from } = this.whoAsks(req);
    let f = this.fails.get(ip);
    if (f && Date.now() - Math.max(f.at || 0, f.until) > FAILS_FORGET_MS) {
      clearTimeout(f.timer);
      this.fails.delete(ip);
      f = undefined;
    }
    if (f && f.until > Date.now()) {
      const wait = Math.ceil((f.until - Date.now()) / 1000);
      f.more = (f.more || 0) + 1;
      if (!f.timer) {
        this.log.warn('login refused from ' + from + ': locked out for another ' + wait + ' s after ' + f.n + ' wrong passwords — not checked');
        f.more = 0;
        f.timer = setTimeout(() => {
          f.timer = null;
          if (f.more) this.log.warn('login refused from ' + from + ': ' + f.more + ' more ' + (f.more === 1 ? 'try' : 'tries') + ' while locked out — not checked');
          f.more = 0;
        }, this.lockedNoteMs);
        f.timer.unref?.();
      }
      return this.json(res, 429, { error: 'too many tries — wait ' + wait + ' s' });
    }
    const hash = web.passwordHash;
    // What was sent as the password: text. Anything else — no body to speak
    // of, a number, a list — is a wrong password, counted and logged as one.
    const typed = isObj(body) && typeof body.password === 'string' ? body.password : null;
    if (!hash || typed === null || !checkPassword(typed, hash)) {
      const n = (f ? f.n : 0) + 1;
      const lock = n >= 5 ? Math.min(LOCK_STEP_MS * (n - 4), LOCK_MAX_MS) : 0;
      if (!f && this.fails.size >= this.maxFails) {
        const [oldest, o] = this.fails.entries().next().value;
        clearTimeout(o.timer);
        this.fails.delete(oldest);
      }
      this.fails.set(ip, Object.assign(f || {}, { n, at: Date.now(), until: lock ? Date.now() + lock : 0 }));
      this.log.warn('login refused from ' + from + ': ' + (hash ? 'wrong password' : 'no password is set') + ' (' + n + ' in a row'
        + (lock ? '; locked out for ' + lock / 1000 + ' s' : '') + ')');
      return this.json(res, 401, { error: 'wrong password' });
    }
    if (f) clearTimeout(f.timer);
    this.fails.delete(ip);
    this.log.warn('login accepted from ' + from);
    return this.json(res, 200, { ok: true }, { 'Set-Cookie': this.newSession(req) });
  }

  sse(req, res, authed) {
    // Bounded so a flood of connections cannot exhaust the Pi (M-7). Local
    // clients (the kiosk) are never refused.
    const web = this.agent.config.get().web;
    const local = isLocal(req, web);
    const ip = callerAddress(req, web);
    if (!local) {
      let perIp = 0;
      for (const c of this.clients) if (c._ip === ip) perIp++;
      if (this.clients.size >= MAX_SSE || perIp >= MAX_SSE_PER_IP) {
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '30' });
        return res.end('too many live connections');
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    res.authed = authed;
    res._ip = ip;
    res._local = local;
    res._session = local ? null : this.session(req);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
    // Whatever goes wrong on one stream ends that stream, and nothing else.
    res.on('error', () => this.clients.delete(res));
  }

  static(p, res) {
    let rel;
    try { rel = decodeURIComponent(p); } catch (_) { return badRequest(res); }
    if (rel.includes('\0')) return badRequest(res);
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

const updateStatus = system.updateStatus;

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

module.exports = { WebServer, isLocal, hostAllowed, forwarded, callerAddress, parseWifi };
