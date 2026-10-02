'use strict';
// web/qr.js, the QR code the dashboard shows beside a token request's code:
// held module for module to an independent encoder (python-qrcode 8.2, in
// test/fixtures/qr-reference.json — versions 1, 3, 7 and 10, so the version
// block and the alignment grid are both covered), plus the properties a phone
// camera depends on. When it was written, 351 cases across every mask and
// error correction level were compared with python-qrcode the same way and
// every auto-masked one decoded with OpenCV; the fixture keeps five of them.

const test = require('node:test');
const assert = require('node:assert/strict');
const QR = require('../web/qr.js');
const ref = require('./fixtures/qr-reference.json');

test('QR: the same modules as an independent encoder, for each version, level and mask in the fixture', () => {
  for (const c of ref.cases) {
    const q = QR.encode(c.text, { ecl: c.ecl, mask: c.mask });
    assert.equal(q.version, c.version, c.text.slice(0, 20) + ': version');
    const rows = q.modules.map(r => r.map(b => (b ? '1' : '0')).join(''));
    assert.deepEqual(rows, c.rows, c.text.slice(0, 20) + ' (' + c.ecl + ', v' + c.version + ', mask ' + c.mask + ')');
  }
});

test('QR: left to itself, it picks the smallest version and a mask, and draws the pairing link as version 3', () => {
  const q = QR.encode('https://floodwarning.net/#pair=WDJB-MJHT', { ecl: 'M' });
  assert.equal(q.version, 3);
  assert.equal(q.size, 29);
  assert.ok(q.mask >= 0 && q.mask <= 7);
  assert.equal(QR.encode('a').version, 1);
  assert.throws(() => QR.encode('x'.repeat(300), { ecl: 'H' }), /too long/);
});

test('QR: SVG and terminal text carry a quiet zone and nothing else', () => {
  const svg = QR.svg('https://floodwarning.net/#pair=WDJB-MJHT', { label: 'Open "MegaNet"' });
  assert.match(svg, /^<svg [^>]*viewBox="0 0 37 37"/);         // 29 modules + 4 each side
  assert.match(svg, /aria-label="Open &quot;MegaNet&quot;"/);
  assert.ok(!/<script/i.test(svg));
  const lines = QR.text('HELLO', { ecl: 'M' });
  assert.equal(lines.length, Math.ceil((21 + 4) / 2));
  assert.ok(lines.every(l => [...l].length === 25 && /^[█▀▄ ]+$/.test(l)));
  assert.equal(lines[0], '█'.repeat(25), 'the quiet zone is light');
});
