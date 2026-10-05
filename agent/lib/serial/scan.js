'use strict';
// What is plugged in, read straight out of sysfs and /dev — no udev library,
// no lsusb. Called every couple of seconds by the device manager; cheap.

const fs = require('node:fs');
const path = require('node:path');

const SYS = process.env.RPI_ALERT_SYSFS || '/sys';
const DEV = process.env.RPI_ALERT_DEV || '/dev';

function read(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return null; } }

// The USB device a tty hangs off: walk up from its sysfs node to the first
// directory carrying idVendor.
function usbInfoFor(sysNode) {
  let dir;
  try { dir = fs.realpathSync(sysNode); } catch (_) { return null; }
  for (let i = 0; i < 8 && dir && dir !== '/'; i++) {
    const vid = read(path.join(dir, 'idVendor'));
    if (vid) {
      return {
        vid, pid: read(path.join(dir, 'idProduct')),
        serial: read(path.join(dir, 'serial')), manufacturer: read(path.join(dir, 'manufacturer')),
        product: read(path.join(dir, 'product')), busPath: path.basename(dir),
      };
    }
    dir = path.dirname(dir);
  }
  return null;
}

// /dev/serial/by-id and by-path, reversed: real node → link.
function links(kind) {
  const out = new Map();
  const d = path.join(DEV, 'serial', kind);
  let names = [];
  try { names = fs.readdirSync(d); } catch (_) { return out; }
  for (const n of names) {
    try { out.set(fs.realpathSync(path.join(d, n)), path.join(d, n)); } catch (_) {}
  }
  return out;
}

// Every serial port worth looking at: USB CDC-ACM (ttyACM*, the Quansheng radio
// and many GPS pucks), USB-serial adapters (ttyUSB*: FTDI, CH340, CP210x,
// PL2303 — an ERT-A2's RS-232, a programming cable), plus any extra paths the
// settings name (the GPIO UART, /dev/serial0).
function listPorts(extra) {
  let names = [];
  try { names = fs.readdirSync(DEV).filter(n => /^tty(ACM|USB)\d+$/.test(n)); } catch (_) {}
  const byId = links('by-id'), byPath = links('by-path');
  const ports = names.map(n => {
    const dev = path.join(DEV, n);
    const usb = usbInfoFor(path.join(SYS, 'class', 'tty', n, 'device'));
    const id = byId.get(dev) || null;
    return {
      dev, name: n, acm: n.startsWith('ttyACM'), byId: id, byPath: byPath.get(dev) || null, usb,
      // The key a port is remembered by: the by-id link names the device itself
      // (vendor, model, serial number) wherever it is plugged in; by-path names
      // the socket, for devices with no serial number to tell them apart.
      key: id || byPath.get(dev) || dev,
      driver: driverOf(n),
    };
  });
  for (const x of extra || []) {
    let real;
    try { real = fs.realpathSync(x); } catch (_) { continue; }
    if (ports.some(p => p.dev === real)) continue;
    ports.push({ dev: real, name: path.basename(real), acm: false, byId: null, byPath: null, usb: null, key: x, driver: driverOf(path.basename(real)), extra: true });
  }
  return ports;
}

// cdc_acm, ftdi_sio, ch341-uart, cp210x, pl2303 …
function driverOf(n) {
  try { return path.basename(fs.realpathSync(path.join(SYS, 'class', 'tty', n, 'device', 'driver'))); } catch (_) { return null; }
}

// RTL2832U sticks, by USB id (librtlsdr's own list, the common part of it).
const RTL_IDS = new Set([
  '0bda:2832', '0bda:2838', '0413:6680', '0413:6f0f', '0458:707f', '0ccd:00a9', '0ccd:00b3', '0ccd:00b4',
  '0ccd:00b5', '0ccd:00b7', '0ccd:00b8', '0ccd:00b9', '0ccd:00c0', '0ccd:00c6', '0ccd:00d3', '0ccd:00d7',
  '0ccd:00e0', '1554:5020', '15f4:0131', '15f4:0133', '185b:0620', '185b:0650', '185b:0680', '1b80:d393',
  '1b80:d394', '1b80:d395', '1b80:d397', '1b80:d398', '1b80:d39d', '1b80:d3a4', '1b80:d3a8', '1b80:d3af',
  '1b80:d3b0', '1d19:1101', '1d19:1102', '1d19:1103', '1d19:1104', '1f4d:a803', '1f4d:b803', '1f4d:c803',
  '1f4d:d286', '1f4d:d803',
]);

// Every RTL2832U stick plugged in, by its USB port (busPath, e.g. "1-1.3"), in
// the order librtlsdr numbers them (`index`, what rtl_sdr -d takes). Which
// stick is which receiver is the device manager's business (state.js
// remembers them), not this list's: it says only what is plugged in where.
function listSdrs() {
  const root = path.join(SYS, 'bus', 'usb', 'devices');
  let names = [];
  try { names = fs.readdirSync(root).filter(n => !n.includes(':')); } catch (_) {}
  const out = [];
  for (const n of names) {
    const d = path.join(root, n);
    const vid = read(path.join(d, 'idVendor')), pid = read(path.join(d, 'idProduct'));
    if (!vid || !RTL_IDS.has(vid + ':' + pid)) continue;
    let real = d;
    try { real = fs.realpathSync(d); } catch (_) {}
    out.push({
      busPath: n, vid, pid, serial: read(path.join(d, 'serial')) || '',
      manufacturer: read(path.join(d, 'manufacturer')) || '', product: read(path.join(d, 'product')) || '',
      busnum: Number(read(path.join(d, 'busnum'))), devnum: Number(read(path.join(d, 'devnum'))),
      devpath: real.startsWith(SYS + '/') ? real.slice(SYS.length) : real,
    });
  }
  return rtlOrder(out);
}

// librtlsdr's device numbers. It counts the sticks in libusb_get_device_list()
// order. On Linux libusb finds devices through udev, which lists them in
// device-path order (systemd's path_compare), and puts each one it finds at
// the head of its list — so the numbers run in reverse device-path order:
// device 0 is the stick that sorts last. This is the agent's guess; it checks
// which stick each rtl_sdr really opened (devices/rtl-index.js), so a libusb
// that orders them some other way costs a reopen, not the wrong stick.
function rtlOrder(sticks) {
  const out = sticks.slice().sort((a, b) => pathCompare(b.devpath, a.devpath));
  out.forEach((s, i) => { s.index = i; });
  return out;
}

// USB ports as people count them: 1-1.2 before 1-1.10.
function portCompare(a, b) {
  const A = String(a || '').split(/[-.:]/), B = String(b || '').split(/[-.:]/);
  for (let i = 0; i < A.length && i < B.length; i++) {
    const d = (Number(A[i]) - Number(B[i])) || (A[i] < B[i] ? -1 : A[i] > B[i] ? 1 : 0);
    if (d) return d;
  }
  return A.length - B.length;
}

// systemd's path_compare(): component by component, bytewise, a shorter
// component (or path) first.
function pathCompare(a, b) {
  const A = String(a || '').split('/').filter(Boolean), B = String(b || '').split('/').filter(Boolean);
  for (let i = 0; i < A.length && i < B.length; i++) {
    if (A[i] === B[i]) continue;
    for (let j = 0; j < A[i].length && j < B[i].length; j++) {
      const d = A[i].charCodeAt(j) - B[i].charCodeAt(j);
      if (d) return d;
    }
    return A[i].length - B[i].length;
  }
  return A.length - B.length;
}

// What kind of Raspberry Pi this is, for sensible defaults.
function board() {
  const model = (read('/proc/device-tree/model') || read(path.join(SYS, 'firmware', 'devicetree', 'base', 'model')) || '').replace(/\0/g, '');
  let cores = 1;
  try { cores = require('node:os').cpus().length || 1; } catch (_) {}
  let memMb = 0;
  try { memMb = Math.round(require('node:os').totalmem() / 1048576); } catch (_) {}
  return { model, cores, memMb };
}

module.exports = { listPorts, listSdrs, rtlOrder, pathCompare, portCompare, usbInfoFor, board, RTL_IDS };
