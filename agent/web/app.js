'use strict';
// RPi ALERT dashboard — no framework, no CDN: it has to work on the Pi's own
// screen with no internet at all.

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIOSK = new URLSearchParams(location.search).has('kiosk');
if (KIOSK) document.documentElement.classList.add('kiosk');

const S = { status: null, config: null, readings: [], bursts: [], logLines: [], tab: 'dash', sse: null };

// ── API ─────────────────────────────────────────────────────────────────────

async function api(path, opts) {
  opts = opts || {};
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const res = await fetch(path, init);
  let body = null;
  try { body = await res.json(); } catch (_) {}
  if (res.status === 401 && body && body.login) { askLogin(); throw new Error('log in first'); }
  if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
  return body;
}

function flash(form, msg, ok) {
  const el = form.querySelector('.status');
  if (!el) return;
  el.textContent = msg; el.className = 'status small ' + (ok ? 'ok' : 'bad');
  if (ok) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
}

// ── formatting ──────────────────────────────────────────────────────────────

function hhmmss(t) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function ago(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 5) return 'just now';
  return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago';
}
function protoTag(p) { return '<span class="proto ' + (p === 'alert2' ? 'alert2' : 'alert') + '">' + (p === 'alert2' ? 'ALERT2' : 'ALERT') + '</span>'; }
function stateLabel(s) {
  return { running: 'receiving', identifying: 'identifying…', opening: 'opening…', starting: 'starting…', disconnected: 'reconnecting…',
    unplugged: 'unplugged', restarting: 'restarting…', error: 'error', ignored: 'ignored', disabled: 'off', stopped: 'stopped', 'out-of-band': 'not decoded' }[s] || s;
}
const FORMAT_NAMES = { BINARY: 'ALERT Binary', ENHANCED_IFLOWS: 'Enhanced iFLOWS', ASCII: 'ALERT ASCII' };

// ── drawing without undoing ─────────────────────────────────────────────────
// The page redraws every two seconds. An element is only rewritten when what
// it shows has changed, and rows of inputs are kept, one per key, so a button
// is not replaced between press and release and typing is not undone.

const drawn = new WeakMap();
function setHtml(el, html) { if (el && drawn.get(el) !== html) { el.innerHTML = html; drawn.set(el, html); } }

// box: the container; items: what to show; o: { key(item), cls (the rows'
// class), make (a new row's HTML), fill(row, item) when made or with force,
// update(row, item) every time, empty (HTML while there are none) }.
function keyedRows(box, items, o) {
  if (!box) return;
  if (!items.length) { if (!box.querySelector(':scope > .none')) box.innerHTML = o.empty; return; }
  const none = box.querySelector(':scope > .none');
  if (none) none.remove();
  const rows = new Map($$(':scope > .' + o.cls.split(' ').pop(), box).map(r => [r.dataset.key, r]));
  items.forEach((it, i) => {
    const k = o.key(it);
    let row = rows.get(k);
    const made = !row;
    if (made) { row = document.createElement('div'); row.className = o.cls; row.dataset.key = k; row.innerHTML = o.make; }
    if ((made || o.force) && o.fill) o.fill(row, it);
    if (o.update) o.update(row, it);
    if (box.children[i] !== row) box.insertBefore(row, box.children[i] || null);
    rows.delete(k);
  });
  for (const r of rows.values()) r.remove();
}

// ── header ──────────────────────────────────────────────────────────────────

function renderHeader() {
  const s = S.status;
  if (!s) return;
  $('#name').textContent = s.name;
  const addr = (s.system.addresses || []).map(a => a.address).join(' · ');
  $('#host').textContent = s.system.hostname + '.local' + (addr ? ' · ' + addr : '') + ' · ' + (s.system.model || '');
  const m = s.meganet, chips = [], tr = s.tokenRequest || {};
  if (tr.state === 'pending') chips.push(['warn', 'MegaNet: waiting for approval · ' + tr.code]);
  else if (!m.tokenSet) chips.push(['warn', 'MegaNet: no token']);
  else if (m.tokenRefused) chips.push(['bad', 'MegaNet: token refused']);
  else if (!m.enabled) chips.push(['warn', 'MegaNet: sending off']);
  else if (m.lastError) chips.push(['warn', 'MegaNet: retrying']);
  else chips.push(['ok', 'MegaNet' + (m.label ? ': ' + m.label : '') + (m.lastOkAt ? ' · ' + ago(Date.now() - m.lastOkAt) : '')]);
  if (m.queued || m.waitingForClock) chips.push(['warn', (m.queued + m.waitingForClock) + ' waiting']);
  chips.push(s.clock.trusted ? ['ok', 'Clock: ' + s.clock.source] : ['warn', 'Clock: not set yet']);
  if (s.hotspot && s.hotspot.active) chips.push(['ok', 'Hotspot: ' + s.hotspot.ssid + (s.hotspot.clients ? ' · ' + s.hotspot.clients + ' on it' : '')]);
  if (s.survey && s.survey.state === 'running') chips.push(['ok', 'Surveying: ' + s.survey.name + ' · ' + s.survey.addresses + ' heard']);
  else if (s.survey && s.survey.state === 'armed') chips.push(['warn', 'Survey starts at the next power-up']);
  const L = s.location;
  chips.push(L.source === 'gps' ? ['ok', 'GPS fix'] : L.source === 'none' ? ['warn', 'No location'] : ['ok', 'Location: ' + L.source]);
  if (s.system.power && s.system.power.underVoltageNow) chips.push(['bad', 'Under-voltage']);
  else if (s.system.power && s.system.power.underVoltageSinceBoot) chips.push(['warn', 'Under-voltage since boot']);
  if (s.system.tempC != null) chips.push([s.system.tempC > 75 ? 'bad' : s.system.tempC > 65 ? 'warn' : 'ok', s.system.tempC + ' °C']);
  // An administrator has this base station open on MegaNet's Base Stations tab.
  if (s.remote && s.remote.watch && s.remote.state === 'ok') chips.push(['ok', 'MegaNet: an administrator is looking']);
  $('#chips').innerHTML = chips.map(([c, t]) => '<span class="chip ' + c + '">' + esc(t) + '</span>').join('');

  const banners = [];
  const ask = '<button type="button" data-act="token-request"' + (tr.state === 'asking' ? ' disabled' : '') + '>Request a token</button>';
  // Waiting: the card on the Dashboard and in Settings says it, larger; the
  // other tabs get a line pointing back to it.
  if (tr.state === 'pending') {
    if (S.tab !== 'dash' && S.tab !== 'settings') banners.push(['', 'Waiting for an administrator to approve this base station — code <b class="mono">'
      + esc(tr.code) + '</b>. <a href="#dash">Show the QR code</a>']);
  } else if (!m.tokenSet) banners.push(['', 'No MegaNet ingest token yet — readings are decoded and kept here, and sent once one is set. ' + ask
    + ' <span class="dim">— an administrator approves it from their phone. Or paste one in <a href="#settings">Settings → MegaNet</a>.</span>']);
  if (m.tokenRefused && tr.state !== 'pending') banners.push(['bad', esc(m.lastError) + ' ' + ask.replace('Request a token', 'Request a new token') + ' <a href="#settings">Settings → MegaNet</a>']);
  if (s.system.power && (s.system.power.underVoltageNow || s.system.power.underVoltageSinceBoot)) banners.push(['bad', 'The Pi has seen under-voltage. A weak power supply makes USB receivers drop out — use the official supply (5 V 3 A, or 5 A for a Pi 5).']);
  // Secure by default (H-4): a password is always set. The auto-generated one
  // is shown only on this Pi's own screen (a local request), so whoever stands
  // at the kiosk can read it and hand it out or change it; the network never
  // gets it. The old "no password set" line is kept as a fallback.
  if (s.auth && s.auth.initialPassword) banners.push(['', 'This base station\'s web password is <b class="mono">' + esc(s.auth.initialPassword)
    + '</b> — other computers on the network need it to change settings. <a href="#settings">Change it</a>.']);
  else if (s.auth && !s.auth.passwordSet && !s.auth.local) banners.push(['', 'No web page password is set, so anyone on this network can change these settings. <a href="#settings">Set one</a>.']);
  const b = $('#banner');
  b.hidden = !banners.length;
  b.className = 'banner' + (banners.some(x => x[0] === 'bad') ? ' bad' : '');
  // Drawn again only when it says something new: it holds a button, and a
  // button replaced between press and release never sees the click.
  const html = banners.map(x => '<div>' + x[1] + '</div>').join('');
  if (b.dataset.html !== html) { b.innerHTML = html; b.dataset.html = html; }
  renderPair();
  $('#foot').textContent = 'RPi ALERT ' + s.version + ' · up ' + ago(s.system.uptimeS * 1000).replace(' ago', '') + ' · ' + s.system.os + ' · node ' + s.system.node;
}

// ── asking MegaNet for a token (0048) ───────────────────────────────────────
// The code and a QR code of MegaNet's link to the request, while an
// administrator is asked to approve it; what happened, after. The card is drawn
// again only when the request changes — the countdown is a text update — so its
// buttons can be pressed.

function untilText(sec) {
  if (sec == null) return '';
  return sec <= 60 ? 'under a minute' : Math.round(sec / 60) + ' min';
}

function pairCardHtml(tr, where) {
  let qr = '';
  try { qr = typeof QR !== 'undefined' ? QR.svg(tr.link, { ecl: 'M', label: 'QR code: open MegaNet\'s Admin tab on this request' }) : ''; } catch (_) {}
  return '<div class="card pair" role="status">'
    + '<h2>Waiting for an administrator to approve this base station</h2>'
    + '<div class="pair-body">'
    + (qr ? '<div class="pair-qr">' + qr + '</div>' : '')
    + '<div class="pair-text">'
    + '<div class="dim small">The code</div><div class="pair-code" aria-label="' + esc(tr.code.split('').join(' ')) + '">' + esc(tr.code) + '</div>'
    + '<ol class="pair-steps">'
    + '<li>On a phone or computer signed in to MegaNet as an administrator, ' + (qr ? 'scan this QR code, or ' : '') + 'open MegaNet → <b>Admin</b> → <b>Ingest tokens</b>.</li>'
    + '<li>Check the request shows <b class="mono">' + esc(tr.code) + '</b>, then press <b>Approve</b>.</li>'
    + '<li>This Pi starts sending by itself within a few seconds — nothing to type here.</li></ol>'
    + '<div class="dim small">Asking as “' + esc(tr.label || '') + '” · expires in <span data-expires>' + esc(untilText(tr.expiresInS)) + '</span>'
    + (tr.auto ? ' · asked by itself (request_token = yes)' : '') + '</div>'
    + '<div class="row-actions"><button type="button" class="ghost" data-act="token-cancel">Stop asking</button>'
    + (where === 'dash' ? '' : '<a class="small" href="' + esc(tr.link) + '" target="_blank" rel="noopener">Open MegaNet</a>') + '</div>'
    + '</div></div></div>';
}

function lastHtml(last) {
  if (!last) return '';
  const cls = last.status === 'approved' ? 'ok' : last.status === 'withdrawn' ? '' : 'bad';
  return '<p class="small status ' + cls + '">' + esc(last.message) + '</p>';
}

function renderPair() {
  const s = S.status;
  if (!s) return;
  const tr = s.tokenRequest || { state: 'idle' }, m = s.meganet;
  const recent = tr.last && Date.now() - tr.last.at < 10 * 60 * 1000 && tr.last.status !== 'withdrawn';
  const dash = tr.state === 'pending' ? pairCardHtml(tr, 'dash') : recent && tr.last.status !== 'busy' ? '<div class="card">' + lastHtml(tr.last) + '</div>' : '';
  let set;
  if (tr.state === 'pending') set = pairCardHtml(tr, 'settings');
  else {
    // With a token that works, asking for another is the exception (a token
    // lost or revoked), so the button steps back.
    const working = m.tokenSet && !m.tokenRefused;
    set = '<div class="pair-ask"><div class="row-actions"><button type="button"' + (working ? ' class="ghost"' : '') + ' data-act="token-request"'
      + (tr.state === 'asking' ? ' disabled' : '') + '>'
      + (tr.state === 'asking' ? 'Asking MegaNet…' : m.tokenSet ? 'Request a new token' : 'Request a token') + '</button></div>'
      + (working
        ? '<p class="hint">This Pi has a token that works. Ask for a new one only if it has been revoked or lost — once approved, the new one replaces it here, '
          + 'and the administrator can revoke the old one as they approve.</p>'
        : '<p class="hint">Easiest: this Pi asks MegaNet for its token and shows a code; an administrator signed in to MegaNet on any device — '
          + 'their phone — checks the code and approves it on the <b>Admin</b> tab. Nothing to copy or type, and nobody signs in here.</p>')
      + lastHtml(tr.last) + '</div>';
  }
  for (const [id, html] of [['#pair-dash', dash], ['#pair-settings', set]]) {
    const el = $(id);
    if (el && el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }
  // The countdown moves on every refresh without redrawing the buttons.
  $$('[data-expires]').forEach(e => { e.textContent = untilText(tr.expiresInS); });
}

async function tokenAction(act) {
  try {
    if (act === 'token-request') S.status.tokenRequest = await api('/api/token/request', { method: 'POST', body: {} });
    else if (act === 'token-cancel') S.status.tokenRequest = await api('/api/token/request/cancel', { method: 'POST', body: {} });
  } catch (e) { alert(e.message); }
  // Drawn again even if the answer reads the same as before (MegaNet still
  // unreachable, say): the button pressed was disabled, and only a redraw
  // gives it back.
  for (const id of ['#banner', '#pair-dash', '#pair-settings']) { const el = $(id); if (el) el.dataset.html = ''; }
  refresh();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  e.preventDefault();
  b.disabled = true;
  tokenAction(b.dataset.act);
});

// ── dashboard ───────────────────────────────────────────────────────────────

function allDevices() { return S.status ? [...S.status.devices.sdrs, ...S.status.devices.ports] : []; }

// Every receiver: a serial device, a stick with one channel, or each channel
// of a stick with several (each a receiver of its own, `stick` its stick).
function receivers() {
  const out = [];
  for (const d of allDevices()) {
    if (d.kind === 'sdr' && d.channels && d.channels.length > 1) {
      for (const ch of d.channels) out.push(Object.assign({}, ch, { kind: 'sdr', protocol: 'alert', stick: d }));
    } else out.push(d);
  }
  return out;
}

function renderStats() {
  const s = S.status;
  if (!s) return;
  const m = s.meganet;
  const rx = receivers().filter(d => d.kind !== 'gps');
  const stats = [
    ['Readings heard', s.counts.readings], ['ALERT', s.counts.alert || 0], ['ALERT2', s.counts.alert2 || 0],
    ['Stored in MegaNet', m.accepted], ['Waiting to send', m.queued + m.waitingForClock],
    ['Receivers receiving', rx.filter(d => d.state === 'running').length + ' / ' + rx.length],
  ];
  $('#stats').innerHTML = stats.map(([k, v]) => '<div class="stat"><div class="v">' + esc(v) + '</div><div class="k">' + esc(k) + '</div></div>').join('');
}

const NO_FIT = 'does not fit beside the stick\'s other channels — not decoded';

function deviceLine(d) {
  const bits = [];
  if (d.kind === 'sdr' && d.stick) {
    // One channel of several: its name says the frequency.
    const s = d.stick;
    bits.push(FORMAT_NAMES[d.format] || d.format);
    if (s.state === 'unplugged' || S.status.devices.sdrs.length > 1) bits.push('USB port ' + (s.device.port || '?'));
    if (!d.inBand) bits.push('⚠ ' + NO_FIT);
    else if (s.state === 'unplugged') { if (s.lastSeen) bits.push('last seen ' + ago(Date.now() - s.lastSeen)); }
    else {
      if (d.level) bits.push('channel ' + d.level.chDb + ' dB (floor ' + d.level.nfDb + ')' + (d.level.open ? ' · OPEN' : ''));
      bits.push(d.counts.bursts + ' bursts, ' + d.counts.decodes + ' decodes');
    }
    return bits.join(' · ');
  }
  if (d.kind === 'sdr') {
    bits.push((d.freqHz / 1e6).toFixed(4) + ' MHz', FORMAT_NAMES[d.format] || d.format);
    // With several sticks, the port says which is which.
    if (d.state === 'unplugged' || S.status.devices.sdrs.length > 1) bits.push('USB port ' + (d.device.port || '?'));
    if (d.state === 'unplugged') {
      if (d.lastSeen) bits.push('last seen ' + ago(Date.now() - d.lastSeen));
    } else {
      if (d.model || d.tuner) bits.push(d.model || d.tuner);
      if (d.level) bits.push('channel ' + d.level.chDb + ' dB (floor ' + d.level.nfDb + ')' + (d.level.open ? ' · OPEN' : ''));
      bits.push(d.counts.bursts + ' bursts, ' + d.counts.decodes + ' decodes');
      if (tuneHint(d)) bits.push(tuneHint(d));
    }
  } else {
    bits.push(d.port.dev.split('/').pop() + (d.port.baud && !d.port.acm ? ' @ ' + d.port.baud : ''));
    const q = d.detail || {};
    if (d.kind === 'quansheng') {
      if (q.battery) bits.push('battery ' + q.battery.pct + '%');
      if (q.nf_dbm != null) bits.push('noise ' + q.nf_dbm + ' dBm');
      if (q.firmware) bits.push('fw ' + q.firmware); else if (q.legacy) bits.push('legacy firmware');
    } else if (d.kind === 'ert-a2') {
      if (q.format) bits.push(q.format === 'ascii' ? 'RS-232 ASCII' : 'USB binary');
      if (q.counts) bits.push(q.counts.frames + ' frames' + (q.counts.bad ? ', ' + q.counts.bad + ' bad' : ''));
    } else if (d.kind === 'gps') {
      bits.push(q.fix ? (q.fix.lat != null ? q.fix.lat.toFixed(5) + ', ' + q.fix.lon.toFixed(5) + ' ±' + q.fix.accuracy_m + ' m' : 'fix') + ' · ' + (q.sats || '?') + ' sats' : 'no fix yet');
    }
    if (d.lastRxAgoMs != null) bits.push('data ' + ago(d.lastRxAgoMs));
  }
  if (d.error) bits.push('⚠ ' + d.error);
  return bits.join(' · ');
}

// A channel peak this close to 0 dBFS is the ADC's ceiling, not the signal:
// the burst saturated the stick and its level and SNR are only lower bounds.
const SATURATED_DBFS = -3;

function snrText(snr) { return snr != null ? 'SNR ' + Math.round(snr) + ' dB' : ''; }

function signalCell(r) {
  if (r.rssi_dbm != null) {
    const bits = [r.rssi_dbm + ' dBm'];
    if (r.snr_db != null) bits.push(snrText(r.snr_db));
    return esc(bits.join(' · ')) + (r.nf_dbm != null ? '<br>' + esc('floor ' + r.nf_dbm + ' dBm') : '');
  }
  if (r.votes == null) return '';
  const sat = r.level_dbfs != null && r.level_dbfs >= SATURATED_DBFS;
  const top = [r.votes + ' votes'];
  if (r.snr_db != null) top.push((sat ? '≥ ' : '') + snrText(r.snr_db));
  const low = [];
  if (r.level_dbfs != null) low.push('peak ' + r.level_dbfs + ' dBFS');
  if (r.nf_dbfs != null) low.push('floor ' + r.nf_dbfs);
  return esc(top.join(' · ')) + (low.length ? '<br>' + esc(low.join(', ')) : '')
    + (sat ? ' <span style="color: var(--warn)" title="The burst reached the ADC full scale: the stick is saturated, so the true signal is stronger than shown. Lower the SDR gain.">⚠ saturated</span>' : '');
}

function readingRow(r, fresh) {
  const st = r.station ? esc(r.station.name) + (r.station.km != null ? ' <span class="dim small">' + r.station.km + ' km</span>' : '') + (r.shared ? ' <span class="dim small" title="This address is carried by ' + r.shared + ' stations; the nearest is shown">(' + r.shared + ')</span>' : '') : '<span class="dim">—</span>';
  const sig = signalCell(r);
  return '<tr' + (fresh ? ' class="fresh"' : '') + '><td>' + hhmmss(r.t) + (r.timed ? '' : ' <span class="dim small" title="Held until the Pi\'s clock is set by NTP or GPS">⏳</span>') + '</td><td>'
    + protoTag(r.protocol) + ' <span class="dim small">' + esc(r.fmt || '') + '</span></td><td class="num">' + esc(r.alert_id) + '</td><td class="wrap">' + st
    + '</td><td class="num"><b>' + esc(r.eng) + '</b>' + (String(r.eng) !== String(r.value_raw) ? ' <span class="dim small">' + esc(r.value_raw) + '</span>' : '') + '</td><td class="dim small">' + sig + '</td><td class="dim small">' + esc(r.receiver) + '</td></tr>';
}

function renderReadings(freshOne) {
  const n = KIOSK ? 40 : 150;
  const list = S.readings.slice(0, n);
  $('#readings').innerHTML = list.length ? list.map((r, i) => readingRow(r, freshOne && i === 0)).join('')
    : '<tr><td colspan="7" class="dim">Nothing heard yet. Readings appear here as each burst is decoded.</td></tr>';
  $('#read-count').textContent = S.readings.length ? '(' + S.readings.length + ' this session)' : '';
  renderTopHeard();
}

// ── charts: the time shown, and the last day a minute at a time ─────────────
// One choice of time for every chart (remembered in this browser): the last
// half hour burst by burst, or 6 or 24 hours a few minutes a bar, from the
// agent's history (lib/history.js) — which is kept through restarts.

const MIN = 60 * 1000;
const WINDOWS = { '30m': { ms: 30 * MIN, bucket: MIN, text: 'the last 30 min' }, '6h': { ms: 6 * 60 * MIN, bucket: 5 * MIN, text: 'the last 6 h' },
  '24h': { ms: 24 * 60 * MIN, bucket: 15 * MIN, text: 'the last 24 h' } };
try { const w = localStorage.getItem('rpi-alert.win'); if (WINDOWS[w]) S.win = w; } catch (_) {}
if (!S.win) S.win = '30m';
S.hist = { sys: [], rx: new Map(), cores: null, lastT: 0 };

function setWin(w) {
  if (!WINDOWS[w]) return;
  S.win = w;
  try { localStorage.setItem('rpi-alert.win', w); } catch (_) {}
  $$('[data-win]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.win === w)));
  renderCharts(true);
}
document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('[data-win]'); if (b) setWin(b.dataset.win); });

// Rows from `since` on replace what the page had from then (the minute still
// being filled comes again, with its final counts).
function mergeRows(have, rows) {
  if (!rows.length) return have;
  const from = rows[0][0];
  const keep = have.filter(p => p[0] < from && p[0] >= Date.now() - 24 * 60 * MIN);
  return keep.concat(rows);
}

async function loadHistory() {
  try {
    const h = await api('/api/history' + (S.hist.lastT ? '?since=' + S.hist.lastT : ''));
    S.hist.cores = h.cores;
    S.hist.sys = mergeRows(S.hist.sys, h.sys);
    for (const r of h.rx) {
      const was = S.hist.rx.get(r.key);
      S.hist.rx.set(r.key, { name: r.name, unit: r.unit, rows: mergeRows(was ? was.rows : [], r.rows) });
    }
    let last = 0;
    for (const p of S.hist.sys) last = Math.max(last, p[0]);
    for (const r of S.hist.rx.values()) if (r.rows.length) last = Math.max(last, r.rows[r.rows.length - 1][0]);
    S.hist.lastT = last;
    renderCharts(true);
  } catch (_) {}
}

// A receiver's bursts and readings in buckets across the window: [{ t, b, d }].
function bucketed(keys, t0, bucket) {
  const out = new Map();
  for (const k of keys) {
    const r = S.hist.rx.get(k);
    if (!r) continue;
    for (const p of r.rows) {
      if (p[0] < t0 - bucket) continue;
      const t = Math.floor(p[0] / bucket) * bucket;
      const o = out.get(t) || { t, b: 0, d: 0 };
      o.b += p[1]; o.d += p[2];
      out.set(t, o);
    }
  }
  return [...out.values()];
}

function activityBars(buckets, bucket) {
  const bars = [];
  for (const o of buckets) {
    bars.push({ t: o.t, w: bucket, v: o.b, color: Charts.alpha('--accent', 0.35) });
    bars.push({ t: o.t + bucket * 0.2, w: bucket * 0.6, v: o.d, color: '--ok' });
  }
  return bars;
}

function bucketTip(buckets, bucket) {
  return (t) => {
    const o = buckets.find(x => t >= x.t && t < x.t + bucket);
    const from = Math.floor(t / bucket) * bucket;
    return Charts.hhmm(from) + '–' + Charts.hhmm(from + bucket) + ' · ' + (o ? o.b + ' burst' + (o.b === 1 ? '' : 's') + ', ' + o.d + ' reading' + (o.d === 1 ? '' : 's') : 'nothing heard');
  };
}

// How high a burst's stem stands: its peak, on its own kind of scale.
function burstF(b) {
  const pk = b.peakDb != null ? b.peakDb : b.peak;
  if (pk == null) return 0.4;
  return b.kind === 'sdr' ? (pk + 60) / 60 : (pk + 130) / 80;
}
const burstOf = (b, d) => (b.key ? b.key === d.key : b.receiver === d.name);
const readingOf = (r, d) => (r.receiverKey ? r.receiverKey === d.key : r.receiver === d.name);

// The live half hour: a stem for each burst (green once decoded), a dot for
// each reading. `d` is one receiver, or none for all of them.
function liveChart(c, d, t0, t1) {
  const bursts = S.bursts.filter(b => b.t >= t0 && (!d || burstOf(b, d)));
  const reads = S.readings.filter(r => r.t >= t0 && (!d || readingOf(r, d)));
  const decoded = (b) => b.frames > 0 || reads.some(r => Math.abs(r.t - b.t) < 4000 && (!b.key || !r.receiverKey || r.receiverKey === b.key));
  const stems = bursts.map(b => ({ t: b.t, f: burstF(b), color: decoded(b) ? '--ok' : '--warn', b }));
  Charts.draw(c, {
    t0, t1, stems, noY: true, xAxis: !d, gutter: d ? 26 : 0,
    dots: reads.map(r => ({ t: r.t, f: 0.92, color: '--accent', r: d ? 2 : 2.5 })),
    tip: (t) => {
      const tol = (t1 - t0) / Math.max(1, c.clientWidth) * 5;
      const near = stems.filter(s => Math.abs(s.t - t) <= tol).map(s => s.b);
      const rd = reads.filter(r => Math.abs(r.t - t) <= tol);
      if (!near.length && !rd.length) return null;
      const lines = near.slice(0, 4).map(b => hhmmss(b.t) + (d ? '' : ' · ' + b.receiver) + ((b.peakDb ?? b.peak) != null ? ' · peak ' + (b.peakDb ?? b.peak) + (b.kind === 'sdr' ? ' dBFS' : ' dBm') : ''));
      for (const r of rd.slice(0, 4)) lines.push(hhmmss(r.t) + ' · ' + r.alert_id + (r.station ? ' ' + r.station.name : '') + ' = ' + r.eng);
      return lines.join('\n');
    },
  });
  return { bursts: bursts.length, readings: reads.length };
}

let chartsQueued = false;
function renderCharts(now) {
  if (now) { chartsQueued = false; drawCharts(); return; }
  if (chartsQueued) return;
  chartsQueued = true;
  requestAnimationFrame(() => { if (chartsQueued) { chartsQueued = false; drawCharts(); } });
}

function drawCharts() {
  $$('[data-win]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.win === S.win)));
  if (S.tab === 'dash') { renderBursts(); renderRxMini(); renderPi(); }
  if (S.tab === 'rx') renderRxFull();
}

function renderBursts() {
  const c = $('#burst-canvas');
  if (!c || S.tab !== 'dash') return;
  const w = WINDOWS[S.win], t1 = Date.now(), t0 = t1 - w.ms;
  if (S.win === '30m') {
    const n = liveChart(c, null, t0, t1);
    $('#burst-count').textContent = n.bursts ? '(' + n.bursts + ' in 30 min)' : '';
    $('#burst-note').textContent = 'Each burst is a line, as high as its signal: green once decoded, amber if not. Blue dots: readings. Point at one to see it.';
  } else {
    const bk = bucketed([...S.hist.rx.keys()], t0, w.bucket);
    Charts.draw(c, { t0, t1, bars: activityBars(bk, w.bucket), y: { floor: 0, minSpan: 4, fmt: v => String(v) }, tip: bucketTip(bk, w.bucket) });
    const n = bk.reduce((a, o) => a + o.b, 0);
    $('#burst-count').textContent = n ? '(' + n + ' in ' + S.win.replace('h', ' h') + ')' : '';
    $('#burst-note').textContent = 'Every receiver together, ' + Math.round(w.bucket / MIN) + ' minutes a bar: bursts (pale) and the readings decoded from them (green).';
  }
}

// The receivers, a line each — a stick with several channels as a heading
// with its channels under it — each with its own chart over the same time.
function rxLines() {
  const out = [];
  for (const d of allDevices()) {
    if (d.kind === 'sdr' && d.channels && d.channels.length > 1) {
      out.push({ key: 'stick:' + d.key, stick: d });
      for (const ch of d.channels) out.push({ key: ch.key, d: Object.assign({}, ch, { kind: 'sdr', protocol: 'alert', stick: d }), chan: true });
    } else out.push({ key: d.key, d });
  }
  return out;
}

function stickLine(s) {
  const bits = [s.channels.length + ' channels'];
  if (s.state === 'unplugged' || S.status.devices.sdrs.length > 1) bits.push('USB port ' + (s.device.port || '?'));
  if (s.state === 'unplugged') { if (s.lastSeen) bits.push('last seen ' + ago(Date.now() - s.lastSeen)); }
  else {
    if (s.model || s.tuner) bits.push(s.model || s.tuner);
    bits.push((s.centerHz / 1e6).toFixed(3) + ' MHz centre');
    if (s.level) bits.push('ADC ' + s.level.dbfs + ' dBFS' + (s.level.clipPct ? ', clipping ' + s.level.clipPct + '%' : ''));
    if (tuneHint(s)) bits.push(tuneHint(s));
  }
  if (s.error) bits.push('⚠ ' + s.error);
  return bits.join(' · ');
}

function renderRxMini() {
  const box = $('#rx-mini');
  if (!box || !S.status) return;
  const w = WINDOWS[S.win], t1 = Date.now(), t0 = t1 - w.ms;
  $('#rx-note').textContent = 'Charts: ' + w.text + '.';
  keyedRows(box, rxLines(), {
    key: x => x.key, cls: 'rx-line', make: '<div class="rx-info"></div><canvas class="chart rx-chart"></canvas>',
    empty: '<div class="dim none">No receivers found. Plug in an RTL-SDR stick, a Quansheng radio on the ALERT firmware (USB-C), an ERT-A2 (USB-serial cable) or a USB GPS — each is picked up within a few seconds.</div>',
    update: (row, x) => {
      const c = $('canvas', row);
      if (x.stick) {
        const s = x.stick;
        row.className = 'rx-line is-stick';
        setHtml($('.rx-info', row), '<div class="rx-top"><span class="dot ' + esc(s.state) + '"></span><b>' + esc(s.name) + '</b>' + protoTag('alert')
          + '<span class="dim small">' + esc(stateLabel(s.state)) + '</span></div><div class="meta">' + esc(stickLine(s)) + '</div>');
        return;
      }
      const d = x.d, charted = d.kind !== 'gps';
      row.className = 'rx-line' + (x.chan ? ' chan' : '') + (charted ? '' : ' no-chart');
      let n = null;
      if (charted) {
        if (S.win === '30m') n = liveChart(c, d, t0, t1);
        else {
          const bk = bucketed([d.key], t0, w.bucket);
          Charts.draw(c, { t0, t1, xAxis: false, gutter: 26, bars: activityBars(bk, w.bucket), y: { floor: 0, minSpan: 2, fmt: v => String(v) }, tip: bucketTip(bk, w.bucket) });
          n = { bursts: bk.reduce((a, o) => a + o.b, 0), readings: bk.reduce((a, o) => a + o.d, 0) };
        }
      }
      setHtml($('.rx-info', row), '<div class="rx-top"><span class="dot ' + esc(d.state) + '"></span><b>' + esc(d.name) + '</b>'
        + (d.protocol && !x.chan ? protoTag(d.protocol) : '') + '<span class="dim small">' + esc(stateLabel(d.state)) + '</span></div>'
        + '<div class="meta">' + esc(deviceLine(d)) + '</div>'
        + (n ? '<div class="rx-count small"><b>' + n.bursts + '</b> burst' + (n.bursts === 1 ? '' : 's') + ' · <b>' + n.readings + '</b> reading' + (n.readings === 1 ? '' : 's')
          + ' <span class="dim">in ' + esc(w.text.replace('the ', '')) + '</span></div>' : ''));
    },
  });
}

// The Pi itself: temperature, load and memory over the window, a point a minute.
function renderPi() {
  const s = S.status;
  if (!s || !$('#pi-temp-c')) return;
  const w = WINDOWS[S.win], t1 = Date.now(), t0 = t1 - w.ms;
  const sys = S.hist.sys.filter(p => p[0] >= t0 - MIN);
  const sy = s.system, cores = S.hist.cores || sy.cores || 4;
  const line = (i) => sys.map(p => [p[0], p[i]]);
  const tipOf = (i, fmt) => (t) => {
    let best = null;
    for (const p of sys) if (p[i] != null && (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t))) best = p;
    return best && Math.abs(best[0] - t) < Math.max(2 * MIN, (t1 - t0) / 60) ? Charts.hhmm(best[0]) + ' · ' + fmt(best[i]) : null;
  };
  const temps = line(1).filter(p => p[1] != null).map(p => p[1]);
  const hot = sy.tempC != null && sy.tempC > 75 ? '--bad' : sy.tempC != null && sy.tempC > 65 ? '--warn' : '--ok';
  $('#pi-temp').textContent = sy.tempC != null ? sy.tempC + ' °C' : 'not reported on this machine';
  $('#pi-temp').style.color = sy.tempC != null ? 'var(' + hot + ')' : 'var(--dim)';
  $('#pi-temp-c').hidden = sy.tempC == null && !temps.length;
  if (!$('#pi-temp-c').hidden) Charts.draw($('#pi-temp-c'), { t0, t1, gutter: 34, lines: [{ pts: line(1), color: hot, fill: true }], y: { minSpan: 10, unit: '°C', fmt: v => v + '°' },
    refs: temps.length && Math.max(...temps) > 60 ? [{ v: 80, color: '--bad', label: 'slows down at 80 °C' }] : [], tip: tipOf(1, v => v + ' °C') });
  $('#pi-load').textContent = sy.load ? sy.load[0] + ' of ' + cores + ' cores' : '—';
  Charts.draw($('#pi-load-c'), { t0, t1, gutter: 34, lines: [{ pts: line(2), color: '--accent', fill: true }], y: { floor: 0, minSpan: 1 },
    refs: [{ v: cores, color: '--warn', label: 'every core busy', always: sys.some(p => p[2] > cores * 0.6) }], tip: tipOf(2, v => 'load ' + v) });
  const memPct = sy.memMb ? Math.round((1 - sy.memMb.free / sy.memMb.total) * 100) : null;
  $('#pi-mem').textContent = memPct != null ? memPct + '% of ' + (sy.memMb.total >= 1024 ? Math.round(sy.memMb.total / 1024) + ' GB' : sy.memMb.total + ' MB') : '—';
  Charts.draw($('#pi-mem-c'), { t0, t1, gutter: 34, lines: [{ pts: line(3), color: '--alert2', fill: true }], y: { min: 0, max: 100, fmt: v => v + '%' }, tip: tipOf(3, v => v + '% in use') });
  const bits = ['up ' + ago(sy.uptimeS * 1000).replace(' ago', '')];
  if (sy.disk) bits.push((sy.disk.freeMb >= 1024 ? (sy.disk.freeMb / 1024).toFixed(1) + ' GB' : sy.disk.freeMb + ' MB') + ' free on the card');
  $('#pi-now').textContent = bits.join(' · ');
  const p = sy.power, notes = [];
  if (p && p.underVoltageNow) notes.push('⚠ Under-voltage now.');
  else if (p && p.underVoltageSinceBoot) notes.push('⚠ Under-voltage since boot.');
  if (p && p.throttledNow) notes.push('⚠ Slowed down (throttled) now.');
  else if (p && p.throttledSinceBoot) notes.push('Throttled at some point since boot.');
  if (p && !notes.length) notes.push('Power: no under-voltage or throttling since boot.');
  notes.push(sys.length < 3 ? 'The graphs fill in a point a minute.' : 'A point a minute; the last day is kept, through restarts.');
  $('#pi-note').textContent = notes.join(' ');
}

// The stations heard most in this session's readings (the newest 500).
function renderTopHeard() {
  const box = $('#top-heard');
  if (!box) return;
  const by = new Map();
  for (const r of S.readings) {
    const k = r.protocol + ':' + r.alert_id;
    let o = by.get(k);
    if (!o) { o = { r, n: 0, best: null }; by.set(k, o); }
    o.n++;
    const sig = r.snr_db != null ? r.snr_db : null;
    if (sig != null && (o.best == null || sig > o.best)) o.best = sig;
  }
  const top = [...by.values()].sort((a, b) => b.n - a.n || b.r.t - a.r.t).slice(0, KIOSK ? 8 : 10);
  setHtml(box, top.length ? top.map(o => {
    const r = o.r;
    return '<tr><td class="wrap">' + (r.station ? esc(r.station.name) : '<span class="dim">—</span>') + '</td><td class="num">' + protoTag(r.protocol) + ' ' + esc(r.alert_id)
      + '</td><td class="num"><b>' + o.n + '</b></td><td><b>' + esc(r.eng) + '</b></td><td class="dim small">' + (o.best != null ? esc('SNR ' + Math.round(o.best) + ' dB') : r.rssi_dbm != null ? esc(r.rssi_dbm + ' dBm') : '—')
      + '</td><td class="dim small">' + esc(ago(Date.now() - r.t)) + '</td></tr>';
  }).join('') : '<tr><td colspan="6" class="dim">Nothing heard yet.</td></tr>');
}

// ── tuning help: the ppm and gain to set (lib/devices/tune-help.js) ─────────

const sgn = (v) => (v > 0 ? '+' : '') + v;
const dB = (g) => (g == null ? 'AGC' : g + ' dB');

// A few words for the dashboard's line: what to change, if anything.
function tuneHint(d) {
  const t = d.tuneHelp;
  if (!t) return '';
  const bits = [];
  if (t.ppm && t.ppm.state === 'change') bits.push('ppm ' + sgn(t.ppm.suggest));
  if (t.gain && t.gain.state === 'change') bits.push('gain ' + dB(t.gain.suggest));
  return bits.length ? '⚙ suggests ' + bits.join(', ') : '';
}

function tuneButton(d, what, value, label) {
  return '<button type="button" class="small" data-tune="' + what + '" data-key="' + esc(d.key) + '" data-name="' + esc(d.name) + '" data-value="' + esc(value) + '">' + esc(label) + '</button>';
}

function tuneHtml(d) {
  const t = d.tuneHelp;
  if (!t) return '';
  const p = t.ppm, g = t.gain;
  let ph;
  if (p.state === 'measuring') {
    ph = '<span class="dim">measuring — ' + p.bursts + ' of ' + p.need.bursts + ' decoded bursts, from ' + p.stations + ' of ' + p.need.stations + ' stations, so far</span>';
  } else {
    const meas = 'its bursts arrive as if it were ' + sgn(p.estimate) + ' ppm off, from ' + p.bursts + ' bursts by ' + p.stations + ' stations (' + (p.spread < 0.5 ? 'they agree closely' : 'they agree within ' + p.spread + ' ppm') + ')'
      + (p.spread > 2 ? ' — they disagree a lot: check against a signal you know' : '');
    ph = p.state === 'ok'
      ? '<span class="status ok">✓ ' + esc(sgn(p.set)) + ' ppm is right</span> <span class="dim">— ' + esc(meas) + '</span>'
      : '<b>' + esc(sgn(p.suggest)) + ' ppm</b> (now ' + esc(sgn(p.set)) + ') <span class="dim">— ' + esc(meas) + '</span>' + tuneButton(d, 'ppm', p.suggest, 'Set ' + sgn(p.suggest) + ' ppm');
  }
  let gh;
  const strongest = g.strongest != null ? 'the strongest bursts peak at ' + g.strongest + ' dBFS' : '';
  if (g.state === 'measuring') gh = '<span class="dim">measuring — ' + g.bursts + ' of ' + g.need.bursts + ' bursts heard at ' + esc(dB(g.set)) + ' so far</span>';
  else if (g.state === 'ok') gh = '<span class="status ok">✓ ' + esc(dB(g.set)) + ' is right</span> <span class="dim">— ' + esc(strongest) + ', with room below full scale</span>';
  else {
    const why = g.why === 'clipping' ? (g.set == null ? 'the tuner\'s AGC lets the ADC clip (' + (d.level ? d.level.clipPct : '?') + '% of samples) — a fixed gain stops it'
      : 'the ADC is clipping (' + (d.level ? d.level.clipPct : '?') + '% of samples) — something strong in the slice the stick hears, on a channel or not')
      : g.why === 'saturated' ? g.saturated + ' of ' + g.bursts + ' bursts reached the ADC\'s full scale, so the strongest stations are louder than it can show — and decode worse'
      : strongest + ': room for more gain before the strongest saturate';
    gh = '<b>' + esc(dB(g.suggest)) + '</b> (now ' + esc(dB(g.set)) + ') <span class="dim">— ' + esc(why) + '</span>' + tuneButton(d, 'gain', g.suggest, 'Set ' + dB(g.suggest));
  }
  return '<div class="tune"><div class="chart-label">Tuning help <span class="dim small">— from what this stick has heard since the agent started; the button sets it for this stick only</span></div>'
    + kv([['Frequency correction', ph], ['Gain', gh]]) + '</div>';
}

// Sets one stick's own ppm or gain: its entry in receivers.sdrDevices.
async function applyTune(b) {
  const what = b.dataset.tune, v = Number(b.dataset.value);
  const text = what === 'ppm' ? 'frequency correction to ' + sgn(v) + ' ppm' : 'gain to ' + v + ' dB';
  if (!confirm('Set ' + b.dataset.name + '\'s ' + text + '? Its rtl_sdr restarts, so a burst may be missed for a second or two.')) return;
  b.disabled = true;
  try {
    const cfg = (await api('/api/config')).config;
    const list = (cfg.receivers.sdrDevices || []).map(e => Object.assign({}, e));
    const d = S.status.devices.sdrs.find(x => x.key === b.dataset.key);
    let e = list.find(x => x.key === b.dataset.key) || (d && list.find(x => !x.key && x.serial && x.serial === d.device.serial));
    if (!e) { e = {}; list.push(e); }
    e.key = b.dataset.key; delete e.serial;
    e[what === 'ppm' ? 'ppm' : 'gainDb'] = v;
    const r = await api('/api/config', { method: 'PUT', body: { config: { receivers: { sdrDevices: list } } } });
    S.config = r.config;
    refresh();
  } catch (err) { alert(err.message); b.disabled = false; }
}
document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('[data-tune]'); if (b && !b.disabled) applyTune(b); });

// ── receivers tab ───────────────────────────────────────────────────────────

function kv(rows) { return '<div class="kv">' + rows.filter(r => r[1] != null && r[1] !== '').map(([k, v]) => '<div>' + esc(k) + '</div><div>' + v + '</div>').join('') + '</div>'; }

const OWN_LABELS = { name: 'name', enabled: 'on/off', freqHz: 'frequency', format: 'format', moreChannels: 'more channels', gainDb: 'gain', ppm: 'ppm', biasTee: 'bias tee', squelchDb: 'squelch' };

// How rtl_sdr was pointed at the stick, and whether it was seen to open it.
function openedText(o) {
  if (o.how === 'only') return 'the only stick';
  return 'rtl_sdr -d ' + o.arg + (o.how === 'serial' ? ' (its serial)' : '') + (o.checked ? ', seen to be this stick' : o.checked === false ? ', not checked' : '');
}

function rxHeadHtml(d) {
  return '<h2>' + esc(d.name) + '</h2>' + (d.protocol ? protoTag(d.protocol) : '') + '<span class="pill">' + esc(d.kind) + '</span>'
    + (d.state === 'unplugged'
      ? '<button type="button" class="ghost small danger" data-forget="' + esc(d.key) + '" data-name="' + esc(d.name) + '" title="Forget it: its name, its own settings and its MegaNet receiver id">Remove</button>'
      : '<button type="button" class="ghost small" data-restart="' + esc(d.key) + '">Restart</button>');
}

function renderRxFull() {
  keyedRows($('#rx-full'), allDevices(), {
    key: d => d.key, cls: 'card rxcard', make: '<div class="head"></div><div class="body"></div><div class="tune-box"></div><div class="hist"></div><div class="spec"></div>',
    empty: '<div class="card dim none">No receivers found yet.</div>',
    update: (card, d) => {
      setHtml($('.head', card), rxHeadHtml(d));
      setHtml($('.body', card), rxBodyHtml(d));
      setHtml($('.tune-box', card), d.kind === 'sdr' ? tuneHtml(d) : '');
      renderRxHistory($('.hist', card), d);
      const spec = $('.spec', card);
      if (d.kind === 'sdr' && d.spectrum) {
        if (!spec.firstChild) {
          spec.innerHTML = '<div class="chart-label">Spectrum <span class="dim small spec-note"></span></div><canvas class="spectrum"></canvas>'
            + '<div class="chart-label">Waterfall <span class="dim small">— newest at the top; the last few minutes while this page is open</span></div><canvas class="waterfall"></canvas>';
        }
        $('.spec-note', spec).textContent = d.spectrum.channelsHz && d.spectrum.channelsHz.length > 1
          ? '— the whole slice the stick hears; its channels are the green lines. 1 s max hold.' : '— around the channel (green line); 1 s max hold.';
        drawSpectrum($('canvas.spectrum', spec), d);
        const wf = S.wf.get(d.key);
        if (wf && wf.rows.length) { const c = $('canvas.waterfall', spec); c.dataset.rows = WF_ROWS; Charts.waterfall(c, wf.rows, wf.lo, wf.hi); }
      } else if (spec.firstChild) spec.innerHTML = '';
    },
  });
}

// Each receiver on a card — a serial device, or each channel of a stick — with
// what it heard and its noise floor over the chosen time.
function renderRxHistory(box, d) {
  const list = d.kind === 'gps' ? [] : d.kind === 'sdr' && d.channels && d.channels.length > 1
    ? d.channels.map(ch => Object.assign({}, ch, { label: Channels.mhz(ch.freqHz) + ' MHz' })) : [Object.assign({}, d, { label: '' })];
  const w = WINDOWS[S.win], t1 = Date.now(), t0 = t1 - w.ms;
  // The half hour a minute a bar, from the history too, so every chart on this tab reads the same way.
  const bucket = S.win === '30m' ? MIN : w.bucket;
  if (!list.length) { if (box.firstChild) box.innerHTML = ''; return; }
  keyedRows(box, list, {
    key: x => x.key, cls: 'hist-rx',
    make: '<div class="chart-label act-label"></div><canvas class="chart hist-act"></canvas><div class="chart-label nf-label"></div><canvas class="chart hist-nf"></canvas>',
    empty: '',
    update: (el, x) => {
      const bk = bucketed([x.key], t0, bucket);
      const nb = bk.reduce((a, o) => a + o.b, 0), nd = bk.reduce((a, o) => a + o.d, 0);
      setHtml($('.act-label', el), (x.label ? '<b>' + esc(x.label) + '</b> · ' : '') + 'Heard: ' + nb + ' bursts, ' + nd + ' readings <span class="dim small">in ' + esc(w.text.replace('the ', ''))
        + ', ' + Math.round(bucket / MIN) + ' min a bar</span>');
      Charts.draw($('.hist-act', el), { t0, t1, gutter: 34, bars: activityBars(bk, bucket), y: { floor: 0, minSpan: 2, fmt: v => String(v) }, tip: bucketTip(bk, bucket) });
      const h = S.hist.rx.get(x.key);
      const pts = h ? h.rows.filter(p => p[0] >= t0 - MIN && p[3] != null).map(p => [p[0] + MIN / 2, p[3]]) : [];
      const nfc = $('.hist-nf', el), nfl = $('.nf-label', el);
      nfc.hidden = nfl.hidden = !pts.length;
      if (pts.length) {
        const unit = h.unit || '';
        const vals = pts.map(p => p[1]);
        nfl.title = 'A rise is interference, or a stronger noise source nearby';
        setHtml(nfl, 'Noise floor <span class="dim small">' + esc(unit) + ' · now ' + esc(vals[vals.length - 1]) + ' · ' + esc(Math.min(...vals)) + ' to ' + esc(Math.max(...vals)) + '</span>');
        Charts.draw(nfc, { t0, t1, gutter: 34, lines: [{ pts, color: '--accent' }], y: { minSpan: 6, fmt: v => String(Math.round(v)) },
          tip: (t) => { let b = null; for (const p of pts) if (!b || Math.abs(p[0] - t) < Math.abs(b[0] - t)) b = p; return b && Math.abs(b[0] - t) < 3 * MIN ? Charts.hhmm(b[0]) + ' · ' + b[1] + ' ' + unit : null; } });
      }
    },
  });
}

// A waterfall for each stick, from the spectrum in each status (every 2 s).
const WF_ROWS = 90;
S.wf = new Map();
function collectSpectra() {
  for (const d of (S.status && S.status.devices.sdrs) || []) {
    const sp = d.spectrum;
    if (!sp || !sp.db || !sp.db.length) continue;
    let wf = S.wf.get(d.key);
    const sig = sp.db.length + ':' + sp.centerHz + ':' + sp.rate;
    if (!wf || wf.sig !== sig) { wf = { sig, rows: [], lo: 0, hi: 1, last: '' }; S.wf.set(d.key, wf); }
    const fp = sp.db.slice(0, 8).join(',') + sp.db[sp.db.length >> 1];
    if (fp === wf.last) continue;
    wf.last = fp;
    wf.rows.unshift(Float32Array.from(sp.db));
    if (wf.rows.length > WF_ROWS) wf.rows.length = WF_ROWS;
    // The colours span from the noise to a strong signal, steadied over the rows.
    const sorted = Array.from(sp.db).sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.2)], hi = Math.max(lo + 30, sorted[sorted.length - 1]);
    wf.lo = wf.rows.length > 1 ? wf.lo * 0.8 + lo * 0.2 : lo;
    wf.hi = wf.rows.length > 1 ? wf.hi * 0.8 + hi * 0.2 : hi;
  }
}

function rxBodyHtml(d) {
  const multi = d.kind === 'sdr' && d.channels && d.channels.length > 1;
  const rows = [['State', esc(stateLabel(d.state)) + (d.error ? ' — ' + esc(d.error) : '')]];
  // A stick with several channels has a receiver id for each: in its table.
  if (!multi) rows.push(['MegaNet receiver id', d.pointId ? '<code>' + esc(d.pointId) + '</code>' : '']);
  if (d.kind === 'sdr') {
    rows.push(['Stick', esc([d.model, d.tuner, d.device.serial && 'SN ' + d.device.serial, 'USB ' + d.device.usb].filter(Boolean).join(' · '))]);
    rows.push(['USB port', esc(d.device.port || '?') + (d.opened ? ' <span class="dim">· ' + esc(openedText(d.opened)) + '</span>' : '')]);
    if (d.state === 'unplugged') rows.push(['Last seen', d.lastSeen ? esc(ago(Date.now() - d.lastSeen) + ' (' + new Date(d.lastSeen).toLocaleString() + ')') : '—']);
    const tuner = ', gain ' + (d.gainDb == null ? 'auto' : d.gainDb + ' dB') + (d.ppm ? ', ' + d.ppm + ' ppm' : '') + (d.biasTee ? (d.biasOn ? ', bias tee ON' : ', bias tee not on') : d.biasOn ? ', bias tee still ON' : '');
    if (multi) {
      const t = d.tune || {};
      rows.push(['Tuned', esc((d.centerHz / 1e6).toFixed(4) + ' MHz centre, ' + d.sampleRate / 1000 + ' ksps' + (t.raised ? ' (raised to hold every channel)' : '') + tuner)
        + (t.dcHz != null ? ' <span class="dim">· the nearest channel ' + Math.round(t.dcHz / 1000) + ' kHz from the DC spike, '
          + Math.round(t.mirrorHz / 1000) + ' kHz from another\'s mirror image</span>' : '')]);
    } else {
      rows.push(['Tuned', esc((d.freqHz / 1e6).toFixed(4) + ' MHz channel, ' + d.sampleRate / 1000 + ' ksps' + tuner)]);
      rows.push(['Format', esc(FORMAT_NAMES[d.format] || d.format) + (d.channels && d.channels[0] && d.channels[0].recording ? ' <span class="dim">· every burst recorded (Settings → Recordings)</span>' : '')]);
    }
    rows.push(['Settings', esc(d.own.length ? 'its own ' + d.own.map(f => OWN_LABELS[f] || f).join(', ') + '; the rest shared' : 'the shared ones') + ' — <a href="#settings-sdr">change</a>']);
    if (d.level) {
      rows.push(['Signal', esc('ADC ' + d.level.dbfs + ' dBFS' + (d.level.clipPct ? ', clipping ' + d.level.clipPct + '%' : '')
        + (multi ? '' : ' · channel ' + d.level.chDb + ' dB, floor ' + d.level.nfDb + ' dB' + (d.level.open ? ' · squelch OPEN' : '')))]);
    }
    rows.push(['Heard', esc((multi ? 'on all its channels: ' : '') + d.counts.bursts + ' bursts, ' + d.counts.decodes + ' readings, ' + d.counts.shadows + ' bit-flip shadows set aside, ' + d.counts.undecoded + ' undecoded'
      + (d.counts.alert2 || d.counts.alert2Bad ? ' · ALERT2: ' + alert2Text(d.counts) : ''))]);
    if (!multi && d.level && d.level.nfDb != null) rows.push(['Noise floor', esc(d.level.nfDb + ' dBFS in the channel (squelch opens ' + (d.level.nfDb + (d.squelchDb ?? 8)).toFixed(1) + ' dBFS)')]);
    if (!multi && d.lastBurst) {
      const b = d.lastBurst, sat = b.peakDb != null && b.peakDb >= SATURATED_DBFS;
      rows.push(['Last burst', esc('peak ' + b.peakDb + ' dBFS over floor ' + b.nfDb + ' · ' + (sat ? '≥ ' : '') + snrText(b.snrDb) + ' · ' + b.ms + ' ms, ' + ago(Date.now() - b.t))
        + (sat ? ' <span style="color: var(--warn)">⚠ saturated — reached the ADC full scale; lower the gain until bursts peak below ' + SATURATED_DBFS + ' dBFS</span>' : '')]);
    }
    if (!multi && d.lastDecode) rows.push(['Last decode', esc(decodeText(d.lastDecode))]);
    rows.push(['Samples', esc(d.rateKsps + ' ksps arriving' + (d.counts.restarts ? ', rtl_sdr restarted ' + d.counts.restarts + '×' : '') + (d.counts.dropped ? ', ' + Math.round(d.counts.dropped / 1e6) + ' MB dropped (CPU)' : ''))]);
    if (d.stderr && d.stderr.length) rows.push(['rtl_sdr says', '<span class="mono small">' + esc(d.stderr.join(' | ')) + '</span>']);
    if (multi) return kv(rows) + channelTable(d);
  } else {
    rows.push(['Port', '<code>' + esc(d.port.byId || d.port.dev) + '</code>' + (d.port.usb ? ' <span class="dim">USB ' + esc(d.port.usb.vid + ':' + d.port.usb.pid + ' ' + [d.port.usb.manufacturer, d.port.usb.product].filter(Boolean).join(' ')) + '</span>' : '')]);
    rows.push(['Line', esc((d.port.acm ? 'USB CDC' : (d.port.baud || '?') + ' baud 8N1') + (d.port.driver ? ' · ' + d.port.driver : ''))]);
    if (d.how) rows.push(['Recognised by', esc(d.how)]);
    rows.push(['Data', esc(d.rx + ' bytes' + (d.lastRxAgoMs != null ? ', last ' + ago(d.lastRxAgoMs) : '') + (d.reconnects ? ' · reconnected ' + d.reconnects + '×' : ''))]);
    const q = d.detail || {};
    if (d.kind === 'quansheng') {
      rows.push(['Radio', esc([q.firmware ? 'firmware ' + q.firmware : q.legacy ? 'legacy (DP32G030) firmware' : null, q.console ? 'USB console' : 'UART (records only)', q.freq ? q.freq + ' MHz' : null].filter(Boolean).join(' · '))]);
      if (q.battery) rows.push(['Battery', esc(q.battery.pct + '% (' + (q.battery.mv / 1000).toFixed(2) + ' V)')]);
      if (q.nf_dbm != null) rows.push(['Noise floor', esc(q.nf_dbm + ' dBm, RSSI ' + q.rssi_dbm + ' dBm' + (q.squelch ? ', squelch open' : ''))]);
      if (q.stationTable) rows.push(['Station table', esc(q.stationTable)]);
      if (q.log) rows.push(['Flash log', esc(q.log.state + ' ' + q.log.count + '/' + q.log.cap)]);
      rows.push(['Decoded', esc(q.counts.dec + ' readings, ' + q.counts.bst + ' bursts (' + q.counts.undecoded + ' undecoded)')]);
      if (q.bootloader) rows.push(['Note', 'The radio is in its bootloader (waiting to be flashed).']);
    } else if (d.kind === 'ert-a2') {
      rows.push(['Wire format', esc(q.format === 'ascii' ? 'RS-232 ALERT2 ASCII (receiver clock, no RSSI)' : q.format === 'bin' ? 'USB binary (RSSI, no receiver clock)' : 'not seen yet')]);
      if (q.counts) rows.push(['Frames', esc(q.counts.frames + ' (' + q.counts.bad + ' would not decode), ' + q.counts.readings + ' readings')]);
      if (q.decoder) rows.push(['Decoder address', esc(q.decoder)]);
      if (q.receiverClockSkewS != null) rows.push(['Receiver clock', esc((q.receiverClockSkewS >= 0 ? '+' : '') + Math.round(q.receiverClockSkewS) + ' s from the network\'s')]);
      if (q.note) rows.push(['Note', esc(q.note)]);
    } else if (d.kind === 'gps') {
      rows.push(['Fix', esc(q.fix ? (q.fix.lat != null ? q.fix.lat.toFixed(6) + ', ' + q.fix.lon.toFixed(6) + ' ±' + q.fix.accuracy_m + ' m' : 'yes') + (q.fix.alt != null ? ', ' + q.fix.alt + ' m' : '') : 'none')]);
      rows.push(['Satellites', esc((q.sats ?? '—') + (q.hdop != null ? ', HDOP ' + q.hdop : ''))]);
    }
  }
  return kv(rows);
}

// A channel's last reading: legacy ALERT's with its votes, ALERT2's with no need of any (each block has its parity).
function decodeText(ld) {
  return ld.id + ' = ' + ld.value + ' (' + (ld.fmt === 'ALERT2' ? 'ALERT2' : ld.votes + ' votes') + ') ' + ago(Date.now() - ld.t);
}

function alert2Text(c) {
  return (c.alert2 || 0) + ' frame' + (c.alert2 === 1 ? '' : 's') + (c.alert2Bad ? ' (' + c.alert2Bad + ' more would not decode)' : '');
}

// A stick's channels, a row each: each one a receiver of its own.
function channelTable(d) {
  const unplugged = d.state === 'unplugged';
  const rows = d.channels.map(ch => {
    const lv = ch.level, c = ch.counts, ld = ch.lastDecode;
    const signal = !ch.inBand ? '<span style="color: var(--warn)">⚠ ' + esc(NO_FIT) + '</span>'
      : lv ? esc(lv.chDb + ' dB, floor ' + lv.nfDb + (lv.open ? ' · OPEN' : '')) : '<span class="dim">' + (unplugged ? '—' : 'starting…') + '</span>';
    return '<tr><td>' + esc(Channels.mhz(ch.freqHz)) + ' MHz' + (ch.recording ? ' <span class="dim small" title="Every burst kept as IQ: Settings → Recordings">● recording</span>' : '') + '</td><td>' + esc(FORMAT_NAMES[ch.format] || ch.format) + '</td><td><code class="small">' + esc(ch.pointId) + '</code></td>'
      + '<td>' + signal + '</td><td>' + esc(c.bursts + ' bursts, ' + c.decodes + ' readings' + (c.undecoded ? ', ' + c.undecoded + ' undecoded' : '')
        + (c.alert2 || c.alert2Bad ? ', ALERT2 ' + alert2Text(c) : '')) + '</td>'
      + '<td>' + (ld ? esc(decodeText(ld)) : '<span class="dim">—</span>') + '</td></tr>';
  });
  return '<div class="table-wrap chans"><table><thead><tr><th>Channel</th><th>Format</th><th>MegaNet receiver id</th><th>Signal</th><th>Heard</th><th>Last decode</th></tr></thead><tbody>'
    + rows.join('') + '</tbody></table></div>';
}

function drawSpectrum(c, d) {
  if (!c) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  const col = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const db = d.spectrum.db, lo = Math.min(...db), hi = Math.max(...db), span = Math.max(10, hi - lo);
  const rate = d.spectrum.rate, cHz = d.spectrum.centerHz, bottom = 14, ph = h - bottom;
  const X = (hz) => (0.5 + (hz - cHz) / rate) * w;
  g.font = '10.5px ' + col('--font');
  // The frequency along the bottom, at round steps.
  const stepHz = [10e3, 25e3, 50e3, 100e3, 200e3, 250e3, 500e3, 1e6].find(s => rate / s <= Math.max(2, w / 90)) || 1e6;
  g.strokeStyle = col('--line'); g.fillStyle = col('--dim'); g.textAlign = 'center'; g.lineWidth = 1;
  for (let f = Math.ceil((cHz - rate / 2) / stepHz) * stepHz; f <= cHz + rate / 2; f += stepHz) {
    const x = Math.round(X(f)) + 0.5;
    g.globalAlpha = 0.4; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ph); g.stroke(); g.globalAlpha = 1;
    const s = (f / 1e6).toFixed(stepHz < 100e3 ? 3 : stepHz < 1e6 ? 2 : 1);
    const tw = g.measureText(s).width;
    g.fillText(s, Math.min(w - tw / 2, Math.max(tw / 2, x)), h - 2);
  }
  g.strokeStyle = col('--ok');
  for (const hz of d.spectrum.channelsHz || [d.spectrum.channelHz]) {
    const cx = Math.round(X(hz)) + 0.5;
    g.globalAlpha = 0.8; g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, ph); g.stroke(); g.globalAlpha = 1;
  }
  g.strokeStyle = col('--accent'); g.lineWidth = 1.2; g.beginPath();
  db.forEach((v, i) => { const x = i / (db.length - 1) * w, y = ph - 4 - (v - lo) / span * (ph - 10); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.stroke();
  g.fillStyle = col('--dim'); g.textAlign = 'left';
  g.fillText(Math.round(hi) + ' dB', 4, 11); g.fillText(Math.round(lo) + ' dB', 4, ph - 4);
}

// ── settings ────────────────────────────────────────────────────────────────

async function loadConfig() {
  const r = await api('/api/config');
  S.config = r.config;
  fillForms();
}

// The bursts kept as IQ (Settings → Recordings), newest first, each a download.
async function loadRecordings() {
  const el = $('#rec-list');
  let r;
  try { r = await api('/api/recordings'); } catch (e) { el.textContent = 'Could not list them: ' + e.message; return; }
  const s = r.recordings, files = r.files;
  const head = '<p class="dim">' + (files.length ? s.files + ' kept, ' + s.mb + ' MB of ' + s.maxMb + (s.files > files.length ? ' — the newest ' + files.length + ' below' : '') : 'None kept yet.')
    + (s.freqHz.length ? ' Recording every burst on ' + esc(s.freqHz.map(f => Channels.mhz(f)).join(', ')) + ' MHz.' : ' Not recording.')
    + (s.skipped ? ' ' + s.skipped + ' not kept (the SD card nearly full).' : '') + '</p>';
  const row = (f) => '<tr><td>' + esc(f.t ? new Date(f.t).toLocaleString() : '') + '</td><td>' + esc(f.freqHz ? Channels.mhz(f.freqHz) : '') + '</td><td>' + esc(f.receiver || '')
    + '</td><td>' + esc(f.ms != null ? f.ms + ' ms' : '') + '</td><td>' + esc(f.peakDb != null ? f.peakDb + ' dBFS' : '') + '</td><td>' + (f.decoded || f.alert2 ? esc([f.decoded ? f.decoded + ' decoded' : '', f.alert2 ? f.alert2 + ' ALERT2 frame' + (f.alert2 === 1 ? '' : 's') : ''].filter(Boolean).join(', ')) : '<span class="dim">none decoded</span>')
    + '</td><td><a href="/api/recordings/' + encodeURIComponent(f.name) + '.iq8" download>IQ</a> · <a href="/api/recordings/' + encodeURIComponent(f.name) + '.json" download>info</a></td></tr>';
  el.innerHTML = head + (files.length ? '<div class="table-wrap"><table class="readings"><thead><tr><th>Heard</th><th>MHz</th><th>Receiver</th><th>Burst</th><th>Peak</th><th>Decoded</th><th></th></tr></thead><tbody>'
    + files.map(row).join('') + '</tbody></table></div>' : '');
}

function fillForms() {
  const c = S.config;
  if (!c) return;
  const fm = $('#f-meganet');
  fm.token.placeholder = c.meganet.tokenSet ? 'set (' + c.meganet.token + ') — type a new one to replace it' : 'mgn_…';
  fm.token.value = '';
  fm.name.value = c.name || '';
  fm.enabled.checked = c.meganet.enabled;
  fm.receptions.checked = c.meganet.receptions;

  const fl = $('#f-location');
  const src = c.location.source;
  $$('input[name=source]', fl).forEach(r => { r.checked = r.value === src; });
  fl.dataset.src = src;
  fl.latlon.value = c.location.lat != null && src === 'manual' ? c.location.lat + ', ' + c.location.lon : '';
  fl.stationq.value = src === 'station' ? (c.location.stationName || c.location.station) : '';
  $('#station-picked').textContent = src === 'station' && c.location.lat != null ? 'At ' + (c.location.stationName || c.location.station) + ' — ' + c.location.lat + ', ' + c.location.lon : '';
  fl.useGps.checked = c.location.useGps !== false;

  const fs = $('#f-sdr'), sd = c.receivers.sdr;
  fs.freq.value = (sd.freqHz / 1e6).toFixed(4);
  fs.more.value = Channels.text(sd.moreChannels, sd.format);
  fs.format.value = sd.format;
  fs.gain.value = sd.gainDb == null ? '' : sd.gainDb;
  fs.rate.value = String(sd.sampleRate);
  fs.ppm.value = sd.ppm;
  fs.squelch.value = sd.squelchDb;
  fs.enabled.checked = sd.enabled;
  fs.biasTee.checked = !!sd.biasTee;
  fs.alert2.checked = sd.alert2 !== false;
  renderSticks(true);

  $('#f-ports').autoDetect.checked = c.receivers.autoDetect;
  renderPortOverrides(true);

  const fa = $('#f-audio');
  fa.mode.value = c.audio.enabled ? c.audio.mode : 'off';
  fa.volume.value = c.audio.volume;
  if (!fa.device.options.length) fa.device.innerHTML = '<option value="' + esc(c.audio.device) + '">' + esc(c.audio.device === 'default' ? 'System default' : c.audio.device) + '</option>';
  loadAudioDevices();

  if (c.hotspot) {
    const fh = $('#f-hotspot');
    $$('input[name=mode]', fh).forEach(r => { r.checked = r.value === c.hotspot.mode; });
    fh.ssid.value = c.hotspot.ssid || '';
    fh.password.value = c.hotspot.password || '';
  }
  const fr = $('#f-record'), rec = c.receivers.record || { freqHz: [], maxMb: 256 };
  fr.freqs.value = Channels.text(rec.freqHz.map(freqHz => ({ freqHz })), null);
  fr.maxMb.value = rec.maxMb;

  $('#f-display').kiosk.value = c.kiosk.mode;
  if (c.remote) $('#f-remote').mode.value = c.remote.mode;
  $('#f-system').timezone.value = c.system.timezone || (S.status ? S.status.clock.timezone : '');
  $('#pw-state').textContent = c.web.passwordSet
    ? 'A password is set. Other computers must log in to change settings; this Pi\'s own screen does not.'
    : 'No password yet: anyone on this network can change these settings. Set one now.';
  if (S.status) $('#hostname').value = S.status.system.hostname;
}

// One row per port: drawn once, filled from the settings when they load or
// are saved (force), its "who" kept current — so what is being typed stays.
function renderPortOverrides(force) {
  const c = S.config;
  if (!c || !S.status) return;
  const overrides = c.receivers.ports || [];
  const ports = S.status.devices.ports;
  const keys = [...new Set(ports.map(p => p.port.byId || p.port.dev).concat(overrides.map(o => o.match)))];
  keyedRows($('#port-overrides'), keys, {
    key: k => k, cls: 'port-row', force,
    make: '<div class="who"></div>'
      + '<label>Type<select name="ptype">' + ['auto', 'quansheng', 'ert-a2', 'gps', 'ignore'].map(t => '<option>' + t + '</option>').join('') + '</select></label>'
      + '<label>Baud<select name="pbaud">' + [0, 4800, 9600, 19200, 38400, 57600, 115200].map(b => '<option value="' + b + '">' + (b || 'auto') + '</option>').join('') + '</select></label>'
      + '<label>Name<input name="pname" placeholder="automatic"></label>',
    empty: '<div class="dim small none">No serial ports seen yet.</div>',
    fill: (row, k) => {
      const o = overrides.find(x => x.match === k) || { type: 'auto', baud: 0, name: '' };
      $('[name=ptype]', row).value = o.type || 'auto';
      $('[name=pbaud]', row).value = String(o.baud || 0);
      $('[name=pname]', row).value = o.name || '';
    },
    update: (row, k) => {
      const live = ports.find(p => (p.port.byId || p.port.dev) === k);
      setHtml($('.who', row), '<b>' + esc(live ? live.name : '(not plugged in)') + '</b><br><code class="small">' + esc(k) + '</code>');
    },
  });
}

// ── each stick's own settings (Settings → RTL-SDR) ─────────────────────────

const STICK_ROW = '<div class="stick-head"><span class="who"></span><span class="act"></span></div>'
  + '<div class="cols">'
  + '<label>Name <input name="sname" maxlength="60"></label>'
  + '<label>Frequency, MHz <input name="sfreq" type="number" step="0.0001" min="24" max="1766"></label>'
  + '<label>More channels, MHz <input name="smore" autocomplete="off" spellcheck="false" title="Other channels for this stick to hear at once, e.g. 151.525, 152.4 EIF; none for only its own frequency; blank for the setting above"></label>'
  + '<label>Frame format <select name="sformat"><option value=""></option>'
  + Object.entries(FORMAT_NAMES).map(([v, t]) => '<option value="' + v + '">' + t + '</option>').join('') + '</select></label>'
  + '<label>Gain, dB <input name="sgain" title="A number, auto for the tuner\'s AGC, or blank for the setting above"></label>'
  + '</div>'
  + '<details><summary>More for this stick</summary><div class="cols">'
  + '<label>Frequency correction, ppm <input name="sppm" type="number" step="1" min="-200" max="200"></label>'
  + '<label>Squelch, dB over the noise floor <input name="ssquelch" type="number" step="1" min="2" max="40"></label>'
  + '<label>Bias tee <select name="sbias"><option value=""></option><option value="on">On (4.5 V on the antenna socket)</option><option value="off">Off</option></select></label>'
  + '</div></details>'
  + '<label class="check"><input type="checkbox" name="son"> Use this stick</label>';

// A stick's own entry in receivers.sdrDevices — by key, or 0.4's by serial.
function ownEntry(d) {
  const list = (S.config && S.config.receivers.sdrDevices) || [];
  return list.find(e => e.key === d.key) || list.find(e => !e.key && e.serial && e.serial === d.device.serial) || null;
}

function stickWhoHtml(d) {
  const bits = [stateLabel(d.state)];
  if (d.model || d.device.product) bits.push(d.model || d.device.product);
  bits.push('USB port ' + (d.device.port || '?'));
  if (d.device.serial) bits.push('SN ' + d.device.serial);
  if (d.state === 'unplugged' && d.lastSeen) bits.push('last seen ' + ago(Date.now() - d.lastSeen));
  return '<span class="dot ' + esc(d.state) + '"></span><b>' + esc(d.name) + '</b><span class="dim small">' + esc(bits.join(' · ')) + '</span>';
}

function fillStick(row, d) {
  const sd = S.config.receivers.sdr, own = ownEntry(d) || {};
  const put = (n, v, hint) => { const el = $('[name=' + n + ']', row); el.value = v; if (hint != null) el.placeholder = hint; };
  put('sname', own.name || '', 'RTL-SDR' + (d.n > 1 ? ' ' + d.n : ''));
  put('sfreq', own.freqHz != null ? (own.freqHz / 1e6).toFixed(4) : '', (sd.freqHz / 1e6).toFixed(4));
  put('smore', own.moreChannels ? (own.moreChannels.length ? Channels.text(own.moreChannels, own.format || sd.format) : 'none') : '',
    Channels.text(sd.moreChannels, own.format || sd.format) || 'none');
  $('[name=sformat]', row).options[0].textContent = 'As above — ' + (FORMAT_NAMES[sd.format] || sd.format);
  put('sformat', own.format || '');
  put('sgain', own.gainDb === undefined ? '' : own.gainDb === null ? 'auto' : String(own.gainDb), sd.gainDb == null ? 'auto' : String(sd.gainDb));
  put('sppm', own.ppm != null ? String(own.ppm) : '', String(sd.ppm || 0));
  put('ssquelch', own.squelchDb != null ? String(own.squelchDb) : '', String(sd.squelchDb));
  $('[name=sbias]', row).options[0].textContent = 'As above — ' + (sd.biasTee ? 'on' : 'off');
  put('sbias', own.biasTee === undefined ? '' : own.biasTee ? 'on' : 'off');
  $('[name=son]', row).checked = own.enabled !== false;
  if (own.ppm != null || own.squelchDb != null || own.biasTee !== undefined) $('details', row).open = true;
}

function renderSticks(force) {
  if (!S.config || !S.status) return;
  keyedRows($('#sdr-sticks'), S.status.devices.sdrs, {
    key: d => d.key, cls: 'stick-row', make: STICK_ROW, force,
    empty: '<div class="dim small none">No sticks yet. Each RTL-SDR stick plugged in is listed here, to give it settings of its own.</div>',
    fill: fillStick,
    update: (row, d) => {
      row.dataset.serial = d.device.serial || '';
      row.dataset.name = d.name;
      setHtml($('.who', row), stickWhoHtml(d));
      setHtml($('.act', row), d.state === 'unplugged'
        ? '<button type="button" class="ghost small danger" data-forget="' + esc(d.key) + '" data-name="' + esc(d.name) + '">Remove</button>' : '');
    },
  });
}

// The stick rows → receivers.sdrDevices: for each stick, only what it sets
// for itself. Entries for sticks not listed are kept; 0.4's by-serial ones
// become the listed sticks' own.
function stickEntries() {
  const rows = $$('#sdr-sticks .stick-row');
  const keys = new Set(rows.map(r => r.dataset.key)), serials = new Set(rows.map(r => r.dataset.serial).filter(Boolean));
  const list = ((S.config && S.config.receivers.sdrDevices) || []).filter(e => (e.key ? !keys.has(e.key) : !serials.has(e.serial)));
  for (const row of rows) {
    const v = (n) => $('[name=' + n + ']', row).value.trim();
    const who = row.dataset.name + ': ';
    const e = { key: row.dataset.key };
    if (v('sname')) e.name = v('sname');
    if (v('sfreq')) { const mhz = Number(v('sfreq')); if (!(mhz >= 24 && mhz <= 1766)) return { error: who + 'a frequency of 24–1766 MHz' }; e.freqHz = Math.round(mhz * 1e6); }
    if (v('smore')) { const p = Channels.parse(v('smore')); if (p.error) return { error: who + 'more channels: ' + p.error }; e.moreChannels = p.channels; }
    if (v('sformat')) e.format = v('sformat');
    if (v('sgain')) {
      const g = v('sgain');
      if (/^(auto|agc)$/i.test(g)) e.gainDb = null;
      else { if (!(Number(g) >= 0 && Number(g) <= 60)) return { error: who + 'a gain of 0–60 dB, or auto' }; e.gainDb = Number(g); }
    }
    if (v('sppm')) { const p = Number(v('sppm')); if (!(p >= -200 && p <= 200)) return { error: who + 'a correction of -200…200 ppm' }; e.ppm = p; }
    if (v('ssquelch')) { const q = Number(v('ssquelch')); if (!(q >= 2 && q <= 40)) return { error: who + 'a squelch of 2–40 dB' }; e.squelchDb = q; }
    if (v('sbias')) e.biasTee = v('sbias') === 'on';
    if (!$('[name=son]', row).checked) e.enabled = false;
    if (Object.keys(e).length > 1) list.push(e);
  }
  return { list };
}

async function loadAudioDevices() {
  try {
    const r = await api('/api/audio/devices');
    const sel = $('#f-audio').device, cur = S.config.audio.device;
    const list = r.devices.some(d => d.id === cur) ? r.devices : r.devices.concat([{ id: cur, label: cur }]);
    sel.innerHTML = list.map(d => '<option value="' + esc(d.id) + '"' + (d.id === cur ? ' selected' : '') + '>' + esc(d.label) + '</option>').join('');
  } catch (_) {}
}

async function save(form, patch, extra) {
  try {
    const r = await api('/api/config', { method: 'PUT', body: Object.assign({ config: patch }, extra || {}) });
    S.config = r.config;
    flash(form, r.changed.length ? 'Saved.' : 'No change.', true);
    fillForms();
    refresh();
  } catch (e) { flash(form, e.message, false); }
}

function renderHotspot() {
  const h = S.status && S.status.hotspot, el = $('#hs-state');
  if (!h || !el) return;
  const ph = $('#f-hotspot').ssid;
  ph.placeholder = h.ssid;
  el.textContent = (h.available === false ? 'Not available — ' + (h.error || 'no Wi-Fi') : h.active ? 'Up: “' + h.ssid + '”' + (h.clients ? ', ' + h.clients + ' connected' : '') + '. ' + (h.note || '') : 'Down. ' + (h.note || ''))
    + (h.available !== false && h.error ? ' — ' + h.error : '') + (h.country === '00' ? ' The Wi-Fi country is not set (wifi_country on the SD card): some channels may be refused.' : '');
}

function wireSettings() {
  $('#f-hotspot').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const mode = ($$('input[name=mode]', f).find(r => r.checked) || {}).value || 'auto';
    save(f, { hotspot: { mode, ssid: f.ssid.value.trim(), password: f.password.value.trim() } });
  });
  $('#f-meganet').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const patch = { name: f.name.value.trim(), meganet: { enabled: f.enabled.checked, receptions: f.receptions.checked } };
    if (f.token.value.trim()) patch.meganet.token = f.token.value.trim();
    save(f, patch);
  });
  $('#token-test').addEventListener('click', async () => {
    const f = $('#f-meganet'), out = $('#token-result');
    out.textContent = 'Checking…'; out.className = 'small';
    try {
      const r = await api('/api/token/test', { method: 'POST', body: { token: f.token.value.trim() } });
      out.textContent = r.ok ? '✓ MegaNet accepts it' + (r.label ? ' — ingest point "' + r.label + '"' : '') + (r.note ? '. ' + r.note : '') : '✗ ' + r.error;
      out.className = 'small status ' + (r.ok ? 'ok' : 'bad');
    } catch (e) { out.textContent = e.message; out.className = 'small status bad'; }
  });
  $('#send-now').addEventListener('click', () => api('/api/send-now', { method: 'POST', body: {} }).then(() => flash($('#f-meganet'), 'Sending now.', true)).catch(e => flash($('#f-meganet'), e.message, false)));

  const fl = $('#f-location');
  $$('input[name=source]', fl).forEach(r => r.addEventListener('change', () => { fl.dataset.src = r.value; }));
  let stationHits = [];
  fl.stationq.addEventListener('input', debounce(async () => {
    const q = fl.stationq.value.trim();
    if (q.length < 2) return;
    try {
      const r = await api('/api/stations/search?q=' + encodeURIComponent(q));
      stationHits = r.stations;
      $('#station-list').innerHTML = r.stations.map(s => '<option value="' + esc(s.name) + '">' + esc(s.number + ' · ' + s.id) + '</option>').join('');
      if (!r.register.count) $('#station-picked').textContent = 'The station register has not downloaded yet (it needs the internet once).';
    } catch (_) {}
  }, 250));
  $('#geo').addEventListener('click', () => {
    if (!navigator.geolocation) { flash(fl, 'This browser cannot give a location.', false); return; }
    flash(fl, 'Asking the browser…', true);
    navigator.geolocation.getCurrentPosition(p => { fl.latlon.value = p.coords.latitude.toFixed(5) + ', ' + p.coords.longitude.toFixed(5); flash(fl, 'Got it — ±' + Math.round(p.coords.accuracy) + ' m. Save to keep it.', true); },
      e => flash(fl, 'No location from this browser (' + (e.message || 'blocked') + '). Browsers only give it to https pages or this Pi\'s own screen.', false), { timeout: 15000 });
  });
  fl.addEventListener('submit', (e) => {
    e.preventDefault();
    const src = ($('input[name=source]:checked', fl) || {}).value || 'none';
    const loc = { source: src, useGps: fl.useGps.checked };
    if (src === 'manual') {
      const m = /(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/.exec(fl.latlon.value);
      if (!m) { flash(fl, 'Type the location as "latitude, longitude", e.g. -27.4698, 153.0251', false); return; }
      let lat = Number(m[1]), lon = Number(m[2]);
      if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) [lat, lon] = [lon, lat];
      Object.assign(loc, { lat, lon, station: '', stationName: '' });
    } else if (src === 'station') {
      const q = fl.stationq.value.trim().toLowerCase();
      const hit = stationHits.find(s => s.name.toLowerCase() === q) || (stationHits.length === 1 ? stationHits[0] : null);
      if (!hit && !(S.config.location.source === 'station' && q === String(S.config.location.stationName || '').toLowerCase())) { flash(fl, 'Pick one station from the list.', false); return; }
      if (hit) {
        if (hit.lat == null) { flash(fl, hit.name + ' has no coordinates on file.', false); return; }
        Object.assign(loc, { station: hit.id, stationName: hit.name, lat: hit.lat, lon: hit.lon });
      }
    }
    save(fl, { location: loc });
  });

  $('#f-sdr').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const g = f.gain.value.trim();
    const more = Channels.parse(f.more.value);
    if (more.error) { flash(f, 'More channels: ' + more.error, false); return; }
    const sticks = stickEntries();
    if (sticks.error) { flash(f, sticks.error, false); return; }
    save(f, { receivers: { sdr: { freqHz: Math.round(Number(f.freq.value) * 1e6), moreChannels: more.channels, format: f.format.value, gainDb: g === '' || /auto/i.test(g) ? null : Number(g),
      sampleRate: Number(f.rate.value), ppm: Number(f.ppm.value) || 0, squelchDb: Number(f.squelch.value) || 8, enabled: f.enabled.checked, biasTee: f.biasTee.checked,
      alert2: f.alert2.checked },
    sdrDevices: sticks.list } });
  });

  $('#f-ports').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const ports = $$('.port-row', f).map(row => ({ match: row.dataset.key, type: $('[name=ptype]', row).value, baud: Number($('[name=pbaud]', row).value) || 0, name: $('[name=pname]', row).value.trim() }))
      .filter(p => p.type !== 'auto' || p.baud || p.name);
    save(f, { receivers: { autoDetect: f.autoDetect.checked, ports } });
  });

  $('#f-audio').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    save(f, { audio: { enabled: f.mode.value !== 'off', mode: f.mode.value === 'off' ? S.config.audio.mode : f.mode.value, device: f.device.value, volume: Number(f.volume.value) } });
  });
  $$('#f-audio [data-test]').forEach(b => b.addEventListener('click', () => api('/api/audio/test', { method: 'POST', body: { kind: b.dataset.test } }).catch(e => flash($('#f-audio'), e.message, false))));

  $('#f-record').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const p = Channels.parse(f.freqs.value);
    if (p.error) { flash(f, 'Record on: ' + p.error, false); return; }
    await save(f, { receivers: { record: { freqHz: [...new Set(p.channels.map(ch => ch.freqHz))], maxMb: Number(f.maxMb.value) || 256 } } });
    loadRecordings();
  });
  $('#rec-refresh').addEventListener('click', () => loadRecordings());
  $('#rec-clear').addEventListener('click', async () => {
    if (!confirm('Delete every recording on this Pi?')) return;
    try { const r = await api('/api/recordings/delete', { method: 'POST', body: { all: true } }); flash($('#f-record'), r.removed + ' deleted.', true); } catch (err) { flash($('#f-record'), err.message, false); }
    loadRecordings();
  });

  $('#f-display').addEventListener('submit', (e) => { e.preventDefault(); save(e.target, { kiosk: { mode: e.target.kiosk.value } }); });
  $('#f-system').addEventListener('submit', (e) => { e.preventDefault(); save(e.target, { system: { timezone: e.target.timezone.value.trim() } }); });
  $$('#f-system [data-power]').forEach(b => b.addEventListener('click', async () => {
    const what = { reboot: 'Reboot the Pi', poweroff: 'Shut the Pi down (it will need its power cycled to come back)', 'restart-agent': 'Restart the agent' }[b.dataset.power];
    if (!confirm(what + '?')) return;
    try { await api('/api/system/power', { method: 'POST', body: { action: b.dataset.power } }); flash($('#f-system'), 'Done — this page reconnects by itself.', true); } catch (e) { flash($('#f-system'), e.message, false); }
  }));
  bindUpdates();
  bindRemote();

  $('#wifi-scan').addEventListener('click', async () => {
    const box = $('#wifi-list'); box.innerHTML = '<div class="dim small">Scanning…</div>';
    try {
      const r = await api('/api/network/wifi');
      if (!r.ok) { box.innerHTML = '<div class="status bad small">' + esc(r.error || 'scan failed') + '</div>'; return; }
      box.innerHTML = r.networks.map(n => '<div class="wifi"><span>' + (n.inUse ? '✓ ' : '') + '<b>' + esc(n.ssid) + '</b> <span class="dim small">' + n.signal + '% ' + esc(n.security) + '</span></span>'
        + '<button class="ghost" data-ssid="' + esc(n.ssid) + '" data-open="' + (n.security ? '' : '1') + '">Join</button></div>').join('') || '<div class="dim small">No networks found.</div>';
      $$('#wifi-list [data-ssid]').forEach(b => b.addEventListener('click', async () => {
        const pw = b.dataset.open ? '' : prompt('Password for ' + b.dataset.ssid);
        if (pw === null) return;
        b.disabled = true; b.textContent = 'Joining…';
        try { const r2 = await api('/api/network/wifi', { method: 'POST', body: { ssid: b.dataset.ssid, password: pw } }); b.textContent = r2.ok ? 'Joined' : 'Failed'; if (!r2.ok) alert(r2.message); }
        catch (e) { b.textContent = 'Failed'; alert(e.message); }
        loadNetwork();
      }));
    } catch (e) { box.innerHTML = '<div class="status bad small">' + esc(e.message) + '</div>'; }
  });
  $('#hostname-save').addEventListener('click', async () => {
    const st = $('#hostname-status');
    try { const r = await api('/api/system/hostname', { method: 'POST', body: { hostname: $('#hostname').value.trim() } }); st.textContent = r.ok ? 'Set — the Pi answers to the new name after a reboot.' : r.message; st.className = 'status small ' + (r.ok ? 'ok' : 'bad'); }
    catch (e) { st.textContent = e.message; st.className = 'status small bad'; }
  });
  $('#pw-save').addEventListener('click', async () => {
    const st = $('#pw-status');
    try { await api('/api/password', { method: 'POST', body: { password: $('#pw1').value } }); $('#pw1').value = ''; st.textContent = 'Password set.'; st.className = 'status small ok'; loadConfig(); }
    catch (e) { st.textContent = e.message; st.className = 'status small bad'; }
  });
  $('#rescan').addEventListener('click', () => api('/api/devices/rescan', { method: 'POST', body: {} }).then(refresh));
  $('#rx-full').addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-restart]');
    if (b) api('/api/devices/restart', { method: 'POST', body: { key: b.dataset.restart } }).then(refresh).catch(err => alert(err.message));
  });
  // Remove an unplugged receiver (Receivers, Settings → RTL-SDR): forgotten.
  document.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('[data-forget]');
    if (!b || b.disabled) return;
    e.preventDefault();
    if (!confirm('Remove ' + b.dataset.name + '?\n\nThe Pi forgets it: its name, its own settings and its MegaNet receiver id. If it is plugged in again, it is found as a new receiver.')) return;
    b.disabled = true;
    try {
      await api('/api/devices/forget', { method: 'POST', body: { key: b.dataset.forget } });
      if (S.config) S.config.receivers.sdrDevices = (S.config.receivers.sdrDevices || []).filter(x => x.key !== b.dataset.forget);
    } catch (err) { alert(err.message); b.disabled = false; }
    refresh();
  });
}

async function loadNetwork() {
  try {
    const r = await api('/api/network');
    $('#net-status').textContent = r.ok ? r.text.trim() : (r.addresses.map(a => a.iface + ': ' + a.address).join('\n') || 'no address') + (r.error ? '\n(' + r.error + ')' : '');
  } catch (e) { $('#net-status').textContent = e.message; }
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ── log ─────────────────────────────────────────────────────────────────────

function renderLog() {
  const el = $('#log');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  el.innerHTML = S.logLines.slice(-400).map(l => '<span class="' + l.level + '">' + esc(new Date(l.t).toLocaleTimeString() + ' ' + l.level.toUpperCase().padEnd(5) + ' [' + l.tag + '] ' + l.msg) + '</span>').join('\n');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// ── login ───────────────────────────────────────────────────────────────────

function askLogin() {
  const d = $('#login');
  if (!d.open) d.showModal();
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#login-pw').value } });
    $('#login').close(); $('#login-pw').value = '';
    await refresh(); loadConfig(); connectEvents();
  } catch (err) { $('#login-status').textContent = err.message; $('#login-status').className = 'status small bad'; }
});

// ── site survey ─────────────────────────────────────────────────────────────
// What this Pi heard at a candidate site, tallied here so it can be read on
// site with no network; and whether it is ready to be left there.

function durText(ms) {
  if (ms == null) return '—';
  const h = ms / 3600e3;
  return h < 1 ? Math.round(ms / 60000) + ' min' : h < 48 ? h.toFixed(h < 10 ? 1 : 0) + ' h' : (h / 24).toFixed(1) + ' days';
}
function whenText(t) { return t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'time not known yet'; }

let svLoading = false, svAt = 0;
async function loadSurvey(force) {
  if (svLoading || (!force && Date.now() - svAt < 5000)) return;
  svLoading = true;
  try { S.survey = await api('/api/survey'); svAt = Date.now(); renderSurvey(); } catch (_) {} finally { svLoading = false; }
}

function renderSurvey() {
  const v = S.survey;
  if (!v) return;
  const run = v.state === 'running', armed = v.state === 'armed';
  let st;
  if (run) {
    st = '<div class="sv-big"><span class="name">' + esc(v.name) + '</span><span class="chip ok">surveying</span>'
      + '<span class="dim">listening ' + durText(v.elapsedMs) + (v.endsInMs != null ? ' · ends in ' + durText(v.endsInMs) : ' · until ended') + '</span></div>'
      + '<div class="small">Started ' + esc(whenText(v.startedAt)) + (v.where ? ' at ' + v.where.lat.toFixed(5) + ', ' + v.where.lon.toFixed(5) + ' (' + esc(v.where.source) + ')' : ' — <b>no location</b>')
      + ' · ' + v.totals.ok + ' good frames, ' + v.totals.bad + ' bad, ' + v.totals.undecoded + ' undecoded bursts'
      + (v.readings ? ' · readings go to MegaNet too' : ' · readings stay here (receptions go)') + '</div>'
      + (v.totals.untimed ? '<div class="small">' + v.totals.untimed + ' heard before the time was known — kept, and timed once it is.</div>' : '')
      + '<div class="row-actions"><button type="button" class="ghost danger" id="sv-end">End the survey</button><span class="dim small">Survey <span class="mono">' + esc(v.id) + '</span></span></div>';
  } else if (armed) {
    st = '<div class="sv-big"><span class="name">' + esc(v.name) + '</span><span class="chip warn">starts at the next power-up</span></div>'
      + '<div class="small">Shut the Pi down, take it to the site, and switch it on: it starts listening then, for ' + (v.hours ? v.hours + ' h' : 'as long as it runs') + '.</div>'
      + '<div class="row-actions"><button type="button" class="ghost" id="sv-end">Do not start it</button></div>';
  } else if (v.state === 'ended') {
    st = '<div class="sv-big"><span class="name">' + esc(v.name) + '</span><span class="chip">ended</span><span class="dim">' + esc(v.endedWhy || '') + '</span></div>'
      + '<div class="small">Listened ' + durText(v.elapsedMs) + ' · ' + v.totals.ok + ' good frames from ' + (v.stations || []).length + ' addresses. '
      + 'What it heard goes to MegaNet as receptions once this Pi is on a network with a token (' + esc(waitingText()) + ').</div>';
  } else st = '<p class="dim">No survey yet.</p>';
  setHtml($('#sv-state'), st);
  $('#sv-form-h').textContent = run ? 'Start a different survey (ends this one)' : armed ? 'Arm a different survey' : 'Start a survey';
  const end = $('#sv-end');
  if (end && !end.dataset.wired) {
    end.dataset.wired = '1';
    end.addEventListener('click', () => {
      if (run && !confirm('End the survey "' + v.name + '"? What it heard is kept and still goes to MegaNet.')) return;
      api('/api/survey', { method: 'POST', body: { action: 'end' } }).then(r => { S.survey = r; renderSurvey(); }).catch(e => alert(e.message));
    });
  }

  setHtml($('#sv-ready'), (v.readiness || []).map(c => '<div class="sv-check"><span class="dot ' + c.level + '" title="' + c.level + '"></span><b>' + esc(c.label)
    + '</b><span class="d">' + esc(c.detail || '') + '</span></div>').join(''));

  const rows = v.stations || [];
  $('#sv-count').textContent = rows.length ? rows.length + ' addresses' : '';
  const freqOf = (pid) => { const p = v.points && v.points[pid]; return p && p.freq_mhz ? p.freq_mhz + ' MHz' : pid.replace(/^rpi-[0-9a-f]+-/, ''); };
  const lvl = (x, u) => x == null ? '—' : x + ' ' + (u || '');
  setHtml($('#sv-rows'), rows.length ? rows.map(r => '<tr><td class="st">' + (r.station ? esc(r.station.name) + (r.station.km != null ? ' <span class="dim small">' + r.station.km.toFixed(r.station.km < 10 ? 1 : 0) + ' km</span>' : '')
      + (r.shared ? ' <span class="dim small">(+' + (r.shared - 1) + ' share it)</span>' : '') : '<span class="dim">not in the register</span>') + '</td>'
    + '<td class="num">' + r.alert_id + '</td><td class="num">' + r.ok + '</td><td class="num">' + (r.bad || '') + '</td>'
    + '<td>' + esc(r.last ? ago(v.now - r.last) : '—') + '</td><td class="num">' + esc(lvl(r.level.p50, r.unit)) + '</td>'
    + '<td class="num dim">' + (r.level.p10 == null ? '' : r.level.p10 + ' … ' + r.level.p90) + '</td><td class="num">' + (r.snr == null ? '—' : r.snr + ' dB') + '</td>'
    + '<td class="small">' + esc(r.points.map(freqOf).join(', ')) + '</td></tr>').join('')
    : '<tr class="none"><td colspan="9" class="dim">' + (run ? 'Nothing heard yet — frames appear here as they are decoded.' : 'No survey has heard anything yet.') + '</td></tr>');

  const past = v.history || [];
  $('#sv-past-card').hidden = !past.length;
  setHtml($('#sv-past'), past.map(h => '<tr><td>' + esc(h.name) + ' <span class="dim small mono">' + esc(h.id) + '</span></td><td>' + esc(whenText(h.startedAt)) + '</td><td>'
    + durText(h.elapsedMs) + '</td><td class="num">' + (h.totals ? h.totals.ok : 0) + '</td><td class="num">' + (h.addresses || 0) + '</td><td class="small">' + esc(h.endedWhy || '') + '</td></tr>').join(''));
}

function waitingText() {
  const m = S.status && S.status.meganet;
  if (!m) return '';
  const n = m.queued + m.receptionsQueued + m.waitingForClock;
  return n ? n.toLocaleString() + ' waiting on the card, ' + m.queueMb + ' MB' : 'nothing waiting';
}

function wireSurvey() {
  const f = $('#f-survey');
  $$('button[data-when]', f).forEach(b => b.addEventListener('click', async () => {
    const name = f.name.value.trim();
    if (!name) { flash(f, 'Give the site a name first.', false); f.name.focus(); return; }
    try {
      S.survey = await api('/api/survey', { method: 'POST', body: { action: 'start', name, hours: Number(f.hours.value), readings: f.readings.checked, when: b.dataset.when } });
      flash(f, b.dataset.when === 'boot' ? 'Armed: it starts when the Pi is next switched on.' : 'Survey started.', true);
      renderSurvey(); refresh();
    } catch (e) { flash(f, e.message, false); }
  }));
}

// ── live ────────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    S.status = await api('/api/status');
    collectSpectra();
    renderHeader(); renderStats();
    renderCharts();
    if (S.tab === 'survey') loadSurvey();
    if (S.tab === 'settings' && S.config) { renderPortOverrides(); renderSticks(); renderRemote(); renderHotspot(); }
  } catch (e) {
    $('#host').textContent = 'not connected — ' + e.message;
  }
}

function connectEvents() {
  if (S.sse) S.sse.close();
  const es = new EventSource('/api/events');
  S.sse = es;
  es.addEventListener('reading', (e) => { S.readings.unshift(JSON.parse(e.data)); if (S.readings.length > 500) S.readings.length = 500; renderReadings(true); renderCharts(); });
  es.addEventListener('burst', (e) => { S.bursts.unshift(JSON.parse(e.data)); if (S.bursts.length > 2000) S.bursts.length = 2000; renderCharts(); });
  es.addEventListener('tick', () => refresh());
  es.addEventListener('devices', () => refresh());
  // Approved: the settings page shows the token as set, without a reload.
  es.addEventListener('token-request', (e) => {
    let t = null; try { t = JSON.parse(e.data); } catch (_) {}
    refresh();
    if (t && t.last && t.last.status === 'approved' && S.tab === 'settings') loadConfig().catch(() => {});
  });
  es.addEventListener('remote', () => { if (S.tab === 'settings') refresh(); });
  es.addEventListener('survey', () => { refresh(); if (S.tab === 'survey') loadSurvey(true); });
  es.addEventListener('log', (e) => { S.logLines.push(JSON.parse(e.data)); if (S.logLines.length > 600) S.logLines.splice(0, 100); if (S.tab === 'log') renderLog(); });
  es.onerror = () => { $('#host').textContent = 'reconnecting…'; };
}

// ── software updates ────────────────────────────────────────────────────────

const UPDATE_STATES = { ok: 'Updated', current: 'Up to date', failed: 'Update failed', 'rolled-back': 'Update rolled back', running: 'Updating' };

async function loadUpdate() {
  let u;
  try { u = await api('/api/system/update'); } catch (_) { return null; }
  const el = $('#update-state'), auto = $('#update-auto');
  auto.disabled = !u.available; auto.checked = !!u.auto;
  if (!u.available) { el.textContent = 'Updates are managed by the Pi\'s system helper, which is not installed here' + (u.error ? ' (' + u.error + ')' : '') + '.'; return u; }
  const l = u.last;
  const last = l ? (UPDATE_STATES[l.state] || l.state) + ' ' + ago(Date.now() - l.at * 1000) + ': ' + l.message : '';
  el.textContent = u.running ? 'Installing an update now — the dashboard drops out for a moment while the agent restarts.' + (l && l.state === 'running' ? ' ' + l.message : '') : last;
  el.className = 'small ' + (u.running ? '' : l && (l.state === 'failed' || l.state === 'rolled-back') ? 'status bad' : '');
  $('#update-install').disabled = u.running;
  return u;
}

// While an install runs: poll, ride out the agent restarting, and reload the
// page once it is done so the new version's page is the one on screen.
let updatePoll = null;
function followUpdate() {
  if (updatePoll) return;
  const from = S.status && S.status.version;
  let seenRunning = false;
  updatePoll = setInterval(async () => {
    const u = await loadUpdate();
    if (!u) { $('#update-state').textContent = 'The agent is restarting with the new version…'; return; }
    if (u.running) { seenRunning = true; return; }
    if (!seenRunning && !(u.last && u.last.state !== 'running')) return;
    clearInterval(updatePoll); updatePoll = null;
    const v = await api('/api/status').then(s => s.version).catch(() => null);
    if (v && from && v !== from) location.reload();
  }, 3000);
}

function bindUpdates() {
  $('#update').addEventListener('click', async () => {
    const out = $('#update-out'); out.hidden = false; out.textContent = 'Checking…';
    try {
      const r = await api('/api/system/update', { method: 'POST', body: {} });
      out.textContent = r.message || (r.ok ? 'Done.' : 'Failed.');
      $('#update-install').hidden = !/is available/.test(r.message || '');
    } catch (e) { out.textContent = e.message; }
  });
  $('#update-install').addEventListener('click', async () => {
    if (!confirm('Install the latest RPi ALERT now? The agent restarts, so a burst may be missed during the minute or so it takes.')) return;
    try {
      await api('/api/system/update/install', { method: 'POST', body: {} });
      $('#update-install').hidden = true; $('#update-out').hidden = true;
      $('#update-state').textContent = 'Starting the update…';
      followUpdate();
    } catch (e) { flash($('#f-system'), e.message, false); }
  });
  $('#update-auto').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try { await api('/api/system/update/auto', { method: 'POST', body: { on } }); flash($('#f-system'), 'Automatic updates ' + (on ? 'on' : 'off') + '.', true); }
    catch (err) { e.target.checked = !on; flash($('#f-system'), err.message, false); }
  });
}

// ── remote management (MegaNet's Base Stations tab) ─────────────────────────

const REMOTE_STATES = {
  ok: 'checking in', starting: 'starting', 'no-token': 'waiting for a MegaNet token', off: 'off — this base station does not check in',
  unsupported: 'MegaNet does not take check-ins yet', refused: 'MegaNet refused the ingest token', error: 'cannot reach MegaNet just now',
};

function renderRemote() {
  const r = S.status && S.status.remote;
  if (!r) return;
  const bits = [REMOTE_STATES[r.state] || r.state];
  if (r.state === 'ok' && r.lastOkAt) bits.push('last ' + ago(Date.now() - r.lastOkAt));
  if (r.state === 'ok' && r.label) bits.push('as “' + r.label + '”');
  if (r.watch && r.state === 'ok') bits.push('an administrator has it open, so it checks in every few seconds');
  if (r.lastError && r.state !== 'ok') bits.push(r.lastError);
  const st = $('#remote-state');
  st.textContent = 'Now: ' + bits.join(' · ') + '.';
  st.className = 'small ' + (r.state === 'refused' || r.state === 'error' ? 'status bad' : '');
  const hist = (r.history || []);
  setHtml($('#remote-history'), hist.length
    ? '<div class="small dim">Asked from MegaNet:</div><ul class="small remote-history">' + hist.map(h => '<li>' + esc(hhmmss(h.at)) + ' — ' + esc(h.label)
      + (h.detail ? ' <span class="dim">(' + esc(h.detail) + ')</span>' : '') + ' — ' + (h.ok ? '<span class="status ok">done</span>' : '<span class="status bad">not done: ' + esc(h.error || '') + '</span>') + '</li>').join('') + '</ul>'
    : '<p class="small dim">Nothing asked from MegaNet since the agent started.</p>');
}

// ── SSH access ──────────────────────────────────────────────────────────────

const KEY_SOURCES = { local: 'this Pi (SD card or sudo)', github: 'GitHub', meganet: 'MegaNet team keys' };
const KEY_TYPES = { 'ssh-ed25519': 'Ed25519', 'sk-ssh-ed25519@openssh.com': 'Ed25519, security key', 'ssh-rsa': 'RSA',
  'sk-ecdsa-sha2-nistp256@openssh.com': 'ECDSA, security key' };
const keyType = (t) => KEY_TYPES[t] || (/^ecdsa/.test(t) ? 'ECDSA' : t);
// "cameron (password, 2 keys)" — or how it cannot log in.
const loginText = (l) => l.user + ' (' + ([l.password === 'set' ? 'password' : l.password === 'empty' ? 'EMPTY password' : null,
  l.keys ? l.keys + ' key' + (l.keys === 1 ? '' : 's') : null].filter(Boolean).join(', ') || 'no password or key') + ')';

function renderAccess(a) {
  const box = $('#access-body');
  const ctl = $$('#f-access select, #acc-sync');
  if (!a || !a.available) {
    box.innerHTML = '<p class="small dim">SSH access is set by the Pi\'s system helper, which is not installed here' + (a && a.error ? ' (' + esc(a.error) + ')' : '') + '.</p>';
    ctl.forEach(el => { el.disabled = true; });
    return;
  }
  ctl.forEach(el => { el.disabled = false; });
  const acct = a.account || {}, ssh = a.ssh || {}, pol = a.policy || {};
  $('#acc-ssh').value = ssh.enabled || ssh.active ? 'on' : 'off';
  $('#acc-password').value = pol.passwordLogin || 'unchanged';
  $('#acc-meganet').value = pol.meganetKeys ? 'on' : 'off';
  $('#acc-from').value = pol.from || 'private';
  const rows = [];
  rows.push(['SSH', esc((ssh.active ? 'on' : ssh.enabled ? 'on (starting)' : 'off') + (ssh.port ? ', port ' + ssh.port : '')
    + (ssh.passwordLogin === true ? ' · passwords accepted' : ssh.passwordLogin === false ? ' · keys only' : ''))
    + (ssh.passwordLogin && !(a.keys || []).length ? ' <span class="dim">— add a key, then turn password login off</span>' : '')]);
  rows.push(['The alert account', !acct.exists ? '<span class="status bad">missing — reinstall, or sudo rpi-alert-access ensure-account</span>'
    : esc((acct.password === 'set' ? 'has a password (the console' + (ssh.passwordLogin ? ' and SSH' : '') + ')' : 'no password — keys only') + (acct.sudo ? ' · may use sudo' : '') + ' · ' + (acct.keys || 0) + ' key' + (acct.keys === 1 ? '' : 's'))]);
  if ((a.logins || []).length) rows.push(['Accounts that can log in', esc(a.logins.map(loginText).join(' · '))]);
  if ((pol.github || []).length) rows.push(['GitHub accounts', esc(pol.github.join(', '))]);
  if (a.lastSync) rows.push(['Keys last fetched', esc(ago(Date.now() - a.lastSync.at) + (a.lastSync.ok ? '' : ' — some could not be fetched')) + ((a.lastSync.notes || []).length ? '<br><span class="dim">' + esc(a.lastSync.notes.slice(0, 3).join(' · ')) + '</span>' : '')]);
  const keys = a.keys || [];
  box.innerHTML = kv(rows) + (keys.length
    ? '<div class="table-wrap"><table class="readings"><thead><tr><th>Key</th><th>Whose</th><th>From</th><th>Works from</th></tr></thead><tbody>'
      + keys.map(k => '<tr><td class="mono small" title="' + esc(k.fingerprint) + '">' + esc(k.fingerprint.slice(0, 20) + '…') + ' <span class="dim">' + esc(keyType(k.type)) + '</span></td><td>' + esc(k.comment || '—')
        + '</td><td class="small">' + esc(KEY_SOURCES[k.source] || k.source) + '</td><td class="small">' + (k.restricted ? 'private networks' : 'anywhere') + '</td></tr>').join('')
      + '</tbody></table></div>'
    : '<p class="small">No key yet, so nobody can log in as <b class="mono">alert</b>. See below for how to add one.</p>');
}

async function loadAccess() {
  try { renderAccess(await api('/api/access')); } catch (e) { $('#access-body').innerHTML = '<p class="small status bad">' + esc(e.message) + '</p>'; }
}

async function accessSet(body, confirmText) {
  if (confirmText && !confirm(confirmText)) { loadAccess(); return; }
  const st = $('#acc-status');
  st.textContent = 'Working…'; st.className = 'small';
  try { renderAccess(await api('/api/access', { method: 'POST', body })); st.textContent = 'Done.'; st.className = 'small status ok'; }
  catch (e) { st.textContent = e.message; st.className = 'small status bad'; loadAccess(); }
}

function bindRemote() {
  $('#f-remote').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/api/remote', { method: 'POST', body: { mode: f.mode.value } });
      flash(f, f.mode.value === 'off' ? 'Saved — MegaNet is told once, then nothing.' : 'Saved.', true);
      loadConfig().catch(() => {}); refresh();
    } catch (err) { flash(f, err.message, false); }
  });
  $('#acc-ssh').addEventListener('change', (e) => accessSet({ set: 'ssh', value: e.target.value },
    e.target.value === 'off' ? 'Turn SSH off? Nobody can log in over the network until it is turned on again (here, or ssh = on on the SD card).' : null));
  $('#acc-password').addEventListener('change', (e) => accessSet({ set: 'password', value: e.target.value },
    e.target.value === 'on' ? 'Accept passwords over SSH? Anyone who can reach this Pi can then try them.' : null));
  $('#acc-meganet').addEventListener('change', (e) => accessSet({ set: 'meganet', value: e.target.value },
    e.target.value === 'on' ? 'Let MegaNet\'s team SSH keys log in as alert (with sudo)? Its administrators keep that list.' : null));
  $('#acc-from').addEventListener('change', (e) => accessSet({ set: 'from', value: e.target.value },
    e.target.value === 'any' ? 'Let keys fetched from GitHub and MegaNet work from any address, not only private networks?' : null));
  $('#acc-sync').addEventListener('click', () => accessSet({ sync: true }));
}

function showTab(t) {
  S.tab = t;
  renderHeader();
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  $$('.tab').forEach(s => { s.hidden = s.id !== 'tab-' + t; });
  if (t === 'rx') renderRxFull();
  if (t === 'survey') loadSurvey(true);
  if (t === 'settings') { loadConfig().catch(() => {}); loadRecordings(); loadNetwork(); loadUpdate().then(u => { if (u && u.running) followUpdate(); }); loadAccess(); }
  if (t === 'log') api('/api/log?n=300').then(r => { S.logLines = r.lines; renderLog(); }).catch(() => {});
  if (t === 'dash') renderCharts(true);
}

// #settings, or #settings-sdr: the tab, then that card (id f-sdr).
function route() {
  const h = location.hash.slice(1) || 'dash';
  const tab = h.split('-')[0];
  showTab(tab);
  const card = h !== tab && document.getElementById('f-' + h.slice(tab.length + 1));
  if (card) card.scrollIntoView({ block: 'start' });
}

$$('.tabs button').forEach(b => b.addEventListener('click', () => { location.hash = b.dataset.tab; }));
window.addEventListener('hashchange', route);
window.addEventListener('resize', debounce(() => renderCharts(true), 200));

(async function init() {
  wireSettings();
  wireSurvey();
  await refresh();
  try { const r = await api('/api/readings?limit=500'); S.readings = r.readings; S.bursts = r.bursts; renderReadings(); } catch (_) {}
  loadHistory();
  setInterval(loadHistory, 60 * 1000);
  connectEvents();
  route();
  setInterval(() => renderCharts(), 15000);
})();
