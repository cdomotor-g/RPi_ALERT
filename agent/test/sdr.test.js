'use strict';
// Several RTL-SDR sticks, piece by piece: which stick is which receiver
// (state.js), which device number opens which stick (scan.js, rtl-index.js),
// and each stick's own settings (config.js, sdr.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { State } = require('../lib/state');
const { Config } = require('../lib/config');
const { rtlOrder, pathCompare } = require('../lib/serial/scan');
const { RtlIndex, serialSelects, openedUsb } = require('../lib/devices/rtl-index');
const { SdrSession } = require('../lib/devices/sdr');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const blogV4 = (busPath, devnum, serial) => ({ busPath, vid: '0bda', pid: '2838', manufacturer: 'RTLSDRBlog', product: 'Blog V4', serial: serial || '00000001', busnum: 1, devnum: devnum || 4 });
const keysOf = (st, sticks) => sticks.map(s => st.assignSdrs(sticks).get(s));

test('sticks: a second stick with the same serial leaves the first its key', () => {
  const st = new State(tmp('rpa-st-')).load();
  const a = blogV4('1-1.3', 4);
  assert.deepEqual(keysOf(st, [a]), ['sdr-serial:00000001']);
  const b = blogV4('1-1.4', 5);
  assert.deepEqual(keysOf(st, [a, b]), ['sdr-serial:00000001', 'sdr-port:1-1.4']);
  assert.deepEqual(keysOf(st, [b, a]), ['sdr-port:1-1.4', 'sdr-serial:00000001'], 'whatever order they are listed in');
  assert.deepEqual([st.pointFor('sdr-serial:00000001', 'sdr').n, st.pointFor('sdr-port:1-1.4', 'sdr').n], [1, 2]);
  // The first unplugged, the second alone: still the second.
  assert.deepEqual(keysOf(st, [b]), ['sdr-port:1-1.4']);
});

test('sticks: one with a serial of its own keeps its key in any port; another model in a known port is new', () => {
  const st = new State(tmp('rpa-st-')).load();
  const one = blogV4('1-1.3', 4, 'ALERT1');
  assert.deepEqual(keysOf(st, [one]), ['sdr-serial:ALERT1']);
  const moved = blogV4('1-1.2', 7, 'ALERT1');
  assert.deepEqual(keysOf(st, [moved]), ['sdr-serial:ALERT1']);
  assert.equal(st.sdrInfo('sdr-serial:ALERT1').busPath, '1-1.2', 'where it is now');
  const v3 = Object.assign(blogV4('1-1.2', 8), { manufacturer: 'Realtek', product: 'RTL2838UHIDIR' });
  assert.deepEqual(keysOf(st, [v3]), ['sdr-serial:00000001'], 'a V3 in the port the ALERT1 stick left is a new stick');
  assert.equal(st.sdrEntries().length, 2);
});

test('sticks: identical sticks moved to other ports keep their keys, not new ones', () => {
  const st = new State(tmp('rpa-st-')).load();
  keysOf(st, [blogV4('1-1.3', 4), blogV4('1-1.4', 5)]);
  const keys = keysOf(st, [blogV4('1-1.1', 9), blogV4('1-1.2', 10)]);
  assert.deepEqual(keys.slice().sort(), ['sdr-port:1-1.4', 'sdr-serial:00000001']);
  assert.equal(st.sdrEntries().length, 2);
});

test('sticks: 0.4\'s receiver ids are kept — by port for a shared serial, by serial for one stick', () => {
  // The state a Pi was left in when a second stick renamed the first.
  const dir = tmp('rpa-st-');
  const points = (keys) => Object.fromEntries(keys.map(([k, n]) => ['sdr|' + k, { pointId: 'rpi-abc-sdr' + n, kind: 'sdr', n }]));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ hostId: 'abc', points: points([['sdr-serial:00000001', 1], ['sdr-port:1-1.3', 2], ['sdr-port:1-1.4', 3]]) }));
  const st = new State(dir).load();
  assert.deepEqual(keysOf(st, [blogV4('1-1.3', 4), blogV4('1-1.4', 5)]), ['sdr-port:1-1.3', 'sdr-port:1-1.4']);
  assert.equal(st.sdrEntries().length, 2, 'the old id nothing answers to is not shown as a stick');
  // One stick, as most Pis had: its id by serial, whichever port.
  const dir2 = tmp('rpa-st-');
  fs.writeFileSync(path.join(dir2, 'state.json'), JSON.stringify({ hostId: 'abc', points: points([['sdr-serial:00000001', 1]]) }));
  const st2 = new State(dir2).load();
  assert.deepEqual(keysOf(st2, [blogV4('1-1.2', 4)]), ['sdr-serial:00000001']);
  assert.equal(st2.pointFor('sdr-serial:00000001', 'sdr').pointId, 'rpi-abc-sdr1');
});

test('sticks: a forgotten stick frees its receiver id and its key', () => {
  const st = new State(tmp('rpa-st-')).load();
  const [ka, kb] = keysOf(st, [blogV4('1-1.3', 4), blogV4('1-1.4', 5)]);
  st.pointFor(ka, 'sdr'); st.pointFor(kb, 'sdr');
  st.forgetSdr(ka);
  assert.equal(st.sdrInfo(ka), null);
  assert.deepEqual(keysOf(st, [blogV4('1-1.4', 5), blogV4('1-1.2', 6)]), [kb, 'sdr-serial:00000001']);
  assert.equal(st.pointFor('sdr-serial:00000001', 'sdr').n, 1, 'the free number');
});

test('device numbers: librtlsdr\'s are libusb\'s order, reverse device-path order', () => {
  assert.ok(pathCompare('/devices/x/usb1/1-1/1-1.10', '/devices/x/usb1/1-1/1-1.2') < 0, 'byte by byte within a component');
  assert.ok(pathCompare('/devices/x/usb1/1-1', '/devices/x/usb1/1-1/1-1.2') < 0, 'a parent first');
  assert.ok(pathCompare('/devices/x/usb1/1-1/1-1.3/1-1.3.1', '/devices/x/usb1/1-1/1-1.4') < 0, 'by component, not by string');
  assert.ok(pathCompare('/devices/a/usb1-x', '/devices/a/usb1/1-1') > 0, 'a shorter component first ("/" is not compared)');
  const base = '/devices/platform/scb/fd500000.pcie/pci0000:00/0000:00:00.0/0000:01:00.0/usb1/1-1/';
  const sticks = rtlOrder([{ busPath: '1-1.3', devpath: base + '1-1.3' }, { busPath: '1-1.4', devpath: base + '1-1.4' }, { busPath: '1-1.1', devpath: base + '1-1.1' }]);
  assert.deepEqual(sticks.map(s => s.busPath + '=' + s.index), ['1-1.4=0', '1-1.3=1', '1-1.1=2']);
});

test('device numbers: by serial when it names one stick and is not a number; else a number, checked', () => {
  const two = [blogV4('1-1.3', 4), blogV4('1-1.4', 5)];
  assert.equal(serialSelects('00000001', two), false, 'shared');
  assert.equal(serialSelects('00000002', [blogV4('1-1.3', 4, '00000002')]), false, 'rtl_sdr reads it as device 2');
  assert.equal(serialSelects('0x1f', [blogV4('1-1.3', 4, '0x1f')]), false, 'hex too');
  assert.equal(serialSelects('ALERT1', [blogV4('1-1.3', 4, 'ALERT1'), blogV4('1-1.4', 5)]), true);
  const ix = new RtlIndex();
  ix.update([blogV4('1-1.3', 4)]);
  assert.deepEqual(ix.choose(blogV4('1-1.3', 4)), { arg: '0', index: 0, how: 'only' });
  const sticks = rtlOrder([Object.assign(blogV4('1-1.3', 4), { devpath: '/u/1-1.3' }), Object.assign(blogV4('1-1.4', 5), { devpath: '/u/1-1.4' }), Object.assign(blogV4('1-1.2', 6, 'ALERT1'), { devpath: '/u/1-1.2' })]);
  ix.update(sticks);
  const at = (p) => sticks.find(s => s.busPath === p);
  assert.deepEqual(ix.choose(at('1-1.2')), { arg: 'ALERT1', index: null, how: 'serial' });
  assert.deepEqual(ix.choose(at('1-1.3')), { arg: '1', index: 1, how: 'guess' }, 'libusb\'s number');
  assert.equal(ix.choose(at('1-1.3'), new Set([1])).index, 0, 'not one just found busy');
  ix.learn(1, '1-1.4');                                  // device 1 turned out to be the other one
  assert.equal(ix.choose(at('1-1.4')).how, 'seen');
  assert.equal(ix.choose(at('1-1.3')).index, 0, 'not a number seen to open another stick');
  // rtl_sdr's own list says which numbers are this model: only those.
  const v3 = Object.assign(blogV4('1-1.5', 9), { manufacturer: 'Realtek', product: 'RTL2838UHIDIR', devpath: '/u/1-1.5', index: 0 });
  const mixed = [v3, Object.assign(blogV4('1-1.4', 5), { devpath: '/u/1-1.4', index: 1 })];
  ix.update(mixed);
  ix.listing([{ index: 0, text: 'RTLSDRBlog, Blog V4, SN: 00000001' }, { index: 1, text: 'Realtek, RTL2838UHIDIR, SN: 00000001' }]);
  assert.equal(ix.choose(v3).index, 1, 'the V3 is device 1, whatever the order said');
  ix.update([v3]);
  assert.equal(ix.listed, null, 'a change of sticks forgets what was learnt');
});

test('device numbers: the stick a process holds open, from /proc', { skip: process.platform !== 'linux' && 'needs /proc' }, () => {
  const dir = tmp('rpa-usb-');
  const node = path.join(dir, 'bus', 'usb', '001', '005');
  fs.mkdirSync(path.dirname(node), { recursive: true });
  const fd = fs.openSync(node, 'a+');
  try { assert.deepEqual(openedUsb(process.pid), { busnum: 1, devnum: 5 }); } finally { fs.closeSync(fd); }
  assert.equal(openedUsb(process.pid), null);
  assert.equal(openedUsb(999999999), null);
});

test('settings: each stick\'s own are checked one by one, and a bad one costs only that stick', () => {
  const c = new Config(path.join(tmp('rpa-cfg-'), 'config.json')).load();
  assert.ok(c.update({ receivers: { sdrDevices: [{ key: 'sdr-port:1-1.4', freqHz: 151525000, format: 'ENHANCED_IFLOWS', gainDb: null, name: 'Second', enabled: true }] } }).ok);
  const bad = c.update({ receivers: { sdrDevices: [{ key: 'a', freqHz: 5 }, { key: 'b', format: 'BOTH' }, { freqHz: 151.5e6 }, { key: 'c', gainDb: '20' }] } });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 4, bad.errors.join(' / '));
  assert.ok(bad.errors.some(e => /sdrDevices\[2\].*key/.test(e)), 'which stick');
  assert.equal(c.update({ receivers: { sdrDevices: [{ key: 'a' }, { key: 'a', ppm: 3 }] } }).ok, false, 'one entry per stick');
  assert.ok(c.update({ receivers: { sdrDevices: [{ serial: '00000001', freqHz: 151.5e6 }] } }).ok, '0.4\'s by-serial entries are still read');
  fs.writeFileSync(c.file, JSON.stringify({ receivers: { sdrDevices: [{ key: 'good', freqHz: 151525000 }, { key: 'bad', freqHz: 'loud' }] } }));
  const d = new Config(c.file).load();
  assert.deepEqual(d.get().receivers.sdrDevices, [{ key: 'good', freqHz: 151525000 }]);
  assert.ok(d.loadError);
});

test('a stick\'s settings: its own over the shared ones; only tuner changes restart rtl_sdr', () => {
  const dir = tmp('rpa-sess-');
  const config = new Config(path.join(dir, 'config.json')).load();
  const state = new State(dir).load();
  const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };
  const agent = { config, state, log, board: { cores: 4, memMb: 4000 }, devices: null, audio: null };
  const plugged = [blogV4('1-1.3', 4), blogV4('1-1.4', 5)];
  const keys = state.assignSdrs(plugged);
  const [a, b] = plugged.map(st => new SdrSession(agent, Object.assign(st, { key: keys.get(st) })));
  assert.deepEqual([a.name(), b.name()], ['RTL-SDR', 'RTL-SDR 2']);
  config.update({ receivers: { sdrDevices: [{ key: b.key, freqHz: 151600000, name: 'North', biasTee: true, enabled: false }] } });
  assert.deepEqual([a.cfg().freqHz, b.cfg().freqHz, b.cfg().format, b.name(), b.cfg().biasTee], [151500000, 151600000, 'BINARY', 'North', true]);
  assert.deepEqual([a.on(), b.on()], [true, false]);
  config.update({ receivers: { sdr: { enabled: false } } });
  assert.equal(a.on(), false, 'turning RTL-SDR sticks off turns every stick off');
  const tuned = a.tunerKey(a.cfg());
  config.update({ receivers: { sdr: { enabled: true, format: 'ENHANCED_IFLOWS', squelchDb: 12 } } });
  assert.equal(a.tunerKey(a.cfg()), tuned, 'format and squelch go to the decoder as they are');
  config.update({ receivers: { sdr: { gainDb: 20 } } });
  assert.notEqual(a.tunerKey(a.cfg()), tuned);
  // 0.4: by serial, for every stick with it — unless a stick has its own by key.
  config.update({ receivers: { sdrDevices: [{ serial: '00000001', freqHz: 151525000 }, { key: b.key, ppm: 4 }] } });
  assert.deepEqual([a.cfg().freqHz, b.cfg().freqHz, b.cfg().ppm], [151525000, 151500000, 4]);
  assert.deepEqual(b.status().own, ['ppm']);
});
