'use strict';
// What is on the end of a serial port, worked out from what it sends.
//
// Nothing about a USB-serial adapter says what is plugged into it, so the
// agent listens: every receiver it knows announces itself in its first lines.
//
//   ALERT2A,…                      ELPRO ERT-A2, RS-232 "ALERT2 ASCII" (9600 8N1)
//   "ALERT2" + length + TLVs       ELPRO ERT-A2, USB binary framing
//   HDR, DEC, BST, STA, EVT        Quansheng ALERT receiver firmware, schema 2
//                                  (USB console, or the K1 jack's UART at 38400)
//   ALERT,<id>,<value>,…           the older DP32G030 ALERT firmware's UART line (38400)
//   AB CD … DC BA                  Quansheng binary frames (its bootloader's beacons too)
//   $GPGGA, $GNRMC, …              an NMEA GPS
//
// ALERT (the 300-baud legacy protocol: Binary, Enhanced iFLOWS) and ALERT2
// differ by receiver: an ERT-A2 hears ALERT2, a Quansheng radio and an RTL-SDR
// hear ALERT. Every reading is tagged with its protocol on the way to MegaNet.
//
// A port at the wrong speed sends line noise — bytes outside printable ASCII,
// and no line ends. When enough of that arrives, the next speed is tried. A
// port that sends nothing at all is left where it is: silence says nothing
// about the speed, and an ERT-A2 can be quiet for an hour.

const { Alert2 } = require('../meganet-codecs');

const HUNT = [9600, 38400, 115200, 4800, 19200, 57600];
const MAX_KEEP = 8192;

function classifyText(text) {
  if (text.includes('ALERT2A,')) return { type: 'ert-a2', how: 'ALERT2A ASCII lines' };
  if (/(^|[\r\n])(HDR|DEC|BST|STA|EVT),/.test(text)) return { type: 'quansheng', how: 'ALERT firmware records (schema 2)' };
  if (/(^|[\r\n])ALERT,\d+,\d+,/.test(text)) return { type: 'quansheng', how: 'legacy ALERT firmware lines', legacy: true };
  if (/\$(GP|GN|GL|GA|GB|BD|GQ)(GGA|RMC|GSA|GSV|VTG|GLL|ZDA|GST|TXT),/.test(text)) return { type: 'gps', how: 'NMEA sentences' };
  return null;
}

function indexOfSeq(buf, seq, from) {
  outer: for (let i = from || 0; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}
const A2 = Buffer.from('ALERT2');

function classifyBinary(buf) {
  const at = indexOfSeq(buf, A2);
  // "ALERT2A," is the ASCII protocol's tag, not a binary frame (whose length
  // byte can be 0x41 too, so the comma is what tells them apart).
  if (at >= 0 && !(buf[at + 6] === 0x41 && buf[at + 7] === 0x2C)) {
    try {
      const out = Alert2.parseBinBytes(Array.from(buf.subarray(at)));
      if (out.frames.some(f => !f.error)) return { type: 'ert-a2', how: 'ERT-A2 USB binary frames', binary: true };
    } catch (_) {}
  }
  // A whole Quansheng binary frame: AB CD len16 … DC BA.
  for (let i = buf.indexOf(0xAB); i >= 0 && i + 8 <= buf.length; i = buf.indexOf(0xAB, i + 1)) {
    if (buf[i + 1] !== 0xCD) continue;
    const size = buf[i + 2] | (buf[i + 3] << 8);
    if (size > 512 || i + size + 8 > buf.length) continue;
    if (buf[i + size + 6] === 0xDC && buf[i + size + 7] === 0xBA) return { type: 'quansheng', how: 'Quansheng binary frames' };
  }
  return null;
}

// Share of bytes that could be text: printable ASCII, TAB, CR, LF.
function textiness(buf) {
  let ok = 0;
  for (const b of buf) if ((b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13) ok++;
  return buf.length ? ok / buf.length : 1;
}

class Sniffer {
  // opts: { baud, hunt (false for USB CDC ports, where the speed is ignored) }
  constructor(opts) {
    this.hunt = opts.hunt !== false;
    this.order = HUNT.slice();
    if (opts.baud && !this.order.includes(opts.baud)) this.order.unshift(opts.baud);
    this.i = Math.max(0, this.order.indexOf(opts.baud || HUNT[0]));
    this.buf = Buffer.alloc(0);
    this.noise = 0;
    this.tried = 0;
  }

  get baud() { return this.order[this.i]; }

  // → { type, how, legacy?, bytes } once known; { baud } to change speed; null to keep listening.
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > MAX_KEEP) this.buf = this.buf.subarray(this.buf.length - MAX_KEEP);
    const bin = classifyBinary(this.buf);
    if (bin) return Object.assign(bin, { bytes: this.buf });
    const text = this.buf.toString('latin1');
    const t = classifyText(text);
    if (t) return Object.assign(t, { bytes: this.buf });
    if (!this.hunt) return null;
    // Noise: judged on the last 256 bytes once there are that many, or on a
    // long run with no line end at all (text protocols here all end lines).
    const tail = this.buf.subarray(Math.max(0, this.buf.length - 256));
    const noisy = (this.buf.length >= 96 && textiness(tail) < 0.75)
      || (this.buf.length >= 1024 && !/[\r\n]/.test(text.slice(-1024)) && indexOfSeq(this.buf, A2) < 0);
    if (!noisy) return null;
    this.i = (this.i + 1) % this.order.length;
    this.tried++;
    this.buf = Buffer.alloc(0);
    return { baud: this.baud };
  }
}

module.exports = { Sniffer, classifyText, classifyBinary, textiness, HUNT };
