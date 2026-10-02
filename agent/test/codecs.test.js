'use strict';
// The vendored MegaNet decoders, under Node, against the vectors MegaNet holds
// them to: a real off-air burst, the ERT-A2 reference capture's lines and
// frames, the radio firmware's documented DEC lines, and NMEA.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AlertDsp, Quansheng, Alert2, Nmea } = require('../lib/meganet-codecs');

// alert2.js runs in a V8 context of its own, so its arrays have that context's
// Array prototype: compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('off-air: the 4078 test rig burst decodes as MegaNet requires (Enhanced iFLOWS)', () => {
  const iq = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'testrig_burst_240k.iq8')));
  const r = AlertDsp.decodeU8(iq, { format: AlertDsp.ENHANCED_IFLOWS });
  const got = (id) => r.readings.find(x => x.sensorId === id);
  assert.equal(got(4079) && got(4079).value, 420);
  assert.equal(got(4080) && got(4080).value, 121);
  assert.ok(r.readings.every(x => x.crcOk === true));
});

test('off-air: one format at a time — the rig burst read as ALERT Binary is nothing', () => {
  const iq = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'testrig_burst_240k.iq8')));
  const r = AlertDsp.decodeU8(iq, { format: AlertDsp.BINARY });
  assert.equal(r.readings.filter(x => [4079, 4080].includes(x.sensorId)).length, 0);
});

test('off-air: a synthesised Binary burst 200 kHz off centre at 960 ksps decodes through the live pipeline', () => {
  const rate = 960000, off = 240000;
  const got = [];
  const p = new AlertDsp.Pipeline((m) => { if (m.type === 'decode') got.push(...m.readings); });
  p.configure({ deviceRate: rate, channelOffsetHz: off, format: AlertDsp.BINARY, specHz: 1, scopeHz: 1 });
  const iq = AlertDsp.synthIq({ fs: rate, seconds: 4, snrDb: 25, bursts: [{ startSec: 1.5, cfoHz: off, amp: 40, polarity: 'NEG',
    frames: [AlertDsp.encodeFrame(AlertDsp.BINARY, 6129, 1599), AlertDsp.encodeFrame(AlertDsp.BINARY, 6130, 134)] }] });
  for (let o = 0; o < iq.length; o += rate / 5) p.feed(iq.subarray(o, o + rate / 5));
  const ids = got.map(r => r.sensorId + '=' + r.value).sort();
  assert.deepEqual(ids, ['6129=1599', '6130=134']);
});

test('ERT-A2 ASCII: the reference lines parse to their records', () => {
  const f = Alert2.parseAscii('ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,28,32.582,0,0,0,0,0,1,0,0,0,7,11,9999,74,69,20,2D,13,8A,00,2C,13,0C,00').frames;
  assert.equal(f.length, 1);
  assert.deepEqual(plain(f[0].records.map(r => [r.alertId, r.value, r.ok])), [[4909, 138, true], [4908, 12, true]]);
  assert.equal(f[0].hdr.frameOk, 1);
  assert.equal(f[0].payload.sod, 0x6920);
});

test('ERT-A2 ASCII: the frame the receiver flagged bad says so', () => {
  const f = Alert2.parseAscii('ALERT2A,1,9999,ELPRO,N,1,2026,6,8,20,51,10.161,0,0,0,0,0,0,0,0,0,1,19,9999,74,7C,7E,01,0E,08,11,81,07,23,FF,FB,21,00,14,00,00,00,08').frames[0];
  assert.equal(f.hdr.frameOk, 0);
  assert.ok(f.records.some(r => !r.ok));
});

test('ERT-A2 USB binary: frames carry readings and RSSI', () => {
  const hex = '41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 0D 84 11 18 00 0D 00 10 70 07 27 0F 74 86 1C 0E 10 0A 00 A1 A1 A1 A1 A1 A1 A1 A1 A1 84 12 01 00 14 17 84 00 06 00 10 70 07 27 0F 84 01 07 74 86 1C 0E 10 0A 00 9C 2F 01 94';
  const bytes = Alert2.hexStream(hex).bytes;
  const out = Alert2.parseBinBytes(Array.from(bytes));
  assert.equal(out.frames.length, 1);
  assert.equal(out.frames[0].hdr.rssi, -108);
  assert.deepEqual(plain(out.frames[0].records.map(r => [r.alertId, r.value])), [[4110, 10]]);
});

test('Quansheng: documented DEC lines decode by name, and their payload re-decodes', () => {
  const schema = Quansheng.createSchema();
  const p = Quansheng.parseRecord(schema, 'DEC,1041,1790843886,187340,12,2088,MARBURG,BATT,143,14.3,V,ABF,STD,1,0,-20,-121,-109,89,412,16067B23,00010110000001100111101100100011');
  assert.equal(p.type, 'DEC');
  assert.equal(p.rec.id, 2088); assert.equal(p.rec.value, 143); assert.equal(p.rec.rssi, -20); assert.equal(p.rec.fmt, 'ABF');
  assert.deepEqual(Quansheng.decodePayload32(p.rec.payload_hex), { fmt: 'ABF', id: 2088, value: 143 });
  const eif = Quansheng.parseRecord(schema, 'DEC,7,,95230,,3001,,,57,57,,EIF,NEG,0,0,-61,-119,-107,46,380,9F753812,10011111011101010011100000010010');
  assert.equal(eif.rec.epoch, null);
  assert.deepEqual(Quansheng.decodePayload32('9F753812'), { fmt: 'EIF', id: 3001, value: 57 });
});

test('NMEA: GGA and RMC parse, and a bad checksum is refused', () => {
  const gga = Nmea.parse('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47');
  assert.equal(gga.type, 'GGA');
  assert.ok(Math.abs(gga.lat - 48.1173) < 1e-4 && Math.abs(gga.lon - 11.51667) < 1e-4);
  assert.equal(Nmea.parse('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*00').type, 'bad');
  const rmc = Nmea.parse('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A');
  assert.equal(rmc.type, 'RMC'); assert.equal(rmc.valid, true);
});
