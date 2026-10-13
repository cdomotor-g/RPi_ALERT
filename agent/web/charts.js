'use strict';
// Small time charts on a canvas, for the dashboard: no library, no CDN — the
// Pi's own screen has no internet. One call draws one chart:
//
//   Charts.draw(canvas, {
//     t0, t1,                                   the time across (ms)
//     y: { min, max, unit, fmt, ticks },        the scale (min/max from the data if not given)
//     bars:  [{ t, w, v, color }],              from zero, w ms wide
//     stems: [{ t, f, color }],                 0–1 of the height, from the bottom
//     dots:  [{ t, f, color }],                 0–1 of the height
//     lines: [{ pts: [[t, v]], color, fill, gapMs }],
//     refs:  [{ v, color, label }],             dashed level lines
//     xAxis, yAxis: true/false,                 labels (both on by default)
//     gutter: px,                               at least this much for the y labels, so charts stacked line up
//     tip(t): text for the pointer over time t  (or null)
//   })

const Charts = (() => {
  let css = null, cssAt = 0;
  const col = (name) => {
    if (!css || Date.now() - cssAt > 1000) { css = getComputedStyle(document.documentElement); cssAt = Date.now(); }
    return css.getPropertyValue(name).trim() || name;
  };
  const color = (c) => (c && c.startsWith('--') ? col(c) : c);
  // A color at an opacity: hex from the stylesheet, or anything canvas takes.
  function alpha(c, a) {
    c = color(c);
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (!m) return c;
    let h = m[1];
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ',' + a + ')';
  }

  const MIN = 60 * 1000;
  const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720].map(m => m * MIN);
  function hhmm(t) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  // A step for about one label per 70 px, on round local times.
  function timeTicks(t0, t1, w) {
    const want = Math.max(2, Math.floor(w / 70));
    const step = STEPS.find(s => (t1 - t0) / s <= want) || STEPS[STEPS.length - 1];
    const off = new Date(t0).getTimezoneOffset() * MIN;
    const out = [];
    for (let t = Math.ceil((t0 - off) / step) * step + off; t <= t1; t += step) out.push(t);
    return out;
  }

  function niceStep(span, n) {
    const raw = span / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  const state = new WeakMap();

  function draw(c, o) {
    if (!c || !c.isConnected) return;
    const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const font = (H < 70 ? 9.5 : 10.5) + 'px ' + col('--font');
    g.font = font;

    // The scale: what is drawn against it, unless it is given.
    const y = Object.assign({}, o.y || {});
    const vals = [];
    for (const b of o.bars || []) vals.push(b.v);
    for (const l of o.lines || []) for (const p of l.pts) if (p[1] != null) vals.push(p[1]);
    for (const r of o.refs || []) if (r.always) vals.push(r.v);
    if (y.min == null) y.min = vals.length ? Math.min(...vals) : 0;
    if (y.max == null) y.max = vals.length ? Math.max(...vals) : 1;
    if (y.floor != null) y.min = Math.min(y.min, y.floor);
    if (y.minSpan && y.max - y.min < y.minSpan) { const mid = (y.max + y.min) / 2; y.min = mid - y.minSpan / 2; y.max = mid + y.minSpan / 2; if (y.floor != null && y.min < y.floor) { y.max += y.floor - y.min; y.min = y.floor; } }
    if (y.max <= y.min) y.max = y.min + 1;
    const xAxis = o.xAxis !== false, yAxis = o.yAxis !== false && (o.bars || o.lines || []).length > 0 && !o.noY;
    const fmt = y.fmt || (v => String(Math.round(v * 10) / 10));
    let ticksY = [];
    if (yAxis) {
      const st = niceStep(y.max - y.min, H < 90 ? 2 : 3);
      if (y.pad !== false) { y.min = Math.floor(y.min / st) * st; y.max = Math.ceil(y.max / st) * st; }
      for (let v = Math.ceil(y.min / st) * st; v <= y.max + 1e-9; v += st) ticksY.push(Math.round(v * 1e6) / 1e6);
    }
    const left = Math.max(o.gutter || 0, yAxis ? Math.max(...ticksY.map(v => g.measureText(fmt(v)).width), 8) + 6 : 0);
    const bottom = xAxis ? 14 : 0, top = 3;
    const pw = W - left, ph = H - bottom - top;
    const X = (t) => left + (t - o.t0) / (o.t1 - o.t0) * pw;
    const Y = (v) => top + ph - (v - y.min) / (y.max - y.min) * ph;
    state.set(c, { o, X, left, pw });

    // Grid and labels.
    g.strokeStyle = col('--line'); g.lineWidth = 1; g.fillStyle = col('--dim');
    g.textBaseline = 'middle'; g.textAlign = 'right';
    for (const v of ticksY) {
      const yy = Math.round(Y(v)) + 0.5;
      g.globalAlpha = 0.6; g.beginPath(); g.moveTo(left, yy); g.lineTo(W, yy); g.stroke(); g.globalAlpha = 1;
      g.fillText(fmt(v), left - 4, Math.min(H - bottom - 5, Math.max(6, yy)));
    }
    g.beginPath(); g.moveTo(left, top + ph + 0.5); g.lineTo(W, top + ph + 0.5); g.stroke();
    if (xAxis) {
      g.textBaseline = 'alphabetic'; g.textAlign = 'center';
      for (const t of timeTicks(o.t0, o.t1, pw)) {
        const x = Math.round(X(t)) + 0.5;
        g.globalAlpha = 0.35; g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + ph); g.stroke(); g.globalAlpha = 1;
        const s = hhmm(t), tw = g.measureText(s).width;
        g.fillText(s, Math.min(W - tw / 2, Math.max(left + tw / 2, x)), H - 2);
      }
    }
    g.save();
    g.beginPath(); g.rect(left, 0, pw, top + ph); g.clip();

    for (const b of o.bars || []) {
      if (!b.v) continue;
      const x0 = X(b.t), x1 = X(b.t + b.w);
      const yy = Y(Math.min(y.max, b.v)), y0 = Y(Math.max(y.min, 0));
      g.fillStyle = color(b.color || '--accent');
      g.fillRect(x0 + 0.5, yy, Math.max(1, x1 - x0 - 1), Math.max(1, y0 - yy));
    }
    for (const s of o.stems || []) {
      const x = X(s.t);
      g.strokeStyle = color(s.color || '--accent'); g.lineWidth = s.width || 2;
      g.beginPath(); g.moveTo(x, top + ph); g.lineTo(x, top + ph - Math.max(0.06, Math.min(1, s.f)) * ph); g.stroke();
    }
    for (const r of o.refs || []) {
      if (r.v < y.min || r.v > y.max) continue;
      const yy = Math.round(Y(r.v)) + 0.5;
      g.strokeStyle = color(r.color || '--warn'); g.lineWidth = 1; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(left, yy); g.lineTo(W, yy); g.stroke(); g.setLineDash([]);
      if (r.label) { g.fillStyle = color(r.color || '--warn'); g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillText(r.label, W - 3, yy - 1); }
    }
    for (const l of o.lines || []) {
      const gap = l.gapMs || 3 * MIN;
      const runs = [];
      let run = [];
      for (const p of l.pts) {
        if (p[1] == null) { if (run.length) runs.push(run); run = []; continue; }
        if (run.length && p[0] - run[run.length - 1][0] > gap) { runs.push(run); run = []; }
        run.push(p);
      }
      if (run.length) runs.push(run);
      const cc = color(l.color || '--accent');
      for (const r of runs) {
        if (l.fill) {
          g.fillStyle = alpha(cc, 0.16);
          g.beginPath(); g.moveTo(X(r[0][0]), top + ph);
          for (const p of r) g.lineTo(X(p[0]), Y(p[1]));
          g.lineTo(X(r[r.length - 1][0]), top + ph); g.closePath(); g.fill();
        }
        g.strokeStyle = cc; g.lineWidth = l.width || 1.6; g.lineJoin = 'round';
        g.beginPath();
        r.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))));
        if (r.length === 1) g.lineTo(X(r[0][0]) + 1.5, Y(r[0][1]));
        g.stroke();
      }
    }
    for (const d of o.dots || []) {
      g.fillStyle = color(d.color || '--accent');
      g.beginPath(); g.arc(X(d.t), top + ph - d.f * ph, d.r || 2.5, 0, 7); g.fill();
    }
    g.restore();
    if (!c.dataset.tipWired) wireTip(c);
  }

  // The pointer over a chart: what is at that time, in a box beside it.
  let tipEl = null;
  function wireTip(c) {
    c.dataset.tipWired = '1';
    const move = (ev) => {
      const st = state.get(c);
      if (!st || !st.o.tip) return;
      const r = c.getBoundingClientRect();
      const x = ev.clientX - r.left;
      if (x < st.left) { hide(); return; }
      const t = st.o.t0 + (x - st.left) / st.pw * (st.o.t1 - st.o.t0);
      const text = st.o.tip(t);
      if (!text) { hide(); return; }
      if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'chart-tip'; document.body.appendChild(tipEl); }
      tipEl.textContent = text;
      tipEl.hidden = false;
      const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
      let lx = ev.clientX + 12, ly = ev.clientY - th - 8;
      if (lx + tw > window.innerWidth - 4) lx = ev.clientX - tw - 12;
      if (ly < 4) ly = ev.clientY + 14;
      tipEl.style.left = lx + 'px'; tipEl.style.top = ly + 'px';
    };
    const hide = () => { if (tipEl) tipEl.hidden = true; };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerdown', move);
    c.addEventListener('pointerleave', hide);
  }

  // A waterfall: rows of dB, newest at the top, in a blue → yellow → red ramp.
  const RAMP = [[0, [8, 16, 40]], [0.3, [20, 60, 150]], [0.55, [30, 170, 200]], [0.75, [240, 220, 70]], [1, [240, 70, 50]]];
  function ramp(f) {
    f = Math.max(0, Math.min(1, f));
    for (let i = 1; i < RAMP.length; i++) {
      if (f <= RAMP[i][0]) {
        const [a, ca] = RAMP[i - 1], [b, cb] = RAMP[i], k = (f - a) / (b - a);
        return [0, 1, 2].map(j => Math.round(ca[j] + (cb[j] - ca[j]) * k));
      }
    }
    return RAMP[RAMP.length - 1][1];
  }
  function waterfall(c, rows, lo, hi) {
    if (!c || !rows.length) return;
    const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const n = rows[0].length, img = new ImageData(n, rows.length);
    rows.forEach((row, j) => {
      for (let i = 0; i < n; i++) {
        const [r, gg, b] = ramp((row[i] - lo) / (hi - lo)), k = (j * n + i) * 4;
        img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = b; img.data[k + 3] = 255;
      }
    });
    const off = document.createElement('canvas');
    off.width = n; off.height = rows.length;
    off.getContext('2d').putImageData(img, 0, 0);
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = true;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(off, 0, 0, c.width, c.height * Math.min(1, rows.length / Math.max(1, c.dataset.rows || rows.length)));
  }

  return { draw, waterfall, alpha, hhmm, MIN };
})();
