'use strict';
// Recognising a device from what it sends, and each driver turning its lines
// into readings and receptions — no hardware, no ports.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Sniffer, classifyText } = require('../lib/devices/sniff');
const { QuanshengDriver } = require('../lib/devices/quansheng');
const { ErtDriver, onDayNearest } = require('../lib/devices/ert');
const { GpsDriver, utcOf } = require('../lib/devices/gps');
const { Alert2 } = require('../lib/meganet-codecs');

function nmea(body) { let c = 0; for (const ch of body) c ^= ch.charCodeAt(0); return '$' + body + '*' + c.toString(16).toUpperCase().padStart(2, '0') + '\r\n'; }

function ctx(over) {
  const out = { readings: [], receptions: [], events: [], written: [], dtr: 0 };
  const c = Object.assign({
    log: { debug() {}, info() {}, warn() {}, error() {} },
    port: { acm: true },
    clock: { trusted: () => true, now: () => Date.now() },
    write: (s) => { out.written.push(s); return Promise.resolve(); },
    reading: (r) => out.readings.push(r),
    reception: (r) => out.receptions.push(r),
    event: (t, d) => out.events.push([t, d]),
    toggleDtr: () => { out.dtr++; },
  }, over || {});
  return { c, out };
}

test('sniff: each receiver is recognised from its first lines', () => {
  assert.equal(classifyText('ALERT2A,1,9999,ELPRO,N,1').type, 'ert-a2');
  assert.equal(classifyText('junk\r\nSTA,,31000,-119\r\n').type, 'quansheng');
  assert.equal(classifyText('ALERT,6129,1599,ABF,-87,LOUDOUN BR\r\n').legacy, true);
  assert.equal(classifyText('$GNRMC,1,2,3').type, 'gps');
  assert.equal(classifyText('hello world\r\n'), null);
});

test('sniff: ERT-A2 binary framing is recognised from a whole frame', () => {
  const s = new Sniffer({ baud: 9600, hunt: true });
  const bytes = Alert2.hexStream('41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 0D 84 11 18 00 0D 00 10 70 07 27 0F 74 86 1C 0E 10 0A 00 A1 A1 A1 A1 A1 A1 A1 A1 A1 84 12 01 00 14 17 84 00 06 00 10 70 07 27 0F 84 01 07 74 86 1C 0E 10 0A 00 9C 2F 01 94').bytes;
  const r = s.feed(Buffer.from(bytes));
  assert.equal(r.type, 'ert-a2'); assert.equal(r.binary, true);
});

test('sniff: line noise moves to the next speed; silence and good text do not', () => {
  const s = new Sniffer({ baud: 9600, hunt: true });
  assert.equal(s.feed(Buffer.from('partial line with no end yet')), null);
  const noise = Buffer.alloc(200); for (let i = 0; i < noise.length; i++) noise[i] = (i * 73 + 128) & 0xff;
  const r = s.feed(noise);
  assert.equal(r.baud, 38400);
  const usb = new Sniffer({ baud: 115200, hunt: false });
  assert.equal(usb.feed(noise), null, 'a USB CDC port never hunts');
});

test('Quansheng: a DEC is a reading (protocol alert) and a reception; an empty burst is an undecoded reception', () => {
  const { c, out } = ctx();
  const d = new QuanshengDriver(c);
  d.feed(Buffer.from('HDR,fw,4d06107f,schema,2\r\nDEC,1041,1790843886,187340,12,2088,MARBURG,BATT,143,14.3,V,ABF,STD,1,0,-20,-121,-109,89,412,16067B23,00010110000001100111101100100011\r\n'
    + 'BST,15,1790843919,220510,-47,-121,530,0,138,0000004B599711DC6B599621FC0009C30440\r\nSTA,1790843970,270000,-121,-124,0,7890,78,16,18,-104,OK,1045,5969,BUILTIN MegaNet:95f6f8d\r\n'));
  assert.equal(out.readings.length, 1);
  const r = out.readings[0];
  assert.deepEqual([r.alert_id, r.value_raw, r.protocol, r.fmt, r.rssi_dbm], [2088, 143, 'alert', 'ABF', -20]);
  assert.ok(r.line.startsWith('DEC,1041'));
  assert.equal(out.receptions.length, 2);
  assert.equal(out.receptions[1].fault, 'undecoded');
  assert.equal(d.status().battery.pct, 78);
  assert.equal(d.status().firmware, '4d06107f');
});

test('Quansheng: the legacy DP32G030 line is a reading too', () => {
  const { c, out } = ctx({ port: { acm: false } });
  const d = new QuanshengDriver(c);
  d.feed(Buffer.from('ALERT,6129,1599,ABF,-87,LOUDOUN BR\r\n'));
  assert.deepEqual([out.readings[0].alert_id, out.readings[0].value_raw, out.readings[0].rssi_dbm, out.readings[0].name], [6129, 1599, -87, 'LOUDOUN BR']);
  assert.equal(d.status().legacy, true);
});

test('Quansheng: console commands go one at a time and finish on OK; the clock is set on connect', async () => {
  const { c, out } = ctx();
  const d = new QuanshengDriver(c);
  const a = d.command('TIME 1790843760');
  const b = d.command('INFO');
  assert.deepEqual(out.written, ['TIME 1790843760\r'], 'the second waits for the first');
  d.feed(Buffer.from('OK\r\nEVT,1790843760,61020,CLOCK,SET\r\n'));
  await a;
  assert.deepEqual(out.written, ['TIME 1790843760\r', 'INFO\r']);
  d.feed(Buffer.from('INFO,fw,4d06107f\r\nINFO,stn,BUILTIN MegaNet:95f6f8d,443,BUILTIN\r\nGET,FREQ_MHZ,151.500\r\nOK\r\n'));
  const res = await b;
  assert.equal(res.lines.length, 3);
  assert.equal(d.settings.FREQ_MHZ, '151.500');
  const e = d.command('SET SNR_REQ 99');
  d.feed(Buffer.from('ERR,RANGE\r\n'));
  await assert.rejects(e, /RANGE/);
});

test('Quansheng: 25 s of silence on USB toggles DTR; on the UART it does not', () => {
  const { c, out } = ctx();
  const d = new QuanshengDriver(c);
  d.lastByte = Date.now() - 26000;
  d.tick(Date.now());
  assert.equal(out.dtr, 1);
  const u = ctx({ port: { acm: false } });
  const d2 = new QuanshengDriver(u.c);
  d2.lastByte = Date.now() - 60000;
  d2.tick(Date.now());
  assert.equal(u.out.dtr, 0);
});

test('ERT-A2: clean records are readings (protocol alert2) timed by the frame; a bad frame is only receptions', () => {
  const now = new Date(2026, 5, 8, 19, 29, 0).getTime();
  const { c, out } = ctx({ clock: { trusted: () => true, now: () => now } });
  const d = new ErtDriver(c);
  // Payload time 0x6920 = 26912 s = 07:28:32 — 12 h from the receiver's own clock in this capture.
  d.feed(Buffer.from('ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,28,32.582,0,0,0,0,0,1,0,0,0,7,11,9999,74,69,20,2D,13,8A,00,2C,13,0C,00\r\n'));
  assert.deepEqual(out.readings.map(r => [r.alert_id, r.value_raw, r.protocol]), [[4909, 138, 'alert2'], [4908, 12, 'alert2']]);
  // 07:28:32 is more than ten minutes from 19:29: timed by arrival instead.
  assert.equal(out.readings[0].ts, now);
  d.feed(Buffer.from('ALERT2A,1,9999,ELPRO,N,1,2026,6,8,20,51,10.161,0,0,0,0,0,0,0,0,0,1,19,9999,74,7C,7E,01,0E,08,11,81,07,23,FF,FB,21,00,14,00,00,00,08\r\n'));
  assert.equal(out.readings.length, 2, 'nothing from the frame the receiver called bad');
  assert.ok(out.receptions.slice(2).every(r => r.ok === false));
});

test('ERT-A2: a frame time within ten minutes is put on the nearest day', () => {
  const ref = new Date(2026, 5, 9, 0, 2, 0).getTime();
  const ts = onDayNearest(23 * 3600 + 59 * 60, ref);          // 23:59 heard at 00:02 → yesterday
  assert.equal(ts, new Date(2026, 5, 8, 23, 59, 0).getTime());
});

test('GPS: a fix, its accuracy, and the receiver\'s UTC time', () => {
  const { c, out } = ctx();
  const g = new GpsDriver(c);
  g.feed(Buffer.from(nmea('GPGGA,123519,2727.000,S,15301.500,E,1,08,0.9,545.4,M,46.9,M,,') + nmea('GPRMC,123519,A,2727.000,S,15301.500,E,000.0,084.4,021026,,')));
  const f = g.current();
  assert.ok(f && Math.abs(f.lat + 27.45) < 1e-6 && Math.abs(f.lon - 153.025) < 1e-6);
  assert.equal(f.accuracy_m, 5);
  assert.ok(out.events.some(([t, d]) => t === 'gps-time' && d.ms === Date.UTC(2026, 9, 2, 12, 35, 19)));
  assert.equal(utcOf('123519.5', '021026'), Date.UTC(2026, 9, 2, 12, 35, 19, 500));
});
