'use strict';
// Which stick an rtl_sdr opens. `rtl_sdr -d` takes a device number or a serial
// number, and sticks often share a serial (most leave the factory as
// 00000001), so with more than one plugged in the agent:
//
//   1. names the stick by its serial when no other stick has it and rtl_sdr
//      will not read it as a number (it tries strtol(…, 0) first, so
//      "00000001" is device 1);
//   2. else by device number: the one already seen to open this stick; else
//      among the numbers not seen to open another stick (and not just found
//      busy), one whose line in rtl_sdr's own device list ("0:  Realtek,
//      RTL2838UHIDIR, SN: 00000001") is this stick's, preferring the number
//      librtlsdr should give it (scan.js);
//   3. then checks which stick rtl_sdr really opened — the /dev/bus/usb node
//      it holds, among its open files in /proc — and remembers the answer.
//      The wrong stick is closed again and the right number used (sdr.js).
//
// Device numbers move when a stick is plugged in or out, so what was learnt is
// forgotten then. A running rtl_sdr is not disturbed by that: it keeps its
// stick until it exits.

const fs = require('node:fs');
const path = require('node:path');

// What strtol(s, &end, 0) reads to the end: decimal, octal (leading 0), hex (0x).
const NUMERIC = /^\s*[+-]?(0[xX][0-9a-fA-F]+|[0-9]+)$/;

function serialSelects(serial, sticks) {
  return !!serial && !NUMERIC.test(serial) && sticks.filter(s => s.serial === serial).length === 1;
}

// A stick as rtl_sdr's device list shows it: "<maker>, <model>, SN: <serial>".
function listingText(st) { return ((st.manufacturer || '') + ', ' + (st.product || '') + ', SN: ' + (st.serial || '')).trim(); }

// The USB device a process holds open, from the /dev/bus/usb/BBB/DDD node
// among its file descriptors: { busnum, devnum }, or null if it cannot be told.
function openedUsb(pid) {
  const dir = '/proc/' + pid + '/fd';
  let fds;
  try { fds = fs.readdirSync(dir); } catch (_) { return null; }
  for (const fd of fds) {
    let to;
    try { to = fs.readlinkSync(path.join(dir, fd)); } catch (_) { continue; }
    const m = /\/bus\/usb\/(\d+)\/(\d+)$/.exec(to);
    if (m) return { busnum: Number(m[1]), devnum: Number(m[2]) };
  }
  return null;
}

class RtlIndex {
  constructor() {
    this.sticks = [];
    this.sig = null;
    this.known = new Map();     // USB port → device number, seen to open it
    this.listed = null;         // [{ index, text }] from an rtl_sdr's device list
  }

  // The sticks plugged in now (scan.js), every scan.
  update(sticks) {
    this.sticks = sticks;
    const sig = sticks.map(s => s.busPath + '#' + s.devnum).sort().join(',');
    if (sig !== this.sig) { this.sig = sig; this.known.clear(); this.listed = null; }
  }

  // rtl_sdr's list of devices, from one launch: [{ index, text }].
  listing(rows) { if (rows && rows.length && rows.length === this.sticks.length) this.listed = rows; }

  // Device `index` opened the stick in USB port `busPath`.
  learn(index, busPath) {
    for (const [b, i] of this.known) if (b === busPath || i === index) this.known.delete(b);
    this.known.set(busPath, index);
  }

  // The -d argument for `stick`: { arg, index (null for a serial), how }, how
  // being 'only' (the one stick), 'serial', 'seen' (a number seen to open it)
  // or 'guess'. `avoid`: numbers that were just busy for this stick.
  choose(stick, avoid) {
    const sticks = this.sticks;
    if (sticks.length <= 1) return { arg: '0', index: 0, how: 'only' };
    if (serialSelects(stick.serial, sticks)) return { arg: stick.serial, index: null, how: 'serial' };
    if (this.known.has(stick.busPath)) { const i = this.known.get(stick.busPath); return { arg: String(i), index: i, how: 'seen' }; }
    const others = new Set([...this.known].map(([, i]) => i));
    let cands = sticks.map((s, i) => i).filter(i => !others.has(i));
    if (this.listed) {
      const mine = listingText(stick);
      const same = cands.filter(i => this.listed.some(r => r.index === i && r.text === mine));
      if (same.length) cands = same;
    }
    const fresh = cands.filter(i => !(avoid && avoid.has(i)));
    if (fresh.length) cands = fresh;
    const index = cands.includes(stick.index) ? stick.index : cands.length ? cands[0] : (stick.index || 0);
    return { arg: String(index), index, how: 'guess' };
  }
}

module.exports = { RtlIndex, serialSelects, listingText, openedUsb };
