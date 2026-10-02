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

class MegaNet {
  constructor(getCfg, log) {
    this.getCfg = getCfg;      // () => config.meganet
    this.log = log;
    this.good = 0;             // index of the endpoint that last worked
    this.lastEndpoint = null;
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
    let lastErr = null;
    for (const ep of this.endpoints()) {
      let res, text;
      try {
        res = await fetch(ep.url + '/rpc/' + name, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
        text = await res.text();
      } catch (e) {
        lastErr = new Error(ep.url + ': ' + ((e && e.cause && e.cause.code) || (e && e.name === 'TimeoutError' ? 'timed out' : (e && e.message) || e)));
        continue;
      }
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
    throw lastErr || new Error('no MegaNet endpoint configured');
  }
}

module.exports = { MegaNet };
