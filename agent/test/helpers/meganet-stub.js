'use strict';
// A stand-in for MegaNet's PostgREST RPCs, holding the agent to the same
// contract the real database does (docs/ingest-http.md): the four headers, the
// body nested under "payload", 401 for a bad token, the 1,000-row limit, and
// an { accepted, duplicates, rejected } answer deduplicated on address + time
// + raw value. Also serves a small stations.json.

const http = require('node:http');

function start(opts) {
  opts = opts || {};
  const goodToken = opts.token || 'mgn_test_token';
  const seen = new Set();
  const calls = [];
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
      if (h['x-ingest-token'] !== goodToken) return send(401, { message: 'invalid ingest token' });
      let j;
      try { j = JSON.parse(body); } catch (_) { return send(400, { message: 'bad json' }); }
      call.body = j;
      const p = j && j.payload;
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
  return new Promise((resolve) => server.listen(opts.port || 0, '127.0.0.1', () => {
    resolve({ server, calls, port: server.address().port, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(r => server.close(r)), opts });
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
