'use strict';
// MegaNet's three doors for a base station, all token-checked in the database
// (cdomotor-g/MegaNet docs/ingest-http.md, docs/ingest-serial-monitor.md):
//
//   ingest_http(payload)          readings — deduplicated on address + time + raw value
//   report_ingest_point(payload)  what and where each receiver is (0045)
//   report_receptions(payload)    every frame heard, good or bad, with signal (0047)
//
// Each is a PostgREST RPC: POST <endpoint>/rpc/<name>, body {"payload": …},
// headers apikey (the public project key), X-Ingest-Token (the secret),
// Content-Profile: meganet. Not Authorization: Bearer — Supabase's gateway
// reads that as a login and refuses the token before the database sees it.
//
// Two endpoints, tried in order and remembered once one works: the
// floodwarning.net proxy (a network that blocks *.supabase.co — the Bureau's
// does — still reaches it) and the Supabase project directly.

const TIMEOUT_MS = 20000;
// A request that neither answers nor fails by then is given up on from the
// outside, so one stuck connection can never leave the queue waiting for ever.
const HARD_MS = TIMEOUT_MS + 5000;
const REACH_MS = 8000;

function deadline(p, ms) {
  let t;
  const late = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}

class MegaNet {
  constructor(getCfg, log) {
    this.getCfg = getCfg;      // () => config.meganet
    this.log = log;
    this.good = 0;             // index of the endpoint that last worked
    this.lastEndpoint = null;
    // Whether MegaNet can be reached at all, for lib/keeper.js: when any door
    // last answered (any HTTP answer, a refusal included — the network path is
    // there), and since when none has (null: reached, or nothing tried yet).
    this.lastAnswerAt = null;
    this.unreachableSince = null;
    this.lastFailure = '';
    this.fetch = (url, init) => fetch(url, init);   // tests put their own here
  }

  answered() { this.lastAnswerAt = Date.now(); this.unreachableSince = null; this.lastFailure = ''; }
  unanswered(why) { if (this.unreachableSince == null) this.unreachableSince = Date.now(); this.lastFailure = String(why || '').slice(0, 200); }

  // Is any door answering? A small request that changes nothing, for the
  // keeper to ask while the queue is backing off. → true on any HTTP answer.
  async reach() {
    let why = 'no MegaNet endpoint configured';
    for (const ep of this.endpoints()) {
      try {
        const res = await deadline(this.fetch(ep.url + '/', { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(REACH_MS),
          headers: { 'User-Agent': 'rpi-alert/' + require('../package.json').version } }), REACH_MS + 2000);
        if (res && res.body && res.body.cancel) res.body.cancel().catch(() => {});
        this.answered();
        return true;
      } catch (e) {
        why = ep.url + ': ' + ((e && e.cause && e.cause.code) || (e && e.name === 'TimeoutError' ? 'timed out' : (e && e.message) || e));
      }
    }
    this.unanswered(why);
    return false;
  }

  endpoints() {
    const e = this.getCfg().endpoints;
    if (this.good >= e.length) this.good = 0;
    return e.slice(this.good).concat(e.slice(0, this.good)).map((url, k) => ({ url: url.replace(/\/+$/, ''), i: (this.good + k) % e.length }));
  }

  // → { status, body, endpoint } ; throws only when no endpoint could be reached.
  async rpc(name, payload, token) {
    const cfg = this.getCfg();
    const headers = {
      apikey: cfg.apikey, 'X-Ingest-Token': token || cfg.token, 'Content-Type': 'application/json',
      'Content-Profile': cfg.schema, Accept: 'application/json', 'User-Agent': 'rpi-alert/' + require('../package.json').version,
    };
    const body = JSON.stringify({ payload });
    let lastErr = null, heard = false;
    for (const ep of this.endpoints()) {
      let res, text;
      try {
        res = await deadline((async () => {
          const r = await this.fetch(ep.url + '/rpc/' + name, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
          return { r, t: await r.text() };
        })(), HARD_MS);
        text = res.t; res = res.r;
      } catch (e) {
        lastErr = new Error(ep.url + ': ' + ((e && e.cause && e.cause.code) || (e && e.name === 'TimeoutError' ? 'timed out' : (e && e.message) || e)));
        continue;
      }
      // Any HTTP answer says the network path is there, whatever it says.
      heard = true;
      this.answered();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) {}
      // A gateway that is down, or a route a proxy does not have, is a reason
      // to try the other door. PostgREST's own 404 for a function it does not
      // know (PGRST202) is an answer about the database, not the door.
      const missingFn = res.status === 404 && json && (json.code === 'PGRST202' || /function/i.test(json.message || ''));
      if (res.status >= 502 || (res.status === 404 && !missingFn) || res.status === 405) {
        lastErr = new Error(ep.url + ': HTTP ' + res.status);
        continue;
      }
      if (this.good !== ep.i) this.log.info('MegaNet reached through ' + ep.url);
      this.good = ep.i;
      this.lastEndpoint = ep.url;
      return { status: res.status, body: json, text, endpoint: ep.url, missingFn };
    }
    if (!heard) this.unanswered(lastErr && lastErr.message);
    throw lastErr || new Error('no MegaNet endpoint configured');
  }
}

module.exports = { MegaNet, deadline, TIMEOUT_MS };
