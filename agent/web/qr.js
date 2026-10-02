'use strict';
// A QR code encoder, small enough to read: byte mode, versions 1–10, error
// correction L/M/Q/H, the mask with the lowest penalty. ISO/IEC 18004.
//
// Why here and not a library: the dashboard has to work on the Pi's own screen
// with no internet (no CDN), the agent has no npm dependencies, and all it ever
// encodes is one short link — MegaNet's Admin tab, opened on the request this
// Pi is waiting on — so a phone can be held up to the screen instead of the
// link being typed. The same file draws it for the CLI as text.
//
// Loaded by web/index.html as the global QR, and by bin/rpi-alert with require().
//
//   QR.encode(text, { ecl: 'M' })  → { size, modules: boolean[][] (row, column), version, mask }
//   QR.svg(text, opts)             → '<svg …>' with a four-module quiet zone
//   QR.text(text, opts)            → lines of ▀ ▄ █ for a terminal (dark on light)
//
// test/qr.test.js holds it to an independent encoder module for module, and
// to a decoder.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QR = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // Per version 1–10: error correction codewords per block, and blocks.
  const ECC = {
    L: { per: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],  blocks: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4], bits: 1 },
    M: { per: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26], blocks: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5], bits: 0 },
    Q: { per: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24], blocks: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8], bits: 3 },
    H: { per: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28], blocks: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8], bits: 2 },
  };
  const MAX_VERSION = 10;

  // Modules left for data and error correction once the function patterns are drawn.
  function rawModules(ver) {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const align = Math.floor(ver / 7) + 2;
      n -= (25 * align - 10) * align - 55;
      if (ver >= 7) n -= 36;
    }
    return n;
  }
  function dataCodewords(ver, ecl) {
    const e = ECC[ecl];
    return Math.floor(rawModules(ver) / 8) - e.per[ver - 1] * e.blocks[ver - 1];
  }

  function alignmentPositions(ver) {
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const out = [6];
    for (let pos = ver * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
    return out;
  }

  // ── Reed–Solomon over GF(256), x^8 + x^4 + x^3 + x^2 + 1 ───────────────────

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }
  function rsDivisor(degree) {
    const out = new Array(degree).fill(0);
    out[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        out[j] = gfMul(out[j], root);
        if (j + 1 < degree) out[j] ^= out[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return out;
  }
  function rsRemainder(data, divisor) {
    const out = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ out.shift();
      out.push(0);
      divisor.forEach((c, i) => { out[i] ^= gfMul(c, factor); });
    }
    return out;
  }

  // ── the bit stream ────────────────────────────────────────────────────────

  function utf8(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    return Array.from(Buffer.from(String(text), 'utf8'));
  }

  function codewords(bytes, ver, ecl) {
    const bits = [];
    const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    put(0x4, 4);                                  // byte mode
    put(bytes.length, ver <= 9 ? 8 : 16);
    bytes.forEach(b => put(b, 8));
    const cap = dataCodewords(ver, ecl) * 8;
    put(0, Math.min(4, cap - bits.length));       // terminator
    put(0, (8 - bits.length % 8) % 8);            // to a byte boundary
    for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

    // Split into blocks (the short ones first, one data codeword shorter),
    // add each block's error correction, then interleave.
    const e = ECC[ecl], nBlocks = e.blocks[ver - 1], eccLen = e.per[ver - 1];
    const raw = Math.floor(rawModules(ver) / 8);
    const nShort = nBlocks - raw % nBlocks, shortLen = Math.floor(raw / nBlocks);
    const div = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < nBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < nShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const out = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) out.push(b[i]); });
    }
    return out;
  }

  // ── the matrix ────────────────────────────────────────────────────────────

  function build(ver, ecl, words, mask) {
    const size = ver * 4 + 17;
    const m = [], fn = [];
    for (let y = 0; y < size; y++) { m.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }     // timing
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const al = alignmentPositions(ver);
    al.forEach((ay, i) => al.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    drawFormat(set, size, ecl, mask);
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1, a = size - 11 + i % 3, b = Math.floor(i / 3);
        set(a, b, dark); set(b, a, dark);
      }
    }

    // The data, two columns at a time from the bottom right, up then down,
    // stepping over the vertical timing column.
    let bit = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
          if (fn[y][x]) continue;
          if (bit < words.length * 8) m[y][x] = ((words[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
          bit++;
        }
      }
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && masked(mask, x, y)) m[y][x] = !m[y][x];
    return m;
  }

  function drawFormat(set, size, ecl, mask) {
    const data = (ECC[ecl].bits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const b = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, b(i));
    set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, b(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, b(i));
    set(8, size - 8, true);                       // the dark module
  }

  function masked(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }

  // ISO 18004's four penalties: runs of five or more, 2×2 blocks, the finder
  // pattern's 1:1:3:1:1 with light either side, and the balance of dark.
  function penalty(m) {
    const n = m.length;
    let p = 0, dark = 0;
    const lines = [];
    for (let i = 0; i < n; i++) { lines.push(m[i]); lines.push(m.map(r => r[i])); }
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= n; i++) {
        if (i < n && line[i] === line[i - 1]) { run++; continue; }
        if (run >= 5) p += 3 + run - 5;
        run = 1;
      }
      const s = line.map(v => (v ? '1' : '0')).join('');
      const pad = '0000' + s + '0000';
      for (const pat of ['10111010000', '00001011101']) {
        for (let i = pad.indexOf(pat); i >= 0; i = pad.indexOf(pat, i + 1)) p += 40;
      }
    }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (m[y][x]) dark++;
      if (y < n - 1 && x < n - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    }
    p += Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
    return p;
  }

  function encode(text, opts) {
    opts = opts || {};
    const ecl = ECC[opts.ecl] ? opts.ecl : 'M';
    const bytes = utf8(String(text));
    let ver = Math.max(1, opts.minVersion || 1);
    while (ver <= MAX_VERSION && dataCodewords(ver, ecl) * 8 < 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8) ver++;
    if (ver > MAX_VERSION) throw new Error('too long for a QR code of version ' + MAX_VERSION + ' (' + bytes.length + ' bytes)');
    const words = codewords(bytes, ver, ecl);
    let best = null;
    const masks = opts.mask >= 0 && opts.mask <= 7 ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
    for (const mask of masks) {
      const modules = build(ver, ecl, words, mask);
      const score = masks.length > 1 ? penalty(modules) : 0;
      if (!best || score < best.score) best = { modules, mask, score };
    }
    return { size: ver * 4 + 17, version: ver, ecl, mask: best.mask, modules: best.modules };
  }

  // One path of unit squares, so it scales to any size without seams.
  function svg(text, opts) {
    const q = encode(text, opts), quiet = 4, n = q.size + quiet * 2;
    let d = '';
    q.modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z'; }));
    const label = (opts && opts.label) || 'QR code';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" role="img" aria-label="'
      + String(label).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) + '">'
      + '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path fill="#000" d="' + d + '"/></svg>';
  }

  // Two rows of modules per line of text. Dark modules are drawn as spaces and
  // light ones as blocks, so the code reads dark-on-light on the usual light-
  // on-dark terminal; `invert` for a terminal with a light background.
  function text(str, opts) {
    const q = encode(str, opts), quiet = 2, n = q.size + quiet * 2, inv = !!(opts && opts.invert);
    // Whether a half-cell is drawn: the light modules (quiet zone included),
    // or the dark ones when inverted; never the half-row past the bottom edge.
    const lit = (x, y) => {
      if (y >= n) return false;
      const mx = x - quiet, my = y - quiet;
      const dark = mx >= 0 && my >= 0 && mx < q.size && my < q.size && q.modules[my][mx];
      return inv ? dark : !dark;
    };
    const lines = [];
    for (let y = 0; y < n; y += 2) {
      let s = '';
      for (let x = 0; x < n; x++) {
        const top = lit(x, y), bottom = lit(x, y + 1);
        s += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
      }
      lines.push(s);
    }
    return lines;
  }

  return { encode, svg, text, _penalty: penalty, _dataCodewords: dataCodewords };
}));
