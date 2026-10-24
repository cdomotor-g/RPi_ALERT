'use strict';
// Remote management (lib/remote.js, MegaNet 0049) against the stand-in: the
// base station checks in — a heartbeat every time, the whole status when it
// changed — and does what an administrator asked, once, from a fixed list;
// never the token, the endpoints, the web password or its own reach. Report
// mode refuses, off says so once and is silent, an older MegaNet is asked
// again in an hour, and a restart waits for its answer to go.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
process.env.RPI_ALERT_PRIV = '/nonexistent/rpi-alert-priv';
const stub = require('./helpers/meganet-stub');
const system = require('../lib/system');
const { Config, merge } = require('../lib/config');
const { Uplink } = require('../lib/uplink');
const { Remote, checkPatch, droppedPpm } = require('../lib/remote');

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 5000)) { if (fn()) return true; await wait(20); } return false; }
// A stand-in that is closed, and remotes that are stopped, when the test ends
// however it ends — a failed assertion must not leave a server holding the run.
async function stand(t, opts) {
  const m = await stub.start(opts);
  t.after(() => m.close());
  return m;
}
function started(t, r) { r.remote.start(); t.after(() => r.remote.stop()); return r; }

// The agent, as much of it as remote.js reads: real settings and uplink, a
// pretend RTL-SDR stick and Quansheng radio.
function rig(m, over) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-remote-'));
  const cfg = new Config(path.join(dir, 'config.json')).load();
  cfg.update(merge({ name: 'Bench Pi', meganet: { token: 'mgn_test_token', endpoints: [m.url + '/rest/v1'] }, web: { passwordHash: 'scrypt$00$11' } }, over || {}));
  const clock = Object.assign(new EventEmitter(), { trusted: () => true, now: () => Date.now(), mono: () => Number(process.hrtime.bigint() / 1000000n), bootId: () => 'b',
    wallOf(x) { return x; }, status: () => ({ trusted: true, source: 'ntp', timezone: 'UTC' }) });
  const uplink = new Uplink({ config: cfg, clock, log: quiet, dataDir: dir });
  const done = { restarted: [], scanned: 0, sent: 0 };
  let held = { key: 'sdr-port:1-1.3', center_hz: 151850000, rate: 960000, span_s: 60, floor_db: -45.5, bins: Buffer.from([0, 10, 60]).toString('base64') };
  const sdr = { key: 'sdr-port:1-1.3', kind: 'sdr', state: 'running', name: () => 'RTL-SDR', restart: async () => { done.restarted.push('sdr-port:1-1.3'); },
    takeSpectrum: () => { const r = held; held = null; return r; },
    status: () => ({ key: 'sdr-port:1-1.3', kind: 'sdr', name: 'RTL-SDR', state: 'running', protocol: 'alert', pointId: 'rpi-abc-sdr1', enabled: true,
      freqHz: cfg.get().receivers.sdr.freqHz, format: 'BINARY', gainDb: 29.7, ppm: 0, squelchDb: 8, biasTee: false, sampleRate: 960000, model: 'RTL-SDR Blog V4',
      device: { serial: '00000001', port: '1-1.3' }, own: [], counts: { bursts: 5, decodes: 4, dropped: 12345678 }, rateKsps: 960, lastSeen: null, spectrum: { db: new Array(512).fill(-90) },
      channels: [{ freqHz: 151500000, format: 'BINARY', inBand: true, pointId: 'rpi-abc-sdr1', counts: { decodes: 4, undecoded: 1, dropped: 0 } },
        { freqHz: 151537500, format: 'BINARY', inBand: true, pointId: 'rpi-abc-sdr1-151.5375', counts: { decodes: 7, undecoded: 0, alert2: 3, alert2Bad: 1, dropped: 12345678 } }] }) };
  const radio = { key: 'usb-Quansheng', kind: 'quansheng', state: 'unplugged', name: () => 'Quansheng radio', restart: async () => {},
    status: () => ({ key: 'usb-Quansheng', kind: 'quansheng', name: 'Quansheng radio', state: 'unplugged', protocol: 'alert', pointId: 'rpi-abc-qs1',
      port: { dev: '/dev/ttyACM0', byId: '/dev/serial/by-id/usb-Quansheng', baud: null }, how: 'USB id', lastRxAgoMs: 4000, detail: { firmware: '3.1', battery: { pct: 80 }, counts: { dec: 9 } } }) };
  const agent = {
    config: cfg, uplink, log: quiet, counts: { readings: 9 }, startedAt: Date.now() - 60000, kiosk: { running: false, display: false }, board: { model: 'Test Pi' },
    baseName: () => cfg.get().name, location: () => ({ source: 'manual', lat: -27.469812, lon: 153.025123, accuracy_m: null, station: null }), clock,
    devices: { all: () => [sdr, radio], scan: () => { done.scanned++; }, forget: (k) => (k === radio.key ? { ok: true, name: 'Quansheng radio' } : { ok: false, status: 409, error: 'plugged in' }) },
    stations: { refresh() {} },
  };
  uplink.sendNow = () => { done.sent++; };
  const remote = new Remote(agent, { idleMs: 150, firstMs: 10 });
  return { dir, cfg, agent, remote, done };
}

test('remote: a heartbeat every check-in, the whole status when it changed — and never the token or the password', async (t) => {
  const m = await stand(t);
  const { remote, cfg } = started(t, rig(m));
  assert.ok(await until(() => m.station.checkins >= 5), 'it checks in by itself, again and again');
  const first = m.station.payloads[0];
  assert.equal(first.v, 1);
  assert.equal(first.mode, 'manage', 'manage unless its owner says otherwise');
  assert.deepEqual(first.agent, { app: 'RPi ALERT', version: require('../package.json').version });
  assert.ok(first.status, 'the first check-in carries the whole status');
  // The second may carry it again — the route that worked is part of it, and
  // the first check-in is what finds it — but with nothing changing after that,
  // only the heartbeat.
  const later = m.station.payloads.slice(2, 5);
  assert.ok(later.every(p => !p.status), 'with nothing changed, only the heartbeat');
  // Each stick's spectrum since the last check-in, once: a row of MegaNet's waterfall.
  assert.deepEqual(first.spectra, [{ key: 'sdr-port:1-1.3', center_hz: 151850000, rate: 960000, span_s: 60, floor_db: -45.5, bins: 'AAo8' }]);
  assert.ok(m.station.payloads.slice(1).every(p => !p.spectra), 'and not again until there is another');
  assert.ok(later.every(p => p.beat && typeof p.beat.up === 'number' && Array.isArray(p.beat.rx)));
  const st = first.status;
  assert.equal(st.name, 'Bench Pi');
  assert.deepEqual(st.receivers.map(r => [r.key, r.state]), [['sdr-port:1-1.3', 'running'], ['usb-Quansheng', 'unplugged']]);
  assert.equal(st.receivers[0].freq_hz, 151500000);
  assert.ok(!('spectrum' in st.receivers[0]), 'what changes every second stays out of it');
  assert.deepEqual([st.receivers[0].rate_ksps, st.receivers[0].dropped_mb], [960, 12.3], 'whether the Pi keeps up');
  assert.deepEqual(st.receivers[0].channels[1], { freq_hz: 151537500, format: 'BINARY', in_band: true, decoded: 7, undecoded: 0, alert2: 3, alert2_bad: 1,
    dropped_mb: 12.3, point: 'rpi-abc-sdr1-151.5375' });
  assert.equal(st.location.lat, -27.46981);
  assert.equal(st.config.receivers.sdr.freqHz, 151500000, 'the settings, for editing them there');
  const call = m.calls.find(c => c.fn === 'base_station_checkin');
  assert.equal(call.headers['x-ingest-token'], 'mgn_test_token', 'the token is the header, as for readings');
  const all = JSON.stringify(m.station.payloads);
  assert.ok(!all.includes('mgn_test_token'), 'the token is never in what is sent');
  assert.ok(!all.includes('scrypt$'), 'nor the web password\'s hash');
  assert.ok(JSON.stringify(st).length < 16384, 'the status fits what MegaNet takes');

  // A change here is told at the next check-in.
  const n = m.station.payloads.length;
  cfg.update({ name: 'Bench Pi 2' });
  assert.ok(await until(() => m.station.payloads.slice(n).some(p => p.status && p.status.name === 'Bench Pi 2')));
});

test('remote: what an administrator asks is done once and answered; what it may not ask is refused, saying why', async (t) => {
  const m = await stand(t);
  const { remote, cfg, done } = started(t, rig(m));
  assert.ok(await until(() => m.station.checkins >= 1));
  const freq = m.ask('config.set', { patch: { receivers: { sdr: { freqHz: 151525000 } } } });
  const token = m.ask('config.set', { patch: { meganet: { token: 'mgn_stolen' } } });
  const ends = m.ask('config.set', { patch: { meganet: { endpoints: ['https://evil.invalid/rest/v1'] } } });
  const pw = m.ask('config.set', { patch: { web: { passwordHash: '' } } });
  const reach = m.ask('config.set', { patch: { remote: { mode: 'manage', idleS: 30 } } });
  const bad = m.ask('config.set', { patch: { receivers: { sdr: { format: 'BOTH' } } } });
  const shell = m.ask('shell', { cmd: 'id' });
  const log = m.ask('log', { lines: 5 });
  const restart = m.ask('device.restart', { key: 'sdr-port:1-1.3' });
  const forget = m.ask('device.forget', { key: 'usb-Quansheng' });
  const rescan = m.ask('device.rescan');
  const send = m.ask('send-now');
  assert.ok(await until(() => m.asked.every(c => c.status === 'done' || c.status === 'failed'), 8000), 'every request answered');
  assert.equal(freq.status, 'done');
  assert.deepEqual(freq.result.changed, ['receivers.sdr.freqHz', 'receivers.sdr.moreChannels'], 'MegaNet\'s other channels kept around it');
  assert.equal(cfg.get().receivers.sdr.freqHz, 151525000, 'the setting changed, through the same checks as the web page');
  for (const c of [token, ends]) { assert.equal(c.status, 'failed'); assert.match(c.error, /set on the base station itself/); }
  assert.equal(cfg.get().meganet.token, 'mgn_test_token');
  assert.equal(cfg.get().meganet.endpoints[0], m.url + '/rest/v1');
  assert.match(pw.error, /web is set on the base station itself/);
  assert.match(reach.error, /remote is set on the base station itself/, 'MegaNet cannot widen its own reach');
  assert.equal(cfg.get().remote.idleS, 60);
  assert.match(bad.error, /not saved: .*format/);
  assert.match(shell.error, /cannot "shell"/);
  assert.equal(log.status, 'done');
  assert.ok(Array.isArray(log.result.lines) && log.result.lines.length <= 5);
  assert.deepEqual(done.restarted, ['sdr-port:1-1.3']);
  assert.equal(forget.status, 'done');
  assert.equal(rescan.status, 'done'); assert.equal(done.scanned, 1);
  assert.equal(send.status, 'done'); assert.equal(done.sent, 1);
  assert.equal(restart.status, 'done');
  assert.ok(remote.history.some(h => h.id === freq.id && h.ok && /receivers\.sdr\.freqHz/.test(h.detail)), 'what was asked is kept, with what it changed');
  const page = remote.statusForPage();
  assert.equal(page.history.length, 10, 'the web page shows the last ten');
  assert.equal(page.history[0].id, send.id, 'newest first');
  // At most once: a request handed over again (it should not be) is not done twice.
  const before = done.restarted.length;
  await remote.execute({ id: restart.id, verb: 'device.restart', args: { key: 'sdr-port:1-1.3' } });
  assert.equal(done.restarted.length, before);
});

test('remote: a settings patch is checked before it is tried', () => {
  assert.equal(checkPatch({ audio: { volume: 50 } }), null);
  assert.equal(checkPatch({ meganet: { enabled: false, receptions: true } }), null, 'whether to send: yes');
  assert.match(checkPatch({ meganet: { autoRequest: true } }), /set on the base station itself/);
  assert.match(checkPatch({ nonsense: 1 }), /no setting/);
  assert.match(checkPatch([]), /object/);
  assert.match(checkPatch({}), /object/);
  assert.match(checkPatch(JSON.parse('{"__proto__": {"x": 1}}')), /object|no setting/);
});

test('remote: a patch never changes a stick\'s frequency correction without saying what it becomes', () => {
  // Sticks plugged in, and settings that include one that is not (sdr-port:1-1.2) and a 0.4 entry by serial.
  const sticks = [{ key: 'sdr-serial:7777', serial: '7777', name: 'Roof' }, { key: 'sdr-port:1-1.3', serial: '00000001' }, { key: 'sdr-port:1-1.4', serial: '0001' }];
  const cur = { receivers: { sdr: { ppm: 0 }, sdrDevices: [
    { key: 'sdr-serial:7777', ppm: -14, gainDb: 49.6 }, { key: 'sdr-port:1-1.3', ppm: -19 }, { key: 'sdr-port:1-1.2', ppm: 5 }, { serial: '0001', ppm: 3 }] } };
  const keep = [{ key: 'sdr-serial:7777', ppm: -14 }, { key: 'sdr-port:1-1.3', ppm: -19 }, { key: 'sdr-port:1-1.2', ppm: 5 }, { serial: '0001', ppm: 3 }];
  const dp = (patch, c) => droppedPpm(c || cur, patch, sticks);
  assert.deepEqual(dp({ audio: { volume: 50 } }), [], 'a patch that leaves the sticks alone');
  assert.deepEqual(dp({ receivers: { sdr: { gainDb: 30 } } }), [], 'or changes only the shared settings');
  assert.deepEqual(dp({ receivers: { sdrDevices: keep } }), [], 'every correction sent again: kept');
  assert.deepEqual(dp({ receivers: { sdrDevices: [{ key: 'sdr-serial:7777', ppm: -13 }, { key: 'sdr-port:1-1.3', ppm: 0 }, { key: 'sdr-port:1-1.2', ppm: 5 }, { serial: '0001', ppm: 3 }] } }), [],
    'a new value, 0 included, is a change asked for');
  assert.deepEqual(dp({ receivers: { sdrDevices: keep.map(e => (e.key === 'sdr-port:1-1.3' ? { key: e.key, gainDb: 40 } : e)) } }),
    ['sdr-port:1-1.3 (−19 ppm)'], 'an entry sent without its ppm');
  assert.deepEqual(dp({ receivers: { sdrDevices: [{ key: 'sdr-port:1-1.3', ppm: -19 }] } }),
    ['Roof, sdr-serial:7777 (−14 ppm)', 'sdr-port:1-1.4 (+3 ppm)', 'sdr-port:1-1.2 (+5 ppm)'],
    'a list that leaves sticks out — one held by a 0.4 entry by its serial, one not plugged in');
  // The 0.4 entry by serial: its stick's own entry beside it hides it.
  assert.deepEqual(dp({ receivers: { sdrDevices: keep.concat([{ key: 'sdr-port:1-1.4', name: 'West' }]) } }), ['sdr-port:1-1.4 (+3 ppm)'],
    'a stick\'s own entry added without the ppm its serial entry gave it');
  assert.deepEqual(dp({ receivers: { sdrDevices: keep.filter(e => e.serial !== '0001').concat([{ key: 'sdr-port:1-1.4', ppm: 3, name: 'West' }]) } }), [],
    'the serial entry carried into the stick\'s own, ppm and all: nothing changes');
  // What a stick follows when it has no correction of its own.
  assert.deepEqual(dp({ receivers: { sdr: { ppm: -19 }, sdrDevices: keep.filter(e => e.key !== 'sdr-port:1-1.3') } }), [],
    'its own −19 gone, the shared −19 in the same patch: the stick runs as it did');
  assert.deepEqual(dp({ receivers: { sdr: { ppm: -18 }, sdrDevices: keep.filter(e => e.key !== 'sdr-port:1-1.3') } }), ['sdr-port:1-1.3 (−19 ppm)'],
    '…but a different shared one does not stand in for it');
  const plain = { receivers: { sdr: { ppm: 0 }, sdrDevices: [{ key: 'sdr-port:1-1.3', gainDb: 40 }] } };
  assert.deepEqual(dp({ receivers: { sdr: { ppm: 4 }, sdrDevices: [{ key: 'sdr-port:1-1.3' }] } }, plain), [],
    'a stick that followed the shared correction follows the new one: that is the change asked for');
  assert.deepEqual(dp({ receivers: { sdrDevices: 'all' } }), [], 'not a list: config.js refuses it, with its own reason');
});

test('remote: from MegaNet, a list of sticks that would drop a correction is refused and nothing changes', async (t) => {
  const m = await stand(t);
  const { cfg } = started(t, rig(m, { receivers: { sdrDevices: [{ key: 'sdr-port:1-1.3', ppm: -19 }, { key: 'sdr-port:1-1.4', ppm: -14, gainDb: 49.6 }] } }));
  assert.ok(await until(() => m.station.checkins >= 1));
  const before = JSON.stringify(cfg.get().receivers.sdrDevices);
  const left = m.ask('config.set', { patch: { receivers: { sdrDevices: [{ key: 'sdr-port:1-1.3', ppm: -19, freqHz: 151575000 }, { key: 'sdr-port:1-1.4', gainDb: 49.6 }] } } });
  const out = m.ask('config.set', { patch: { receivers: { sdrDevices: [{ key: 'sdr-port:1-1.4', ppm: -14, gainDb: 49.6 }] } } });
  assert.ok(await until(() => [left, out].every(c => c.status === 'done' || c.status === 'failed'), 8000));
  assert.equal(left.status, 'failed');
  assert.match(left.error, /take away the frequency correction of sdr-port:1-1\.4 \(−14 ppm\)\. The settings may have changed.*gives ppm in that stick/);
  assert.equal(out.status, 'failed');
  assert.match(out.error, /RTL-SDR, sdr-port:1-1\.3 \(−19 ppm\)/, 'a stick plugged in, by its name and key');
  assert.equal(JSON.stringify(cfg.get().receivers.sdrDevices), before, 'refused whole: not the other changes in it either');
  const ok = m.ask('config.set', { patch: { receivers: { sdrDevices: [{ key: 'sdr-port:1-1.3', ppm: -19, freqHz: 151575000 }, { key: 'sdr-port:1-1.4', ppm: -14, gainDb: 49.6 }] } } });
  assert.ok(await until(() => ok.status === 'done' || ok.status === 'failed', 8000));
  assert.equal(ok.status, 'done', ok.error);
  assert.deepEqual(cfg.get().receivers.sdrDevices.map(e => [e.key, e.ppm]), [['sdr-port:1-1.3', -19], ['sdr-port:1-1.4', -14]]);
  // On the Pi itself, its owner may still send a stick back to the shared correction.
  assert.ok(cfg.update({ receivers: { sdrDevices: [{ key: 'sdr-port:1-1.4', ppm: -14 }] } }).ok);
});

test('remote: report mode refuses on the Pi as well as in MegaNet; off is one last word, then silence', async (t) => {
  const m = await stand(t, { deliverAlways: true });
  const { remote, cfg } = started(t, rig(m, { remote: { mode: 'report' } }));
  const c = m.ask('device.rescan');
  assert.ok(await until(() => c.status === 'failed'));
  assert.match(c.error, /only reports/);
  assert.equal(m.station.mode, 'report');
  cfg.update({ remote: { mode: 'off' } });
  assert.ok(await until(() => m.station.mode === 'off'), 'MegaNet is told it was turned off');
  assert.ok(m.station.payloads[m.station.payloads.length - 1].beat === undefined, 'with nothing else');
  const n = m.station.checkins;
  await wait(500);
  assert.equal(m.station.checkins, n, 'then nothing at all');
  assert.equal(remote.statusForPage().state, 'off');
  cfg.update({ remote: { mode: 'manage' } });
  assert.ok(await until(() => m.station.checkins > n && m.station.mode === 'manage'), 'and back on, at once');
  remote.stop();

  // Off from the start: not a word.
  const m2 = await stand(t);
  started(t, rig(m2, { remote: { mode: 'off' } }));
  await wait(400);
  assert.equal(m2.station.checkins, 0);
});

test('remote: a restart waits for its answer to reach MegaNet', async (t) => {
  const m = await stand(t);
  const privCalls = [];
  const realPriv = system.priv;
  system.priv = async (verb) => { privCalls.push({ verb, answered: m.asked[0] && m.asked[0].status }); return { code: 0, stdout: '', stderr: '' }; };
  t.after(() => { system.priv = realPriv; });
  started(t, rig(m));
  m.ask('agent.restart');
  assert.ok(await until(() => privCalls.some(c => c.verb === 'restart-agent'), 8000));
  assert.equal(privCalls.find(c => c.verb === 'restart-agent').answered, 'done', 'the answer was in MegaNet before the agent went down');
});

test('remote: watched it checks in every few seconds; an older MegaNet is asked again in an hour; a refused token waits', async (t) => {
  const m = await stand(t);
  m.watch(true);
  const { remote } = started(t, rig(m));
  // The first check-in or two carry the whole status, and the next one
  // follows straight after; then the pace is MegaNet's five seconds.
  assert.ok(await until(() => m.station.checkins >= 1 && !remote.wantFull && remote.st.nextAt - Date.now() > 3000, 8000));
  const left = remote.st.nextAt - Date.now();
  assert.ok(left > 3000 && left <= 5000, 'MegaNet asked for 5 s while watched (' + left + ' ms)');
  assert.equal(remote.statusForPage().watch, true);

  const old = await stand(t, { noBaseStations: true });
  const r2 = started(t, rig(old));
  assert.ok(await until(() => r2.remote.st.state === 'unsupported'));
  assert.ok(r2.remote.st.nextAt - Date.now() > 50 * 60 * 1000, 'not again for an hour');

  const m3 = await stand(t);
  const r3 = started(t, rig(m3, { meganet: { token: 'mgn_revoked' } }));
  assert.ok(await until(() => r3.remote.st.state === 'refused'));
  assert.ok(r3.remote.st.nextAt - Date.now() > 10 * 60 * 1000);
});

test('remote: new team SSH keys in MegaNet: root is asked to fetch them — only on a Pi that takes them', async (t) => {
  const m = await stand(t);
  const privCalls = [];
  const real = { priv: system.priv, accessStatus: system.accessStatus };
  t.after(() => Object.assign(system, real));
  let takes = true;
  system.accessStatus = async () => ({ available: true, policy: { meganetKeys: takes }, sources: { meganet: { hash: 'k0' } }, keys: [], account: { name: 'alert' } });
  system.priv = async (verb) => { privCalls.push(verb); return { code: 0, stdout: '', stderr: '' }; };
  const { remote } = started(t, rig(m));
  assert.ok(await until(() => m.station.checkins >= 2));
  assert.equal(m.station.keysHash, 'k0', 'it says which list it holds');
  assert.ok(!privCalls.includes('access-sync'), 'the same list: nothing to fetch');
  m.teamKeys.hash = 'k1';
  assert.ok(await until(() => privCalls.includes('access-sync')), 'a new list: fetched');
  remote.stop();
  privCalls.length = 0; takes = false;
  const n = m.station.checkins;
  started(t, rig(m));
  await until(() => m.station.checkins >= n + 4);
  assert.ok(!privCalls.includes('access-sync'), 'a Pi that does not take MegaNet\'s keys never fetches them');
});
