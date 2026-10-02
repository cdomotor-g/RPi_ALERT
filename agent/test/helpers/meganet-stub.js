'use strict';
// A stand-in for MegaNet's PostgREST RPCs, holding the agent to the same
// contract the real database does (docs/ingest-http.md): the four headers, the
// body nested under "payload", 401 for a bad token, the 1,000-row limit, and
// an { accepted, duplicates, rejected } answer deduplicated on address + time
// + raw value. Also serves a small stations.json.
//
// And the token requests (MegaNet 0048), as tools/check_ingest_token_requests.sql
// holds the real ones: request_ingest_token() takes the device's own token
// (mgn_ + 64 hex) and answers pending with a code; ingest_token_request_status()
// and withdraw_ingest_token_request() answer for that token alone. approve(),
// deny() and expire() are the administrator; an approved token is accepted by
// every other call from then on.

const http = require('node:http');

function start(opts) {
  opts = opts || {};
  const goodToken = opts.token || 'mgn_test_token';
  const tokens = new Set([goodToken]);
  const requests = [];                 // { id, code, label, status, token, payload }
  const seen = new Set();
  const calls = [];
  let nCode = 0;
  const stateOf = (token) => {
    const r = requests.find(x => x.token === token);
    if (r && r.status === 'approved') return { status: 'approved', label: r.label };
    if (tokens.has(token)) return { status: 'approved', label: 'Stub base' };
    if (!r) return { status: 'unknown' };
    return { status: r.status, id: r.id, code: r.code, label: r.label, expires_in: r.status === 'pending' ? 1700 : 0, poll_s: 5 };
  };
  const stations = opts.stations || { stations: [
    { id: 'loudoun_br_al', name: 'Loudoun Br AL', station_number: '541155', lat: -27.3278, lon: 150.9218,
      sensors: [{ alert_id: 6128, type: 'Rainfall' }, { alert_id: 6129, type: 'Water Level' }, { alert_id: 6130, type: 'Battery' }] },
    { id: 'marburg_al', name: 'Marburg AL', station_number: '540000', lat: -27.56, lon: 152.59, alert_ids: { battery: 2088, rainfall: 2089 } },
  ] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && req.url.endsWith('/stations.json')) return send(200, stations);
      const m = /\/rpc\/(\w+)$/.exec(req.url);
      if (!m) return send(404, { message: 'no route' });
      const h = req.headers;
      const call = { fn: m[1], headers: h, body: null, at: Date.now() };
      calls.push(call);
      if (opts.down) return send(503, { message: 'down' });
      if (!h.apikey || h['content-profile'] !== 'meganet' || !/json/.test(h['content-type'] || '')) return send(400, { message: 'missing headers' });
      let j;
      try { j = JSON.parse(body); } catch (_) { return send(400, { message: 'bad json' }); }
      call.body = j;
      const p = j && j.payload;
      const tok = h['x-ingest-token'];
      if (['request_ingest_token', 'ingest_token_request_status', 'withdraw_ingest_token_request'].includes(m[1])) {
        if (opts.noRequests) return send(404, { code: 'PGRST202', message: 'Could not find the function meganet.' + m[1] });
        if (!tok) return send(401, { message: 'missing X-Ingest-Token header' });
        if (m[1] === 'request_ingest_token') {
          if (!/^mgn_[0-9a-f]{64}$/.test(tok)) return send(400, { code: '22023', message: 'send the token this device made for itself' });
          const st = stateOf(tok);
          if (st.status === 'pending' || st.status === 'approved') return send(200, st);
          if (st.status !== 'unknown') return send(409, { code: '23505', message: 'this token has asked before' });
          if (!p || !String(p.label || '').trim() || /[\u0000-\u001f]/.test(p.label)) return send(400, { code: '22023', message: 'a request needs a one-line label' });
          if (opts.waitingFull) return send(429, { code: 'PT429', message: '20 base stations are already waiting for an administrator' });
          const code = (opts.codes && opts.codes[nCode]) || ['WDJB-MJHT', 'BCDF-GHJK', 'KLMN-PQRS', 'TVWX-ZBCD'][nCode % 4];
          nCode++;
          requests.push({ id: requests.length + 1, code, label: String(p.label).trim(), status: 'pending', token: tok, payload: p });
          return send(200, Object.assign(stateOf(tok), { expires_in: 1800, expires_at: new Date(Date.now() + 1800e3).toISOString() }));
        }
        if (m[1] === 'withdraw_ingest_token_request') {
          const r = requests.find(x => x.token === tok && x.status === 'pending');
          if (r) r.status = 'withdrawn';
        }
        return send(200, stateOf(tok));
      }
      if (!tokens.has(tok)) return send(401, { message: 'invalid ingest token' });
      if (!p || typeof p !== 'object') return send(400, { message: 'payload missing' });
      if (m[1] === 'ingest_http') {
        if (!Array.isArray(p.readings)) return send(400, { message: 'readings must be an array' });
        if (p.readings.length > 1000) return send(400, { message: 'batch too large' });
        let accepted = 0, duplicates = 0; const rejected = [];
        p.readings.forEach((r, i) => {
          if (!(r.alert_id >= 1 && r.alert_id <= 65535)) return rejected.push({ i, why: 'alert_id ' + r.alert_id + ' is outside 1-65535' });
          const ts = typeof r.reading_ts === 'number' ? (r.reading_ts > 1e12 ? r.reading_ts : r.reading_ts * 1000) : Date.parse(r.reading_ts);
          if (!(ts > Date.UTC(1990, 0, 1))) return rejected.push({ i, why: 'reading_ts is before 1990 — a dead clock, not a reading' });
          const k = r.alert_id + '|' + ts + '|' + r.value_raw;
          if (seen.has(k)) duplicates++; else { seen.add(k); accepted++; }
        });
        return send(200, { accepted, duplicates, rejected, raw_id: calls.length });
      }
      if (m[1] === 'report_ingest_point') {
        if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(p.point_id || '')) return send(400, { message: 'point_id' });
        if (!['quansheng', 'ert-a2', 'rtl-sdr', 'serial'].includes(p.receiver)) return send(400, { message: 'receiver' });
        return send(200, { id: calls.length, label: 'Stub base', point_id: p.point_id, path: 'serial-monitor/' + p.point_id, repeat: false });
      }
      if (m[1] === 'report_receptions') {
        if (opts.noReceptions) return send(404, { code: 'PGRST202', message: 'Could not find the function meganet.report_receptions' });
        if (!Array.isArray(p.receptions)) return send(400, { message: 'receptions must be an array' });
        return send(200, { accepted: p.receptions.length, rejected: [] });
      }
      return send(404, { code: 'PGRST202', message: 'Could not find the function' });
    });
  });
  // The administrator, on MegaNet's Admin tab.
  const decide = (code, status, label) => {
    const r = requests.find(x => x.code === code && x.status === 'pending');
    if (!r) throw new Error('no pending request ' + code);
    r.status = status;
    if (status === 'approved') { r.label = label || r.label; tokens.add(r.token); }
    return r;
  };
  return new Promise((resolve) => server.listen(opts.port || 0, '127.0.0.1', () => {
    resolve({ server, calls, requests, tokens, port: server.address().port, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(r => server.close(r)), opts,
      approve: (code, label) => decide(code, 'approved', label), deny: (code) => decide(code, 'denied'), expire: (code) => decide(code, 'expired') });
  }));
}

module.exports = { start };

if (require.main === module) {
  start({ port: Number(process.argv[2]) || 8098 }).then(s => {
    console.log('MegaNet stub on ' + s.url);
    let n = 0;
    setInterval(() => { while (n < s.calls.length) { const c = s.calls[n++]; console.log(c.fn, c.headers['x-ingest-token'], JSON.stringify(c.body)); } }, 200);
  });
}
