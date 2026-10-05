'use strict';
// Several channels on one RTL-SDR stick: how they are written (web/channels.js),
// where the stick is tuned to hear them all (sdr-plan.js), what the settings
// take (config.js, bootconf.js), each channel a receiver of its own (sdr.js) —
// and end to end, one stick decoding four channels at once, two of them in the
// same instant, while channels come and go.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Channels = require('../web/channels');
const P = require('../lib/devices/sdr-plan');
const { AlertDsp } = require('../lib/meganet-codecs');
const { Config } = require('../lib/config');
const boot = require('../lib/bootconf');
const { State } = require('../lib/state');
const { SdrSession } = require('../lib/devices/sdr');
const stub = require('./helpers/meganet-stub');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const MHz = (...m) => m.map(f => ({ freqHz: Math.round(f * 1e6), format: 'BINARY' }));
const NETS = [151.5, 151.525, 151.95, 152.4];     // the channels MegaNet's stations use

// What a plan must keep, for the channels it says it hears.
function holds(p, what) {
  const heard = p.channels.filter(c => c.inBand);
  for (const c of heard) {
    assert.equal(c.offsetHz, c.freqHz - p.centerHz, what + ': offset');
    assert.ok(Math.abs(c.offsetHz) <= P.reach(p.sampleRate), what + ': ' + c.freqHz + ' inside the usable slice');
    assert.ok(Math.abs(c.offsetHz) >= P.DC_MIN, what + ': ' + c.freqHz + ' off the DC spike');
  }
  assert.ok(P.RATES.includes(p.sampleRate), what + ': a rate the decoder divides exactly');
}

test('channel lists: as people write them, and back', () => {
  assert.deepEqual(Channels.parse('151.525, 151.95, 152.4 EIF').channels,
    [{ freqHz: 151525000 }, { freqHz: 151950000 }, { freqHz: 152400000, format: 'ENHANCED_IFLOWS' }]);
  assert.deepEqual(Channels.parse('151.5MHz 152.4 MHz').channels.map(c => c.freqHz), [151500000, 152400000], 'units, spaces');
  assert.deepEqual(Channels.parse('152400000; 151525k').channels.map(c => c.freqHz), [152400000, 151525000], 'Hz and kHz');
  assert.deepEqual(Channels.parse('152.4/enhanced iflows, 151.5 alert ascii').channels.map(c => c.format), ['ENHANCED_IFLOWS', 'ASCII']);
  assert.deepEqual(Channels.parse('151,525').channels, [{ freqHz: 151525000 }], 'a decimal comma, as the boot file always took it');
  assert.deepEqual(Channels.parse('none'), { channels: [], blank: false, error: null });
  assert.equal(Channels.parse('  ').blank, true);
  for (const bad of ['EIF 152.4', '152.4 iflows', '5000', '10', 'loud']) assert.ok(Channels.parse(bad).error, bad + ' is refused');
  assert.match(Channels.parse('152.4 iflows').error, /not a frequency or a format/, 'never "iFLOWS" alone: NSW\'s network sends ALERT Binary');
  assert.equal(Channels.text([{ freqHz: 151525000 }, { freqHz: 152400000, format: 'ENHANCED_IFLOWS' }, { freqHz: 151600000, format: 'BINARY' }], 'BINARY'),
    '151.525, 152.400 EIF, 151.600');
  assert.deepEqual([Channels.mhz(151500000), Channels.mhz(151512500), Channels.mhz(1766000001)], ['151.500', '151.5125', '1766.000001']);
  const list = [{ freqHz: 151525000 }, { freqHz: 151950000, format: 'ASCII' }];
  assert.deepEqual(Channels.parse(Channels.text(list, 'BINARY')).channels, list, 'round trip');
});

test('tuning: one channel as it always was; several share one slice, off the DC spike and each other\'s mirror images', () => {
  assert.deepEqual(P.RATES, AlertDsp.DEVICE_RATES, 'the decoder\'s own rates');
  // One channel: a quarter of the rate below it, as rtl_sdr was always told.
  let p = P.plan(MHz(151.5), { baseRate: 960000 });
  assert.deepEqual([p.sampleRate, p.centerHz, p.channels[0].offsetHz, p.raised], [960000, 151260000, 240000, false]);
  p = P.plan(MHz(151.5), { sampleRate: 240000, baseRate: 960000, offsetHz: 50000 });
  assert.deepEqual([p.sampleRate, p.centerHz], [240000, 151450000]);
  // The four networks' channels: 1.92 Msps holds them, raised from the Pi's 960k.
  p = P.plan(MHz(...NETS), { baseRate: 960000 });
  holds(p, 'four networks');
  assert.equal(p.sampleRate, 1920000);
  assert.equal(p.raised, true);
  assert.ok(p.channels.every(c => c.inBand));
  assert.ok(p.dcHz >= P.DC_GOOD && p.mirrorHz >= P.MIRROR_GOOD, 'clear of the spike and of every mirror: ' + p.dcHz + ', ' + p.mirrorHz);
  const o = p.channels.map(c => c.offsetHz);
  for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++) assert.ok(Math.abs(o[i] + o[j]) >= P.MIRROR_GOOD, 'no channel on another\'s image');
  // Two channels 25 kHz apart fit a Zero 2 W's 240 ksps; a rate set higher is kept.
  p = P.plan(MHz(151.5, 151.525), { baseRate: 240000 });
  holds(p, 'two at 240k');
  assert.equal(p.sampleRate, 240000);
  assert.equal(P.plan(MHz(151.5, 151.525), { sampleRate: 2400000, baseRate: 240000 }).sampleRate, 2400000);
  // Channels written twice (two formats) are one frequency to the tuner.
  p = P.plan([{ freqHz: 151500000, format: 'BINARY' }, { freqHz: 151500000, format: 'ENHANCED_IFLOWS' }], { baseRate: 960000 });
  assert.deepEqual(p.channels.map(c => c.offsetHz), [240000, 240000]);
  // Any channels within 1.5 MHz of each other fit, whatever they are.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let n = 0; n < 150; n++) {
    const k = 2 + Math.floor(rnd() * 7);
    const set = Array.from({ length: k }, () => 150.5 + Math.round(rnd() * 120) * 0.0125);
    p = P.plan(MHz(...set), { baseRate: rnd() < 0.5 ? 240000 : 960000 });
    holds(p, set.join(', '));
    assert.ok(p.channels.every(c => c.inBand), set.join(', ') + ' all heard');
  }
  // Only a channel stuck on the DC spike in the middle of the widest span is
  // left out — never the stick's own.
  p = P.plan(MHz(151.5, 152.445, 153.39), { baseRate: 960000 });
  holds(p, 'widest span');
  assert.equal(p.channels[0].inBand, true);
  assert.deepEqual(p.channels.map(c => c.inBand), [true, true, false]);
});

test('settings: more channels are checked one by one, and together', () => {
  const c = new Config(path.join(tmp('rpa-ch-'), 'config.json')).load();
  const ok = c.update({ receivers: { sdr: { moreChannels: [{ freqHz: 151525000 }, { freqHz: 152400000, format: 'ENHANCED_IFLOWS' }] } } });
  assert.ok(ok.ok, ok.errors.join('; '));
  assert.deepEqual(ok.changed, ['receivers.sdr.moreChannels']);
  for (const bad of [[{ freqHz: 'x' }], [{ freqHz: 152400000, format: 'BOTH' }], [151525000], Array.from({ length: P.MAX_CHANNELS }, (_, i) => ({ freqHz: 151500000 + (i + 1) * 25000 }))]) {
    const r = c.update({ receivers: { sdr: { moreChannels: bad } } });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.errors.join(), /moreChannels/);
  }
  assert.match(c.update({ receivers: { sdr: { moreChannels: [{ freqHz: 151500000 }] } } }).errors.join(), /151\.500 MHz in ALERT Binary is listed twice/);
  assert.ok(c.update({ receivers: { sdr: { moreChannels: [{ freqHz: 151500000, format: 'ENHANCED_IFLOWS' }] } } }).ok, 'the same channel in another format');
  assert.match(c.update({ receivers: { sdr: { moreChannels: [{ freqHz: 154000000 }] } } }).errors.join(), /151\.500 and 154\.000 MHz are 2\.50 MHz apart/);
  // A stick's own: its own list replaces the shared one; [] is none.
  c.update({ receivers: { sdr: { moreChannels: [{ freqHz: 152400000 }] } } });
  const far = c.update({ receivers: { sdrDevices: [{ key: 'sdr-port:1-1.4', freqHz: 162000000 }] } });
  assert.match(far.errors.join(), /sdrDevices\[0\] \(sdr-port:1-1\.4\): 152\.400 and 162\.000 MHz/, 'a stick with a far channel of its own and the shared more channels');
  assert.ok(c.update({ receivers: { sdrDevices: [{ key: 'sdr-port:1-1.4', freqHz: 162000000, moreChannels: [] }] } }).ok);
  assert.ok(c.update({ receivers: { sdrDevices: [{ key: 'sdr-port:1-1.4', freqHz: 162000000, moreChannels: [{ freqHz: 162025000 }] }] } }).ok);
  // A settings file whose channels cannot all fit is loaded as it is, and says so.
  fs.writeFileSync(c.file, JSON.stringify({ name: 'Kept', receivers: { sdr: { moreChannels: [{ freqHz: 160000000 }] } } }));
  const d = new Config(c.file).load();
  assert.deepEqual(d.get().receivers.sdr.moreChannels, [{ freqHz: 160000000 }]);
  assert.equal(d.get().name, 'Kept');
  assert.match(d.loadError, /only those that fit are decoded/);
});

test('boot file: one frequency, or several for one stick to hear at once', () => {
  const sdr = (text) => boot.toPatch(boot.parse(text));
  let r = sdr('sdr_frequency_mhz = 151.5\n');
  assert.deepEqual(r.patch.receivers.sdr, { freqHz: 151500000 });
  r = sdr('sdr_frequency_mhz = 151.5, 151.525, 152.4 eif\n');
  assert.deepEqual(r.patch.receivers.sdr, { freqHz: 151500000, moreChannels: [{ freqHz: 151525000 }, { freqHz: 152400000, format: 'ENHANCED_IFLOWS' }] });
  assert.deepEqual(sdr('sdr_more_channels_mhz = none\n').patch.receivers.sdr, { moreChannels: [] });
  r = sdr('sdr_frequency_mhz = 151.5 iflows\n');
  assert.equal(r.patch.receivers, undefined);
  assert.ok(r.notes.some(n => /sdr_frequency_mhz/.test(n)), r.notes.join());
  // What the flasher page writes, applied as the agent would take it.
  const c = new Config(path.join(tmp('rpa-ch-'), 'config.json')).load();
  assert.ok(c.update(sdr('sdr_frequency_mhz = 151.5, 151.525, 151.95, 152.4\nsdr_format = binary\n').patch).ok);
  assert.equal(c.get().receivers.sdr.moreChannels.length, 3);
});

test('a stick\'s channels: each a receiver with its own name, receiver id and decoder', () => {
  const dir = tmp('rpa-chs-');
  const config = new Config(path.join(dir, 'config.json')).load();
  const state = new State(dir).load();
  const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };
  const attached = [], detached = [];
  const agent = { config, state, log, board: { cores: 4, memMb: 4000 }, devices: null, audio: null,
    deviceAttached: (s) => attached.push(s.point.pointId), deviceDetached: (s) => detached.push(s.point.pointId) };
  const st = { busPath: '1-1.3', vid: '0bda', pid: '2838', manufacturer: 'RTLSDRBlog', product: 'Blog V4', serial: '00000001', busnum: 1, devnum: 4 };
  st.key = state.assignSdrs([st]).get(st);
  const s = new SdrSession(agent, st);
  const id = s.point.pointId;
  // One channel: the stick as it always was.
  assert.deepEqual(s.channels.map(ch => [ch.name(), ch.key, ch.point.pointId]), [['RTL-SDR', st.key, id]]);
  assert.equal(s.tunerKey(s.cfg()), '-d  -f 151260000 -s 960000 -g 29.7 -b 65536 -', 'what rtl_sdr was always told');
  s.attach();
  assert.deepEqual(attached, [id]);
  // Four: one rtl_sdr around them all, a decoder each at its own offset.
  config.update({ receivers: { sdr: { moreChannels: [{ freqHz: 151525000 }, { freqHz: 151950000, format: 'ENHANCED_IFLOWS' }, { freqHz: 152400000 }] } } });
  s.syncChannels(s.cfg());
  const c = s.cfg();
  assert.equal(c.sampleRate, 1920000);
  assert.deepEqual(s.channels.map(ch => ch.name()), ['RTL-SDR · 151.500', 'RTL-SDR · 151.525', 'RTL-SDR · 151.950', 'RTL-SDR · 152.400']);
  assert.deepEqual(s.channels.map(ch => ch.point.pointId), [id, id + '-151.525', id + '-151.950', id + '-152.400']);
  assert.ok(s.channels.every(ch => /^[a-z0-9][a-z0-9._-]{2,63}$/.test(ch.point.pointId)), 'MegaNet\'s receiver id shape (0045)');
  assert.deepEqual(attached, [id, id + '-151.525', id + '-151.950', id + '-152.400'], 'each registered with MegaNet');
  assert.deepEqual(s.channels.map(ch => s.dspCfg(c, ch.spec)).map(d => [d.deviceRate, d.channelOffsetHz, d.format]),
    NETS.map((f, i) => [1920000, Math.round(f * 1e6) - c.centerHz, i === 2 ? 'ENHANCED_IFLOWS' : 'BINARY']));
  assert.match(s.tunerKey(c), new RegExp('-f ' + c.centerHz + ' -s 1920000 '));
  assert.equal(s.status().channels.length, 4);
  assert.deepEqual(s.channels[2].detail(), { via: 'USB', freq_mhz: 151.95, format: 'ENHANCED_IFLOWS', sample_rate: 1920000, channel: 3, channels: 4,
    center_mhz: +(c.centerHz / 1e6).toFixed(4), serial: '00000001', usb_port: '1-1.3' });
  // A format changed is the decoder's business, not the tuner's.
  const tuned = s.tunerKey(c), kept = s.channels.slice();
  config.update({ receivers: { sdr: { moreChannels: [{ freqHz: 151525000, format: 'ASCII' }, { freqHz: 151950000, format: 'ENHANCED_IFLOWS' }, { freqHz: 152400000 }] } } });
  assert.equal(s.tunerKey(s.cfg()), tuned);
  // A channel removed: the others keep their decoders and receiver ids; its receiver stands down.
  config.update({ receivers: { sdr: { moreChannels: [{ freqHz: 151950000, format: 'ENHANCED_IFLOWS' }, { freqHz: 152400000 }] } } });
  s.syncChannels(s.cfg());
  assert.deepEqual(s.channels.map(ch => kept.indexOf(ch)), [0, 2, 3]);
  assert.deepEqual(detached, [id + '-151.525']);
  assert.deepEqual(s.pointIds().sort(), [id, id + '-151.525', id + '-151.950', id + '-152.400'].sort(), 'all of them forgotten with the stick');
  // A stick of its own beside it: its own channels, not the shared ones.
  config.update({ receivers: { sdrDevices: [{ key: st.key, freqHz: 162000000, moreChannels: [{ freqHz: 162025000 }] }] } });
  s.syncChannels(s.cfg());
  assert.deepEqual(s.channels.map(ch => ch.spec.freqHz), [162000000, 162025000]);
  assert.deepEqual(s.status().own, ['freqHz', 'moreChannels']);
});

test('one stick, four channels at once: each decoded on its own channel and posted as its own receiver; channels come and go without disturbing the rest', { timeout: 180000 }, async (t) => {
  const m = await stub.start();
  const dir = tmp('rpa-chan-');
  for (const d of ['dev', 'data', 'etc', 'bin']) fs.mkdirSync(path.join(dir, d));
  const usb = path.join(dir, 'sys', 'bus', 'usb', 'devices', '1-1.3');
  fs.mkdirSync(usb, { recursive: true });
  for (const [k, v] of Object.entries({ idVendor: '0bda', idProduct: '2838', serial: '00000001', manufacturer: 'RTLSDRBlog', product: 'Blog V4', busnum: '1', devnum: '4' })) fs.writeFileSync(path.join(usb, k), v + '\n');
  fs.symlinkSync(path.join(__dirname, 'helpers', 'fake-rtl_sdr'), path.join(dir, 'bin', 'rtl_sdr'));
  fs.writeFileSync(path.join(dir, 'bin', 'aplay'), '#!/bin/sh\ncat > /dev/null\n', { mode: 0o755 });
  const port = 18000 + Math.floor(Math.random() * 2000);
  fs.writeFileSync(path.join(dir, 'etc', 'config.json'), JSON.stringify({
    name: 'Four channels', web: { port },
    meganet: { token: 'mgn_test_token', endpoints: [m.url + '/rest/v1'], stationsUrls: [m.url + '/stations.json'] },
    location: { source: 'manual', lat: -27.47, lon: 153.02 },
    receivers: { sdr: { moreChannels: [{ freqHz: 151525000 }, { freqHz: 151950000, format: 'ENHANCED_IFLOWS' }, { freqHz: 152400000 }] } },
  }));
  const env = Object.assign({}, process.env, {
    PATH: path.join(dir, 'bin') + ':' + process.env.PATH, RPI_ALERT_CONFIG: path.join(dir, 'etc', 'config.json'), RPI_ALERT_DATA: path.join(dir, 'data'),
    RPI_ALERT_DEV: path.join(dir, 'dev'), RPI_ALERT_SYSFS: path.join(dir, 'sys'), RPI_ALERT_ASSUME_CLOCK: '1', RPI_ALERT_PRIV: '/nonexistent',
    // A station on each channel; the first two in the same instant, 25 kHz apart.
    RPI_ALERT_FAKE_BURSTS: JSON.stringify([
      { channelHz: 151500000, frames: '2088:143', startSec: 2.0 },
      { channelHz: 151525000, frames: '2443:142', startSec: 2.1 },
      { channelHz: 151950000, frames: '4079:420', format: 'ENHANCED_IFLOWS', startSec: 5.0 },
      { channelHz: 152400000, frames: '6129:77', startSec: 7.0 },
    ]),
  });
  const agent = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'rpi-alert'), 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  agent.stderr.on('data', (d) => { log += d; });
  t.after(async () => { agent.kill('SIGTERM'); await m.close(); });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(200); } return false; };
  const get = async (p) => { try { return await (await fetch('http://127.0.0.1:' + port + p)).json(); } catch (_) { return null; } };
  const put = async (body) => { const r = await fetch('http://127.0.0.1:' + port + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: body }) }); return { status: r.status, body: await r.json() }; };
  const heard = async (after) => { const r = await get('/api/readings?limit=500'); return r ? r.readings.filter(x => x.t > (after || 0)).map(x => x.alert_id + '@' + x.receiver) : []; };
  const stick = async () => { const s = await get('/api/status'); return s && s.devices.sdrs[0]; };
  const posted = (after) => m.calls.filter(c => c.fn === 'ingest_http' && c.body && c.at > (after || 0))
    .flatMap(c => c.body.payload.readings.map(r => r.alert_id + '@' + c.body.payload.path.replace(/^serial-monitor\/rpi-[0-9a-f]+-/, '')));

  const want = ['2088@RTL-SDR · 151.500', '2443@RTL-SDR · 151.525', '4079@RTL-SDR · 151.950', '6129@RTL-SDR · 152.400'];
  assert.ok(await until(async () => { const h = await heard(); return want.every(w => h.includes(w)); }, 60000), 'all four, each on its own channel:\n' + (await heard()).join(' ') + '\n' + log.slice(-3000));
  for (const h of await heard()) assert.ok(want.includes(h), 'each heard on its own channel only, and nothing else: ' + h);
  let d = await stick();
  assert.deepEqual([d.state, d.sampleRate, d.channels.length, d.channels.every(c => c.state === 'running')], ['running', 1920000, 4, true]);
  assert.match(log, /4 channels: 151\.500 ABF, 151\.525 ABF, 151\.950 EIF, 152\.400 ABF MHz; 1920 ksps to hold them all/);
  assert.ok(await until(() => ['2088@sdr1', '2443@sdr1-151.525', '4079@sdr1-151.950', '6129@sdr1-152.400'].every(x => posted().includes(x)), 20000), 'MegaNet has each by its receiver: ' + posted().join(' '));
  const reports = m.calls.filter(c => c.fn === 'report_ingest_point' && c.body).map(c => c.body.payload);
  for (const f of ['151.525', '151.950', '152.400']) {
    const r = reports.find(x => x.point_id.endsWith('-sdr1-' + f));
    assert.ok(r, 'the ' + f + ' receiver describes itself');
    assert.equal(r.name, 'Four channels — RTL-SDR · ' + f);
    assert.deepEqual([r.receiver, r.detail.freq_mhz, r.detail.channels], ['rtl-sdr', Number(f), 4]);
  }

  // 151.525 MHz dropped: the stick stays where it is tuned, so nothing else restarts.
  const before = d;
  const t1 = Date.now();
  let r = await put({ receivers: { sdr: { moreChannels: [{ freqHz: 151950000, format: 'ENHANCED_IFLOWS' }, { freqHz: 152400000 }] } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(await until(async () => (await stick()).channels.length === 3, 10000));
  assert.ok(await until(async () => { const h = await heard(t1); return h.includes('4079@RTL-SDR · 151.950') && h.includes('6129@RTL-SDR · 152.400') && h.includes('2088@RTL-SDR · 151.500'); }, 40000),
    'the rest still heard:\n' + (await heard(t1)).join(' ') + '\n' + log.slice(-2000));
  d = await stick();
  assert.deepEqual([d.startedAt, d.counts.restarts, d.centerHz], [before.startedAt, 0, before.centerHz], 'rtl_sdr was not restarted');
  assert.deepEqual(d.channels.map(c => c.pointId), [before.channels[0].pointId, before.channels[2].pointId, before.channels[3].pointId], 'each keeps its receiver id');
  assert.ok(!(await heard(t1)).some(h => h.startsWith('2443@')), 'nobody listens on 151.525 MHz now');
  assert.ok(!posted(t1 + 6000).some(p => p.endsWith('-151.525')), 'its receiver posts no more');

  // Down to two: a slice of 1.2 Msps holds them, and rtl_sdr retunes.
  r = await put({ receivers: { sdr: { moreChannels: [{ freqHz: 152400000 }] } } });
  assert.equal(r.status, 200);
  assert.ok(await until(async () => { const s = await stick(); return s.sampleRate === 1200000 && s.state === 'running' && s.startedAt !== before.startedAt; }, 20000), 'retuned:\n' + log.slice(-2000));
  const t2 = Date.now();
  assert.ok(await until(async () => { const h = await heard(t2); return h.includes('6129@RTL-SDR · 152.400') && h.includes('2088@RTL-SDR · 151.500'); }, 40000), 'both heard after retuning:\n' + log.slice(-2000));

  // A channel no stick could hear beside the others is refused, saying why.
  r = await put({ receivers: { sdr: { moreChannels: [{ freqHz: 154000000 }] } } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /2\.50 MHz apart/);
});
