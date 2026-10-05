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
  if (s.auth && !s.auth.passwordSet && !s.auth.local) banners.push(['', 'No web page password is set, so anyone on this network can change these settings. <a href="#settings">Set one</a>.']);
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

function renderRxMini() {
  const list = receivers();
  $('#rx-mini').innerHTML = list.length ? list.map(d => '<div class="rx"><span class="dot ' + esc(d.state) + '"></span><b>' + esc(d.name) + '</b><span>'
    + (d.protocol ? protoTag(d.protocol) + ' ' : '') + '<span class="dim small">' + esc(stateLabel(d.state)) + '</span></span><div class="meta">' + esc(deviceLine(d)) + '</div></div>').join('')
    : '<div class="dim">No receivers found. Plug in an RTL-SDR stick, a Quansheng radio on the ALERT firmware (USB-C), an ERT-A2 (USB-serial cable) or a USB GPS — each is picked up within a few seconds.</div>';
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
}

function renderBursts() {
  const c = $('#burst-canvas');
  if (!c || S.tab !== 'dash') return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const now = Date.now(), span = 30 * 60 * 1000;
  g.strokeStyle = css.getPropertyValue('--line'); g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, h - 0.5); g.lineTo(w, h - 0.5); g.stroke();
  // Bursts: stems from the bottom; readings: dots.
  const readT = S.readings.filter(r => now - r.t < span).map(r => r.t);
  let n = 0;
  for (const b of S.bursts) {
    const age = now - b.t;
    if (age > span) continue;
    n++;
    const x = w - (age / span) * w;
    const lvl = b.peakDb != null ? (b.kind === 'sdr' ? b.peakDb + 60 : b.peakDb + 130) : 30;
    const y = h - Math.max(6, Math.min(h - 4, lvl / 80 * h));
    const decoded = b.frames > 0 || readT.some(t => Math.abs(t - b.t) < 4000);
    g.strokeStyle = decoded ? css.getPropertyValue('--ok') : css.getPropertyValue('--warn');
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, h); g.lineTo(x, y); g.stroke();
  }
  g.fillStyle = css.getPropertyValue('--accent');
  for (const t of readT) { const x = w - ((now - t) / span) * w; g.beginPath(); g.arc(x, 6, 2.5, 0, 7); g.fill(); }
  $('#burst-count').textContent = n ? '(' + n + ')' : '';
}

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
    key: d => d.key, cls: 'card rxcard', make: '<div class="head"></div><div class="body"></div>',
    empty: '<div class="card dim none">No receivers found yet.</div>',
    update: (card, d) => {
      setHtml($('.head', card), rxHeadHtml(d));
      setHtml($('.body', card), rxBodyHtml(d));
      let cv = $('canvas', card);
      if (d.kind === 'sdr' && d.spectrum) {
        if (!cv) { card.insertAdjacentHTML('beforeend', '<canvas height="120"></canvas><div class="dim small spec-note"></div>'); cv = $('canvas', card); }
        $('.spec-note', card).textContent = d.spectrum.channelsHz && d.spectrum.channelsHz.length > 1
          ? 'The whole slice the stick hears; its channels are the green lines. 1 s max hold.' : 'Spectrum around the channel (green line); 1 s max hold.';
        drawSpectrum(cv, d);
      } else if (cv) { cv.remove(); $('.spec-note', card).remove(); }
    },
  });
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
    const tuner = ', gain ' + (d.gainDb == null ? 'auto' : d.gainDb + ' dB') + (d.ppm ? ', ' + d.ppm + ' ppm' : '') + (d.biasTee ? ', bias tee ON' : '');
    if (multi) {
      const t = d.tune || {};
      rows.push(['Tuned', esc((d.centerHz / 1e6).toFixed(4) + ' MHz centre, ' + d.sampleRate / 1000 + ' ksps' + (t.raised ? ' (raised to hold every channel)' : '') + tuner)
        + (t.dcHz != null ? ' <span class="dim">· the nearest channel ' + Math.round(t.dcHz / 1000) + ' kHz from the DC spike, '
          + Math.round(t.mirrorHz / 1000) + ' kHz from another\'s mirror image</span>' : '')]);
    } else {
      rows.push(['Tuned', esc((d.freqHz / 1e6).toFixed(4) + ' MHz channel, ' + d.sampleRate / 1000 + ' ksps' + tuner)]);
      rows.push(['Format', esc(FORMAT_NAMES[d.format] || d.format)]);
    }
    rows.push(['Settings', esc(d.own.length ? 'its own ' + d.own.map(f => OWN_LABELS[f] || f).join(', ') + '; the rest shared' : 'the shared ones') + ' — <a href="#settings-sdr">change</a>']);
    if (d.level) {
      rows.push(['Signal', esc('ADC ' + d.level.dbfs + ' dBFS' + (d.level.clipPct ? ', clipping ' + d.level.clipPct + '%' : '')
        + (multi ? '' : ' · channel ' + d.level.chDb + ' dB, floor ' + d.level.nfDb + ' dB' + (d.level.open ? ' · squelch OPEN' : '')))]);
    }
    rows.push(['Heard', esc((multi ? 'on all its channels: ' : '') + d.counts.bursts + ' bursts, ' + d.counts.decodes + ' readings, ' + d.counts.shadows + ' bit-flip shadows set aside, ' + d.counts.undecoded + ' undecoded')]);
    if (!multi && d.level && d.level.nfDb != null) rows.push(['Noise floor', esc(d.level.nfDb + ' dBFS in the channel (squelch opens ' + (d.level.nfDb + (d.squelchDb ?? 8)).toFixed(1) + ' dBFS)')]);
    if (!multi && d.lastBurst) {
      const b = d.lastBurst, sat = b.peakDb != null && b.peakDb >= SATURATED_DBFS;
      rows.push(['Last burst', esc('peak ' + b.peakDb + ' dBFS over floor ' + b.nfDb + ' · ' + (sat ? '≥ ' : '') + snrText(b.snrDb) + ' · ' + b.ms + ' ms, ' + ago(Date.now() - b.t))
        + (sat ? ' <span style="color: var(--warn)">⚠ saturated — reached the ADC full scale; lower the gain until bursts peak below ' + SATURATED_DBFS + ' dBFS</span>' : '')]);
    }
    if (!multi && d.lastDecode) rows.push(['Last decode', esc(d.lastDecode.id + ' = ' + d.lastDecode.value + ' (' + d.lastDecode.votes + ' votes) ' + ago(Date.now() - d.lastDecode.t))]);
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

// A stick's channels, a row each: each one a receiver of its own.
function channelTable(d) {
  const unplugged = d.state === 'unplugged';
  const rows = d.channels.map(ch => {
    const lv = ch.level, c = ch.counts, ld = ch.lastDecode;
    const signal = !ch.inBand ? '<span style="color: var(--warn)">⚠ ' + esc(NO_FIT) + '</span>'
      : lv ? esc(lv.chDb + ' dB, floor ' + lv.nfDb + (lv.open ? ' · OPEN' : '')) : '<span class="dim">' + (unplugged ? '—' : 'starting…') + '</span>';
    return '<tr><td>' + esc(Channels.mhz(ch.freqHz)) + ' MHz</td><td>' + esc(FORMAT_NAMES[ch.format] || ch.format) + '</td><td><code class="small">' + esc(ch.pointId) + '</code></td>'
      + '<td>' + signal + '</td><td>' + esc(c.bursts + ' bursts, ' + c.decodes + ' readings' + (c.undecoded ? ', ' + c.undecoded + ' undecoded' : '')) + '</td>'
      + '<td>' + (ld ? esc(ld.id + ' = ' + ld.value + ' (' + ld.votes + ' votes) ' + ago(Date.now() - ld.t)) : '<span class="dim">—</span>') + '</td></tr>';
  });
  return '<div class="table-wrap chans"><table><thead><tr><th>Channel</th><th>Format</th><th>MegaNet receiver id</th><th>Signal</th><th>Heard</th><th>Last decode</th></tr></thead><tbody>'
    + rows.join('') + '</tbody></table></div>';
}

function drawSpectrum(c, d) {
  if (!c) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const db = d.spectrum.db, lo = Math.min(...db), hi = Math.max(...db), span = Math.max(10, hi - lo);
  g.strokeStyle = css.getPropertyValue('--accent'); g.lineWidth = 1.2; g.beginPath();
  db.forEach((v, i) => { const x = i / (db.length - 1) * w, y = h - 4 - (v - lo) / span * (h - 10); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.stroke();
  const rate = d.spectrum.rate;
  g.strokeStyle = css.getPropertyValue('--ok');
  for (const hz of d.spectrum.channelsHz || [d.spectrum.channelHz]) {
    const cx = (0.5 + (hz - d.spectrum.centerHz) / rate) * w;
    g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, h); g.stroke();
  }
}

// ── settings ────────────────────────────────────────────────────────────────

async function loadConfig() {
  const r = await api('/api/config');
  S.config = r.config;
  fillForms();
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
  renderSticks(true);

  $('#f-ports').autoDetect.checked = c.receivers.autoDetect;
  renderPortOverrides(true);

  const fa = $('#f-audio');
  fa.mode.value = c.audio.enabled ? c.audio.mode : 'off';
  fa.volume.value = c.audio.volume;
  if (!fa.device.options.length) fa.device.innerHTML = '<option value="' + esc(c.audio.device) + '">' + esc(c.audio.device === 'default' ? 'System default' : c.audio.device) + '</option>';
  loadAudioDevices();

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

function wireSettings() {
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
      sampleRate: Number(f.rate.value), ppm: Number(f.ppm.value) || 0, squelchDb: Number(f.squelch.value) || 8, enabled: f.enabled.checked, biasTee: f.biasTee.checked },
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

// ── live ────────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    S.status = await api('/api/status');
    renderHeader(); renderStats(); renderRxMini();
    if (S.tab === 'rx') renderRxFull();
    if (S.tab === 'settings' && S.config) { renderPortOverrides(); renderSticks(); renderRemote(); }
    renderBursts();
  } catch (e) {
    $('#host').textContent = 'not connected — ' + e.message;
  }
}

function connectEvents() {
  if (S.sse) S.sse.close();
  const es = new EventSource('/api/events');
  S.sse = es;
  es.addEventListener('reading', (e) => { S.readings.unshift(JSON.parse(e.data)); if (S.readings.length > 500) S.readings.length = 500; renderReadings(true); renderBursts(); });
  es.addEventListener('burst', (e) => { S.bursts.unshift(JSON.parse(e.data)); if (S.bursts.length > 300) S.bursts.length = 300; renderBursts(); });
  es.addEventListener('tick', () => refresh());
  es.addEventListener('devices', () => refresh());
  // Approved: the settings page shows the token as set, without a reload.
  es.addEventListener('token-request', (e) => {
    let t = null; try { t = JSON.parse(e.data); } catch (_) {}
    refresh();
    if (t && t.last && t.last.status === 'approved' && S.tab === 'settings') loadConfig().catch(() => {});
  });
  es.addEventListener('remote', () => { if (S.tab === 'settings') refresh(); });
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
  if (t === 'settings') { loadConfig().catch(() => {}); loadNetwork(); loadUpdate().then(u => { if (u && u.running) followUpdate(); }); loadAccess(); }
  if (t === 'log') api('/api/log?n=300').then(r => { S.logLines = r.lines; renderLog(); }).catch(() => {});
  if (t === 'dash') renderBursts();
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
window.addEventListener('resize', debounce(renderBursts, 200));

(async function init() {
  wireSettings();
  await refresh();
  try { const r = await api('/api/readings?limit=500'); S.readings = r.readings; S.bursts = r.bursts; renderReadings(); } catch (_) {}
  connectEvents();
  route();
  setInterval(renderBursts, 15000);
})();
