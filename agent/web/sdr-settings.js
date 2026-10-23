'use strict';
// Settings → RTL-SDR sticks: each stick as it is set — the channels it hears,
// its window, its tuner — and the plan for them (sdr-plan.js), worked out as
// they are typed: the window the stick will take, which of its channels that
// holds, what it costs this Pi, and whether saving retunes the stick. Then the
// defaults, for a stick with nothing of its own.
//
// Each of a stick's fields shows the value the stick has, marked as the
// default's or its own: changing one makes it the stick's own, and ↺ gives it
// back to the default. A stick's channels are chips — × takes one away; a
// frequency typed, or one of those MegaNet's stations use (the ones near this
// Pi first, each saying what it would do to the window), adds one. The first
// is the stick's own receiver in MegaNet (…-sdr1), each other one a receiver
// named by its frequency (…-sdr1-151.525).
//
// What a stick costs is in cores of this Pi: what its decoders take now
// (each one's thread, measured), scaled to the window planned by what a
// channel costs at each window here (lib/devices/sdr-bench.js) — or, before
// either is known, in channels' worth at 240 kHz.
//
// Loaded before app.js, whose helpers ($, esc, S, api, save, flash,
// keyedRows, setHtml, ownEntry, stickWhoHtml, FORMAT_NAMES) it calls once
// the page is up.

const SDR_FIELDS = ['rate', 'format', 'gain', 'ppm', 'squelch', 'bias'];
// Each field's setting, in receivers.sdr and in a stick's own entry.
const SDR_KEY = { rate: 'sampleRate', format: 'format', gain: 'gainDb', ppm: 'ppm', squelch: 'squelchDb', bias: 'biasTee' };
const SDR_SUGGEST = 8;
const SDR_FORMAT_SHORT = { BINARY: 'ABF', ENHANCED_IFLOWS: 'EIF', ASCII: 'ASCII' };
const SDR = { freqs: null, standard: [], nearKm: 150, asked: 0 };

// ── a setting as a field shows it, and back ───────────────────────────────

function sdrShow(k, v) {
  if (k === 'rate') return String(v || 0);
  if (k === 'gain') return v == null ? 'auto' : String(v);
  if (k === 'bias') return v ? 'on' : 'off';
  if (k === 'ppm') return String(v || 0);
  if (k === 'squelch') return String(v == null ? 8 : v);
  return String(v);
}

// A field's text → { v } or { error }.
function sdrParse(k, t) {
  t = String(t == null ? '' : t).trim();
  const n = Number(t);
  if (k === 'rate') return { v: Number(t) || 0 };
  if (k === 'format') return { v: t };
  if (k === 'bias') return { v: t === 'on' };
  if (k === 'gain') return /^(auto|agc)$/i.test(t) ? { v: null } : t !== '' && n >= 0 && n <= 60 ? { v: n } : { error: 'a gain of 0–60 dB, or auto' };
  if (k === 'ppm') return t !== '' && n >= -200 && n <= 200 ? { v: Math.round(n) } : { error: 'a correction of -200…200 ppm' };
  if (k === 'squelch') return t !== '' && n >= 2 && n <= 40 ? { v: n } : { error: 'a squelch of 2–40 dB' };
  return { v: t };
}

function sdrCoresText(c) { return c < 0.995 ? Math.max(1, Math.round(c * 100)) + ' % of a core' : (Math.round(c * 10) / 10) + ' cores'; }
function sdrPct(v) { return Math.round(v * 100) + ' %'; }

// ── one editor: a stick's, or the defaults' ──────────────────────────────

function sdrEdHtml(stick) {
  // The field's name and whose its value is on one line, the control under them.
  const fld = (k, label, ctl) => '<div class="fld" data-f="' + k + '"><div class="fl-head"><span>' + label + '</span>' + (stick ? '<span class="src"></span>' : '') + '</div>'
    + ctl.replace(/^<(\w+) /, '<$1 aria-label="' + label + '" ') + '</div>';
  return (stick ? '<div class="stick-head"><span class="who"></span><span class="act"></span></div>' : '')
    + '<div class="ed-chans"><div class="ed-label"><b>Channels</b>' + (stick ? ' <span class="src" data-f="chans"></span>' : '') + '</div>'
    + '<div class="chips-ed" data-chips></div>'
    + '<div class="ed-add"><input name="add" autocomplete="off" spellcheck="false" aria-label="Add a frequency, MHz" placeholder="Add a frequency, MHz — 151.5375, or 152.4 EIF in another format">'
    + '<button type="button" class="ghost small" data-add>Add</button></div>'
    + '<div class="suggest" data-suggest></div></div>'
    + '<div class="cols">'
    + fld('rate', 'Window', '<select name="rate"></select>')
    + fld('format', 'Frame format', '<select name="format">' + Object.entries(FORMAT_NAMES).map(([v, t]) => '<option value="' + v + '">' + esc(t) + '</option>').join('') + '</select>')
    + fld('gain', 'Gain, dB', '<input name="gain" autocomplete="off" title="A number of dB, or auto for the tuner\'s AGC">')
    + '</div>'
    + '<div class="ed-plan" data-plan aria-live="polite"></div>'
    + '<details class="ed-more"><summary>More' + (stick ? ' for this stick — name, ppm, squelch, bias tee' : ' — ppm, squelch, bias tee') + '</summary><div class="cols">'
    + (stick ? '<div class="fld"><div class="fl-head"><span>Name</span></div><input name="sname" maxlength="60" aria-label="Name"></div>' : '')
    + fld('ppm', 'Frequency correction, ppm', '<input name="ppm" type="number" step="1" min="-200" max="200">')
    + fld('squelch', 'Squelch, dB over the noise floor', '<input name="squelch" type="number" step="1" min="2" max="40">')
    + fld('bias', 'Bias tee', '<select name="bias"><option value="off">Off</option><option value="on">On — 4.5 V on the antenna socket, for an LNA that wants it</option></select>')
    + '</div></details>'
    + (stick ? '<label class="check"><input type="checkbox" name="son"> Use this stick</label>' : '');
}

const sdrEl = (ed, name) => $('[name=' + name + ']', ed);

// A stick's channels as its settings hold them, its own first: own, the
// stick's entry; sd, receivers.sdr — or the defaults as being edited.
function sdrChansOf(own, sd) {
  const first = own && own.freqHz !== undefined ? own.freqHz : sd.freqHz;
  const more = own && own.moreChannels !== undefined ? own.moreChannels : sd.moreChannels || [];
  return [{ freqHz: first }].concat(more.map(m => (m.format ? { freqHz: m.freqHz, format: m.format } : { freqHz: m.freqHz })));
}

// The defaults as the editor holds them now (a field that does not read is
// the saved one).
function sdrDefaults() {
  const ed = $('#sdr-default-ed'), sd = S.config.receivers.sdr;
  const out = { chans: ed && ed._m ? ed._m.chans : sdrChansOf(null, sd) };
  for (const k of SDR_FIELDS) {
    const el = ed && ed._m && sdrEl(ed, k);
    const p = el ? sdrParse(k, el.value) : { error: true };
    out[k] = p.error ? sd[SDR_KEY[k]] : p.v;
  }
  return out;
}

// What an editor would save → { chans, rate, format, gain, ppm, squelch,
// bias, errors }: a stick's field it does not own is the default's.
function sdrValues(ed) {
  const m = ed._m, d = m.key ? sdrDefaults() : null, errors = [];
  const out = { chans: m.key && !m.ownChans ? d.chans : m.chans, errors };
  for (const k of SDR_FIELDS) {
    if (m.key && !m.own.has(k)) { out[k] = d[k]; continue; }
    const p = sdrParse(k, sdrEl(ed, k).value);
    if (p.error) { errors.push(p.error); out[k] = m.key ? d[k] : S.config.receivers.sdr[SDR_KEY[k]]; } else out[k] = p.v;
  }
  return out;
}

// The stick's status, if it is a stick and known.
function sdrStick(ed) { return ed._m.key && S.status ? S.status.devices.sdrs.find(x => x.key === ed._m.key) || null : null; }

// The planner's channels: each in its own format, or the stick's.
function sdrPlanChans(v) { return v.chans.map((c, i) => ({ freqHz: c.freqHz, format: (i && c.format) || v.format })); }

function sdrPlan(v, st, rate) {
  const live = st && st.state !== 'unplugged' && st.centerHz;
  return SdrPlan.plan(sdrPlanChans(v), { sampleRate: rate === undefined ? v.rate : rate, offsetHz: S.config.receivers.sdr.offsetHz,
    prefer: live ? { sampleRate: st.sampleRate, centerHz: st.centerHz } : null });
}

// What a plan's decoding costs this Pi, in cores. A decoder's time is its
// window's steady work (measured here at each window) and its bursts' (the
// same at any window): so this stick's decoders now, less their window's
// steady work, plus the plan's. Without the measurements, the decoders now
// scaled by the table's; with neither, null.
function sdrCores(p, st) {
  const bench = S.status && S.status.sdrCost && S.status.sdrCost.perChannel;
  const n = p.channels.filter(c => c.inBand).length;
  if (st && st.load && st.load.decoders && st.sampleRate) {
    const now = st.load.cores / st.load.decoders;
    if (bench && bench[st.sampleRate] && bench[p.sampleRate]) return n * (Math.max(0, now - bench[st.sampleRate]) + bench[p.sampleRate]);
    return n * now * SdrPlan.COST[p.sampleRate] / SdrPlan.COST[st.sampleRate];
  }
  return bench && bench[p.sampleRate] ? n * bench[p.sampleRate] : null;
}

function sdrCostText(p, st) {
  const c = sdrCores(p, st);
  if (c != null) return '≈ ' + sdrCoresText(c);
  const u = SdrPlan.load(p);
  return u ? (Math.round(u * 10) / 10) + '× one channel at 240 kHz' : 'nothing';
}

function sdrMhz(f) { return Channels.mhz(f); }

// ── drawing an editor ────────────────────────────────────────────────────

// The editor's values into its fields, from the settings: a stick's from its
// own entry, each field it does not own from the defaults.
function sdrFill(ed, d) {
  const sd = S.config.receivers.sdr;
  const sel = sdrEl(ed, 'rate');
  if (!sel.options.length) sel.innerHTML = [0].concat(SdrPlan.RATES).map(r => '<option value="' + r + '"></option>').join('');
  if (!d) {
    ed._m = { key: null, own: new Set(SDR_FIELDS), chans: sdrChansOf(null, sd), ownChans: true };
    for (const k of SDR_FIELDS) sdrEl(ed, k).value = sdrShow(k, sd[SDR_KEY[k]]);
    sdrRateOptions(ed);
    return;
  }
  const own = ownEntry(d) || {};
  const m = ed._m = { key: d.key, own: new Set(SDR_FIELDS.filter(k => own[SDR_KEY[k]] !== undefined)), ownChans: own.freqHz !== undefined || own.moreChannels !== undefined, chans: null };
  if (m.ownChans) m.chans = sdrChansOf(own, sd);
  const def = sdrDefaults();
  for (const k of SDR_FIELDS) sdrEl(ed, k).value = sdrShow(k, m.own.has(k) ? own[SDR_KEY[k]] : def[k]);
  sdrRateOptions(ed);
  sdrEl(ed, 'sname').value = own.name || '';
  sdrEl(ed, 'sname').placeholder = 'RTL-SDR' + (d.n > 1 ? ' ' + d.n : '');
  sdrEl(ed, 'son').checked = own.enabled !== false;
  if (m.own.has('ppm') || m.own.has('squelch') || m.own.has('bias') || own.name) $('details', ed).open = true;
}

// A stick's fields it does not own, shown again from the defaults (as they
// are edited).
function sdrFollow(ed) {
  const m = ed._m;
  if (!m || !m.key) return;
  const def = sdrDefaults();
  for (const k of SDR_FIELDS) if (!m.own.has(k)) { const el = sdrEl(ed, k); const v = sdrShow(k, def[k]); if (el.value !== v) el.value = v; }
}

// The window's choices, each saying what it would do with these channels.
function sdrRateOptions(ed) {
  const sel = sdrEl(ed, 'rate');
  const v = sdrValues(ed), st = sdrStick(ed), n = v.chans.length;
  for (const o of sel.options) {
    const r = Number(o.value), p = sdrPlan(v, st, r), heard = p.channels.filter(c => c.inBand).length;
    const c = sdrCores(p, st), u = SdrPlan.load(p);
    const t = (r ? SdrPlan.width(r) + (r === SdrPlan.RATES[0] ? ', the lightest' : '') : 'Automatic: ' + SdrPlan.width(p.sampleRate))
      + (heard < n ? ' · ' + (n - heard) + ' not heard' : '') + ' · ' + (c != null ? '≈ ' + (Math.round(c * 100) / 100) + ' core' : (Math.round(u * 10) / 10) + '× a channel');
    if (o.textContent !== t) o.textContent = t;
  }
}

// The source tag beside a stick's field: its own (↺ back to the default) or the default's.
function sdrSrc(own, what) {
  return own ? '<button type="button" class="src-own" data-reset="' + what + '" title="Back to the default">this stick\'s ↺</button>' : '<span class="src-def">default</span>';
}

// Everything in an editor that follows from its values: the chips, the
// suggestions, the window's choices, the plan and what it costs.
function sdrDraw(ed) {
  const m = ed._m;
  if (!m) return;
  sdrFollow(ed);
  sdrRateOptions(ed);
  const v = sdrValues(ed), st = sdrStick(ed), p = sdrPlan(v, st);
  if (m.key) {
    setHtml($('.src[data-f=chans]', ed), sdrSrc(m.ownChans, 'chans'));
    for (const k of SDR_FIELDS) setHtml($('.fld[data-f=' + k + '] .src', ed), sdrSrc(m.own.has(k), k));
  }
  // The chips: the first is the stick's own receiver.
  setHtml($('[data-chips]', ed), v.chans.map((c, i) => {
    const pc = p.channels[i], fmt = i && c.format && c.format !== v.format ? ' <small>' + SDR_FORMAT_SHORT[c.format] + '</small>' : '';
    const why = pc && !pc.inBand ? 'not heard: ' + sdrWhy(pc.why) : '';
    return '<span class="ch-chip' + (why ? ' out' : '') + '" title="' + esc((i ? 'MegaNet receiver …-' + sdrMhz(c.freqHz) : 'This stick\'s own MegaNet receiver') + (why ? ' — ' + why : '')) + '">'
      + esc(sdrMhz(c.freqHz)) + fmt + (why ? ' <small>not heard</small>' : '')
      + '<button type="button" data-rm="' + i + '" aria-label="Take away ' + esc(sdrMhz(c.freqHz)) + ' MHz">×</button></span>';
  }).join('') || '<span class="dim small">No channels — add one.</span>');
  setHtml($('[data-suggest]', ed), sdrSuggestHtml(v, st, p));
  setHtml($('[data-plan]', ed), sdrPlanHtml(v, st, p));
}

function sdrWhy(why) {
  return { outside: 'outside the window', spike: 'beside the others it would sit on the DC spike', mirror: 'another channel\'s mirror image would land on it' }[why] || 'it does not fit beside the others';
}

// MegaNet's frequencies to add from, the nearest-used first: each a chip that
// adds it or takes it away, saying what it would do to the window.
function sdrSuggestHtml(v, st, p) {
  const list = SDR.freqs && SDR.freqs.length ? SDR.freqs.slice(0, SDR_SUGGEST)
    : SDR.standard.map(freqHz => ({ freqHz, tx: null }));
  if (!list.length) return '';
  const have = new Set(v.chans.map(c => c.freqHz));
  const chips = list.map(f => {
    const on = have.has(f.freqHz);
    let effect = '';
    if (!on && v.chans.length < SdrPlan.MAX_CHANNELS) {
      const q = sdrPlan(Object.assign({}, v, { chans: v.chans.concat({ freqHz: f.freqHz }) }), st);
      const last = q.channels[q.channels.length - 1];
      if (!last.inBand) effect = ' · not in this window';
      else if (q.sampleRate > p.sampleRate) effect = ' · → ' + SdrPlan.width(q.sampleRate);
    }
    const used = f.tx == null ? 'one of MegaNet\'s channels'
      : [f.tx ? f.tx + ' transmit' : '', f.rx ? f.rx + ' listen' : ''].filter(Boolean).join(', ') + (f.near != null ? ' · ' + f.near + ' within ' + SDR.nearKm + ' km' : '')
        + (f.labels && f.labels.length ? ' · ' + f.labels.join('; ') : '')
        + (f.stations && f.stations.length ? '\n' + f.stations.map(w => w.name + (w.km != null ? ' (' + w.km + ' km)' : '') + (w.tx ? '' : ' listens')).join('\n') : '');
    const tag = f.near != null ? f.near + ' near' : f.tx != null ? (f.tx + f.rx) + '' : '';
    return '<button type="button" class="sg' + (on ? ' on' : '') + '" data-sg="' + f.freqHz + '" aria-pressed="' + on + '" title="' + esc(used) + '">'
      + esc(sdrMhz(f.freqHz)) + (tag ? ' <small>' + esc(tag) + '</small>' : '') + (effect ? '<small class="eff">' + esc(effect) + '</small>' : '') + '</button>';
  }).join('');
  const src = SDR.freqs && SDR.freqs.length ? 'Used by MegaNet\'s stations' + (SDR.freqs[0].near != null ? ', the most near this Pi first' : '') : 'MegaNet\'s channels';
  return '<div class="sg-head small dim">' + src + ' — tap to add or take away:</div><div class="sg-list">' + chips + '</div>';
}

function sdrPlanHtml(v, st, p) {
  const n = v.chans.length, heard = p.channels.filter(c => c.inBand).length;
  const lines = [];
  lines.push('<div><b>' + esc(SdrPlan.width(p.sampleRate) + ' window') + '</b> ' + esc((p.auto ? '(automatic: the narrowest that holds ' + (n > 1 ? 'them' : 'it') + ')' : '(as set)')
    + ' · ' + sdrMhz(p.lowHz) + '–' + sdrMhz(p.highHz) + ' MHz · ' + (heard < n ? heard + ' of ' + n + ' channels heard' : n + ' channel' + (n === 1 ? '' : 's'))
    + ' · ' + sdrCostText(p, st)) + '</div>');
  // Channels the window leaves out, a line for each reason, and what would hold them.
  const out = new Map();
  p.channels.forEach((pc, i) => { if (!pc.inBand) out.set(pc.why, (out.get(pc.why) || []).concat(sdrMhz(v.chans[i].freqHz))); });
  for (const [why, fs] of out) {
    lines.push('<div class="warn">⚠ ' + esc((fs.length > 1 ? fs.slice(0, -1).join(', ') + ' and ' + fs[fs.length - 1] + ' MHz are' : fs[0] + ' MHz is') + ' not heard: ' + sdrWhy(why)) + '.</div>');
  }
  if (out.size) {
    lines.push('<div class="warn">' + esc(p.needs && p.needs > p.sampleRate ? 'A ' + SdrPlan.width(p.needs) + ' window holds them all (' + sdrCostText(sdrPlan(v, st, p.needs), st) + ').'
      : p.needs ? '' : 'No one window holds them all: give the far ones a stick of their own.') + '</div>');
  }
  // The channel that widens an automatic window, and what is saved without it.
  if (p.auto && n > 1 && p.sampleRate > SdrPlan.RATES[0]) {
    let worst = null;
    v.chans.forEach((c, i) => {
      const rest = Object.assign({}, v, { chans: v.chans.filter((_, j) => j !== i) });
      const q = sdrPlan(rest, st);
      if (q.sampleRate < p.sampleRate && (!worst || q.sampleRate < worst.q.sampleRate)) worst = { c, q };
    });
    if (worst) {
      const a = sdrCores(p, st), b = sdrCores(worst.q, st), x = SdrPlan.COST[p.sampleRate] / SdrPlan.COST[worst.q.sampleRate];
      lines.push('<div class="note">' + esc(sdrMhz(worst.c.freqHz) + ' MHz is what makes this stick ' + SdrPlan.width(p.sampleRate) + ' wide: without it the rest fit '
        + SdrPlan.width(worst.q.sampleRate) + (a != null && b != null ? ' (' + sdrCoresText(b) + ' instead of ' + sdrCoresText(a) + ')' : ' — ' + (Math.round(x * 10) / 10) + '× less work a channel')) + '.</div>');
    }
  }
  if (st && st.state !== 'unplugged' && st.state !== 'disabled' && st.centerHz) {
    const had = st.channels.map(c => c.freqHz).join(), now = p.channels.map(c => c.freqHz).join();
    if (p.sampleRate !== st.sampleRate || p.centerHz !== st.centerHz) lines.push('<div class="dim">Saving retunes this stick: its channels pause for a second or two.</div>');
    else if (had !== now) lines.push('<div class="dim">Saving retunes nothing: its other channels hear on without a break.</div>');
    const ld = st.load, drop = st.counts && st.counts.dropped;
    if (ld) {
      lines.push('<div class="' + (ld.most > 0.8 || drop ? 'warn' : 'dim') + '">Now: ' + (ld.decoders > 1 ? 'its ' + ld.decoders + ' decoders take ' + esc(sdrCoresText(ld.cores)) + ' between them, the busiest ' + sdrPct(ld.most) + ' busy'
        : 'its decoder is ' + sdrPct(ld.most) + ' busy')
        + (ld.most > 0.8 ? ' — near its limit: a narrower window, or fewer channels' : '')
        + (drop ? ' · ⚠ ' + Math.round(drop / 1e6) + ' MB of samples dropped since the agent started — bursts in them were missed' : '') + '</div>');
    }
  }
  return lines.join('');
}

// This Pi as a whole: every stick's decoding as set here, against its cores.
function sdrBudget() {
  const box = $('#sdr-budget');
  if (!box || !S.status) return;
  const cores = (S.status.board && S.status.board.cores) || 1;
  let est = 0, known = true, live = 0, liveN = 0, units = 0;
  const on = $('#f-sdr').enabled.checked;
  for (const row of $$('#sdr-sticks .stick-row')) {
    if (!row._m || !$('[name=son]', row).checked) continue;
    const st = sdrStick(row);
    if (st && st.state === 'unplugged') continue;
    const v = sdrValues(row), p = sdrPlan(v, st), c = sdrCores(p, st);
    if (c == null) known = false; else est += c;
    units += SdrPlan.load(p);
    if (st && st.load) { live += st.load.cores; liveN++; }
  }
  if (!on || !$$('#sdr-sticks .stick-row').length) { setHtml(box, ''); return; }
  const share = est / cores;
  const head = known ? 'Decoding, as set below: ' + sdrCoresText(est) + ' of this Pi\'s ' + cores + ' cores (' + sdrPct(share) + ')'
    : 'Decoding, as set below: ' + (Math.round(units * 10) / 10) + '× the work of one channel at 240 kHz — what that is in this Pi\'s cores is measured a couple of minutes after the agent starts';
  const now = liveN ? ' · now ' + sdrCoresText(live) : '';
  const cls = known && share > 0.85 ? 'bad' : known && share > 0.6 ? 'warn' : '';
  setHtml(box, '<div class="' + cls + '">' + esc(head + now) + '</div>' + (cls ? '<div class="small">' + esc(cls === 'bad'
    ? 'More than this Pi has to spare: decoders will fall behind and drop samples, and bursts in them are missed. Narrow a window, or take channels away.'
    : 'That leaves little for decoding bursts, which comes on top: a busy hour may drop samples. Narrower windows give room.') + '</div>' : ''));
}

// ── the card ─────────────────────────────────────────────────────────────

// Filled from the settings: the defaults, then a row a stick (force: every
// row again, as after a save).
function sdrFillCard() {
  const f = $('#f-sdr'), sd = S.config.receivers.sdr;
  f.enabled.checked = sd.enabled;
  f.alert2.checked = sd.alert2 !== false;
  const dEd = $('#sdr-default-ed');
  if (!dEd.innerHTML) dEd.innerHTML = sdrEdHtml(false);
  sdrFill(dEd, null);
  sdrRender(true);
  if (!SDR.asked || Date.now() - SDR.asked > 10 * 60 * 1000) sdrLoadFreqs();
}

function sdrRender(force) {
  if (!S.config || !S.status) return;
  const sticks = S.status.devices.sdrs;
  keyedRows($('#sdr-sticks'), sticks, {
    key: d => d.key, cls: 'stick-row stick-ed', make: sdrEdHtml(true), force,
    empty: '<div class="dim small none">No sticks yet. Each RTL-SDR stick plugged in is listed here, with its channels and its window; until then, the defaults below are what one hears.</div>',
    fill: (row, d) => sdrFill(row, d),
    update: (row, d) => {
      row.style.setProperty('--c', 'var(' + stickColor(d) + ')');
      setHtml($('.who', row), stickWhoHtml(d));
      setHtml($('.act', row), d.state === 'unplugged'
        ? '<button type="button" class="ghost small danger" data-forget="' + esc(d.key) + '" data-name="' + esc(d.name) + '">Remove</button>' : '');
    },
  });
  $('#sdr-defaults').open = $('#sdr-defaults').open || !sticks.length;
  for (const ed of [$('#sdr-default-ed')].concat($$('#sdr-sticks .stick-row'))) sdrDraw(ed);
  sdrBudget();
}

async function sdrLoadFreqs() {
  SDR.asked = Date.now();
  try {
    const r = await api('/api/sdr/frequencies');
    SDR.freqs = r.frequencies; SDR.standard = r.standard || []; SDR.nearKm = r.nearKm || 150;
    sdrRender();
  } catch (_) {}
}

// A channel added to an editor (its own list from now on, for a stick).
function sdrTake(ed) {
  const m = ed._m;
  if (m.key && !m.ownChans) { m.chans = sdrDefaults().chans.map(c => Object.assign({}, c)); m.ownChans = true; }
  return m.chans;
}

function sdrAdd(ed, text) {
  const p = Channels.parse(text);
  if (p.error) return p.error;
  if (!p.channels.length) return 'a frequency in MHz, e.g. 151.5375';
  const list = sdrTake(ed);
  for (const c of p.channels) {
    if (list.some(x => x.freqHz === c.freqHz)) return sdrMhz(c.freqHz) + ' MHz is on the list already — each channel is decoded in one format';
    if (list.length >= SdrPlan.MAX_CHANNELS) return 'at most ' + SdrPlan.MAX_CHANNELS + ' channels on one stick: each is a decoder of its own';
    // The first channel's format is the stick's own.
    if (!list.length && c.format) { sdrEl(ed, 'format').value = c.format; if (ed._m.key) ed._m.own.add('format'); delete c.format; }
    list.push(c);
  }
  return null;
}

// The card → the settings patch, or why not.
function sdrPatch() {
  const f = $('#f-sdr'), dEd = $('#sdr-default-ed');
  const dv = sdrValues(dEd);
  if (dv.errors.length) return { error: 'Defaults: ' + dv.errors[0] };
  if (!dv.chans.length) return { error: 'Defaults: at least one channel' };
  const more = (list) => list.slice(1).map(c => (c.format ? { freqHz: c.freqHz, format: c.format } : { freqHz: c.freqHz }));
  const sdr = { enabled: f.enabled.checked, alert2: f.alert2.checked, freqHz: dv.chans[0].freqHz, moreChannels: more(dv.chans) };
  for (const k of SDR_FIELDS) sdr[SDR_KEY[k]] = dv[k];
  // A stick's entry holds only what it sets for itself. Entries for sticks
  // not listed are kept; 0.4's by-serial ones become the listed sticks' own.
  const rows = $$('#sdr-sticks .stick-row').filter(r => r._m);
  const keys = new Set(rows.map(r => r.dataset.key));
  const serials = new Set(rows.map(r => { const d = sdrStick(r); return d && d.device.serial; }).filter(Boolean));
  const list = ((S.config && S.config.receivers.sdrDevices) || []).filter(e => (e.key ? !keys.has(e.key) : !serials.has(e.serial)));
  for (const row of rows) {
    const m = row._m, d = sdrStick(row), who = (d ? d.name : row.dataset.key) + ': ';
    const e = { key: m.key };
    const name = sdrEl(row, 'sname').value.trim();
    if (name) e.name = name;
    if (m.ownChans) {
      if (!m.chans.length) return { error: who + 'at least one channel — or turn the stick off' };
      e.freqHz = m.chans[0].freqHz; e.moreChannels = more(m.chans);
    }
    for (const k of SDR_FIELDS) {
      if (!m.own.has(k)) continue;
      const p = sdrParse(k, sdrEl(row, k).value);
      if (p.error) return { error: who + p.error };
      e[SDR_KEY[k]] = p.v;
    }
    if (!sdrEl(row, 'son').checked) e.enabled = false;
    if (Object.keys(e).length > 1) list.push(e);
  }
  return { patch: { receivers: { sdr, sdrDevices: list } } };
}

function sdrWire() {
  const f = $('#f-sdr');
  const changed = (e) => {
    const ed = e.target.closest('.stick-ed');
    if (!ed || !ed._m) return;
    const k = e.target.name;
    if (ed._m.key && SDR_FIELDS.includes(k)) ed._m.own.add(k);
    sdrRender();
  };
  const each = (e) => { if (e.target.name === 'enabled') sdrBudget(); else if (e.target.name !== 'add') changed(e); };
  f.addEventListener('input', each);
  f.addEventListener('change', each);
  f.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.name !== 'add') return;
    e.preventDefault();
    $('[data-add]', e.target.closest('.stick-ed')).click();
  });
  f.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const ed = b && b.closest('.stick-ed');
    if (!b || !ed || !ed._m) return;
    const m = ed._m;
    if (b.dataset.add !== undefined) {
      const inp = sdrEl(ed, 'add'), err = inp.value.trim() ? sdrAdd(ed, inp.value) : 'type a frequency in MHz first, e.g. 151.5375';
      if (err) { flash(f, err, false); return; }
      inp.value = '';
    } else if (b.dataset.rm !== undefined) {
      const list = sdrTake(ed);
      if (list.length <= 1) { flash(f, 'A stick hears at least one channel — to stop it, untick Use this stick.', false); return; }
      list.splice(Number(b.dataset.rm), 1);
    } else if (b.dataset.sg !== undefined) {
      const hz = Number(b.dataset.sg), list = m.key && !m.ownChans ? sdrDefaults().chans : m.chans;
      const at = list.findIndex(c => c.freqHz === hz);
      if (at >= 0) {
        if (list.length <= 1) { flash(f, 'A stick hears at least one channel — to stop it, untick Use this stick.', false); return; }
        sdrTake(ed).splice(at, 1);
      } else {
        const err = sdrAdd(ed, sdrMhz(hz));
        if (err) { flash(f, err, false); return; }
      }
    } else if (b.dataset.reset !== undefined) {
      if (b.dataset.reset === 'chans') { m.ownChans = false; m.chans = null; } else m.own.delete(b.dataset.reset);
    } else return;
    e.preventDefault();
    sdrRender();
  });
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    // A frequency typed and not yet added is added, as Add would.
    for (const ed of $$('.stick-ed', f)) {
      const inp = ed._m && sdrEl(ed, 'add');
      if (!inp || !inp.value.trim()) continue;
      const err = sdrAdd(ed, inp.value);
      if (err) { flash(f, err, false); sdrRender(); return; }
      inp.value = '';
    }
    const r = sdrPatch();
    if (r.error) { flash(f, r.error, false); return; }
    save(f, r.patch);
  });
}
