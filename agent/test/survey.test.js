'use strict';
// A site survey (lib/survey.js): what is tagged and sent, the tally kept on the
// Pi, and when it ends by itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Survey, quantile, metres, requestFromCard } = require('../lib/survey');
const { toPatch, parse } = require('../lib/bootconf');

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };

// Just enough of an agent: a clock, a location, the register, the devices, the uplink.
function fakeAgent(o) {
  o = o || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-survey-'));
  const clock = Object.assign(new EventEmitter(), { ok: o.trusted !== false, boot: o.boot || 'boot-a',
    trusted() { return this.ok; }, now: () => Date.now(), bootId() { return this.boot; }, wallOf: (m) => Date.now(),
    status() { return { trusted: this.ok, source: this.ok ? 'ntp' : 'none', rtc: null }; } });
  const a = Object.assign(new EventEmitter(), {
    dataDir: dir, log: quiet, clock, state: { data: { hostId: '6dfef7f4' } }, board: { memMb: 1024 },
    loc: o.loc || { source: 'manual', lat: -27.1, lon: 152.8 },
    location() { return this.loc; },
    stations: { lookup: (id) => (id === 6129 ? [{ id: 'loudoun_br_al', name: 'Loudoun Br AL', km: 12.3 }] : []) },
    devices: { status: () => ({ sdrs: [{ name: 'RTL-SDR 1', state: 'running', channels: [{}, {}] }], ports: [] }) },
    uplink: { status: () => ({ queueLimitMb: 1024, queueMb: 3, tokenSet: false, tokenRefused: false }) },
  });
  return a;
}

test('a running survey tags its receptions and keeps readings back', () => {
  const a = fakeAgent();
  const s = new Survey(a).load().start();
  assert.equal(s.tag(), null);
  assert.equal(s.sendReadings(), true);
  s.open({ name: '  Mt Mee repeater  ', hours: 48 }, 'now');
  assert.deepEqual(Object.keys(s.tag()), ['survey', 'survey_name']);
  assert.match(s.tag().survey, /^s-6dfef7f4-[0-9a-f]{6}$/);
  assert.equal(s.tag().survey_name, 'Mt Mee repeater');
  assert.equal(s.sendReadings(), false);
  s.end('test');
  assert.equal(s.tag(), null);
  assert.equal(s.sendReadings(), true);
  s.open({ name: 'B', readings: true }, 'now');
  assert.equal(s.sendReadings(), true, 'unless the survey says to send them');
  s.stop();
});

test('the tally: good and bad frames per address, signal and SNR medians, undecoded bursts', async () => {
  const a = fakeAgent();
  const s = new Survey(a).load().start();
  s.open({ name: 'Site' }, 'now');
  const lv = [-40, -38, -35, -30, -20];
  lv.forEach((l, i) => s.heard('rpi-6dfef7f4-sdr1', 151.5, { heard_at: Date.now(), alert_id: 6129, value_raw: i, ok: true, level_dbfs: l, detail: { snr_db: 20 + i } }));
  s.heard('rpi-6dfef7f4-sdr1', 151.5, { heard_at: Date.now(), alert_id: 6129, value_raw: 9, ok: false, fault: 'shadow', level_dbfs: -50, detail: {} });
  s.heard('rpi-6dfef7f4-qs1', null, { heard_at: null, alert_id: 4321, value_raw: 1, ok: true, rssi_dbm: -101, nf_dbm: -121, detail: {} });
  s.heard('rpi-6dfef7f4-sdr1', 151.5, { heard_at: Date.now(), alert_id: null, ok: false, fault: 'undecoded', detail: {} });
  const st = await s.status();
  assert.deepEqual(st.totals, { ok: 6, bad: 1, undecoded: 1, untimed: 1 });
  const r = st.stations.find(x => x.alert_id === 6129);
  assert.equal(r.ok, 5); assert.equal(r.bad, 1);
  assert.equal(r.level.p50, -35); assert.equal(r.level.p10, -40); assert.equal(r.level.p90, -20);
  assert.equal(r.unit, 'dBFS'); assert.equal(r.snr, 22);
  assert.equal(r.station.name, 'Loudoun Br AL');
  const q = st.stations.find(x => x.alert_id === 4321);
  assert.equal(q.unit, 'dBm'); assert.equal(q.snr, 20, 'a radio: RSSI over its noise floor');
  assert.equal(st.stations[0].alert_id, 6129, 'most heard first');
  assert.equal(st.points['rpi-6dfef7f4-sdr1'].undecoded, 1);
  s.stop();
});

test('it ends itself when its hours of listening are up, counting only time switched on', () => {
  const a = fakeAgent();
  const s = new Survey(a).load().start();
  s.open({ name: 'Site', hours: 1 }, 'now');
  s.s.elapsedMs = 3600e3 - 10;
  s.lastMono -= 1000;
  s.tick();
  assert.equal(s.s.state, 'ended');
  assert.match(s.s.endedWhy, /1 h of listening/);
  assert.equal(s.history.length, 1);
  s.stop();
});

test('it ends itself when a GPS fix puts it more than 500 m from where it began', () => {
  const a = fakeAgent({ loc: { source: 'gps', lat: -27.1, lon: 152.8, accuracy_m: 5 } });
  const s = new Survey(a).load().start();
  s.open({ name: 'Site' }, 'now');
  assert.deepEqual(s.s.anchor, { lat: -27.1, lon: 152.8 });
  a.emit('gps', { lat: -27.1001, lon: 152.8001, accuracy_m: 5 });
  a.emit('gps', { lat: -27.2, lon: 152.8, accuracy_m: 5 });          // one stray fix is not enough
  assert.equal(s.s.state, 'running');
  a.emit('gps', { lat: -27.1, lon: 152.8, accuracy_m: 5 });
  a.emit('gps', { lat: -27.2, lon: 152.8, accuracy_m: 5 });
  a.emit('gps', { lat: -27.2, lon: 152.8, accuracy_m: 5 });
  assert.equal(s.s.state, 'ended');
  assert.match(s.s.endedWhy, /moved more than 500 m/);
  s.stop();
});

test('armed in the office, it starts at the next power-up — not this one', () => {
  const a = fakeAgent();
  const s = new Survey(a).load().start();
  s.open({ name: 'Mt Mee', hours: 72 }, 'boot');
  assert.equal(s.s.state, 'armed');
  assert.equal(s.tag(), null);
  s.stop();
  // The agent restarts in the same power-up: still armed.
  const same = new Survey(a).load().start();
  assert.equal(same.s.state, 'armed');
  same.stop();
  // Switched on at the site.
  a.clock.boot = 'boot-b';
  const site = new Survey(a).load().start();
  assert.equal(site.s.state, 'running');
  assert.equal(site.s.name, 'Mt Mee');
  site.stop();
});

test('the time it started is filled in once the clock is known', () => {
  const a = fakeAgent({ trusted: false });
  const s = new Survey(a).load().start();
  s.open({ name: 'Site' }, 'now');
  assert.equal(s.s.startedAt, null);
  a.clock.ok = true; a.clock.emit('trusted');
  assert.ok(s.s.startedAt > Date.now() - 5000);
  s.stop();
});

test('survey = <name> on the SD card starts one at that power-up', () => {
  const { system } = toPatch(parse('survey = Mt Mee repeater\nsurvey_hours = 48\nsurvey_readings = yes\n'));
  assert.deepEqual(system.survey, { name: 'Mt Mee repeater', hours: 48, readings: true });
  const a = fakeAgent();
  requestFromCard(a.dataDir, system.survey);
  const s = new Survey(a).load().start();
  assert.equal(s.s.state, 'running');
  assert.equal(s.s.hours, 48);
  assert.equal(s.s.readings, true);
  assert.ok(!fs.existsSync(path.join(a.dataDir, 'survey-request.json')), 'taken up once');
  s.stop();
});

test('the readiness checks say what would go wrong on a hill with no network', async () => {
  const a = fakeAgent({ loc: { source: 'none' }, trusted: false });
  const s = new Survey(a).load().start();
  const r = await s.readiness();
  const by = Object.fromEntries(r.map(c => [c.key, c]));
  assert.equal(by.receivers.level, 'good');
  assert.match(by.receivers.label, /2 receiver channels/);
  assert.equal(by.location.level, 'bad');
  assert.equal(by.clock.level, 'bad');
  assert.equal(by.token.level, 'warn', 'no token is fine: it is kept');
  assert.equal(by.memory.level, 'good');
  s.stop();
});

test('a survey survives a restart, tally and all', () => {
  const a = fakeAgent();
  const s = new Survey(a).load().start();
  s.open({ name: 'Site' }, 'now');
  s.heard('p1', 151.5, { heard_at: 1, alert_id: 6129, value_raw: 1, ok: true, level_dbfs: -30, detail: {} });
  s.stop();
  const b = new Survey(a).load().start();
  assert.equal(b.s.state, 'running');
  assert.equal(b.s.ids[6129].ok, 1);
  b.stop();
});

test('quantile and distance helpers', () => {
  assert.equal(quantile({}, 0.5), null);
  assert.equal(quantile({ '-30': 1, '-20': 3 }, 0.5), -20);
  assert.ok(Math.abs(metres({ lat: -27, lon: 153 }, { lat: -27.0045, lon: 153 }) - 500) < 5);
});

test('through the agent: a survey\'s frames go as tagged receptions even with receptions off, and its readings stay', async () => {
  const stub = require('./helpers/meganet-stub');
  const { Agent } = require('../lib/agent');
  const { Config } = require('../lib/config');
  const m = await stub.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-survey-agent-'));
  const cfg = new Config(path.join(dir, 'config.json')).load();
  cfg.update({ meganet: { token: 'mgn_test_token', endpoints: [m.url + '/rest/v1'], receptions: false, stationsUrls: [m.url + '/stations.json'] },
    audio: { enabled: false }, location: { source: 'manual', lat: -27.1, lon: 152.8 } });
  const agent = new Agent({ dataDir: dir, config: cfg, assumeClock: true, rtcDir: path.join(dir, 'no-rtc') });
  agent.clock.start(); agent.uplink.start(); agent.survey.start();
  const session = { point: { pointId: 'rpi-6dfef7f4-sdr1' }, name: () => 'RTL-SDR 1', kind: 'sdr', key: 'sdr|1' };
  const hear = (id, v) => {
    agent.deviceReading(session, { alert_id: id, value_raw: v, protocol: 'alert', fmt: 'ABF', freq_mhz: 151.5, level_dbfs: -31, snr_db: 22 });
    agent.deviceReception(session, { protocol: 'alert', alert_id: id, value_raw: v, payload_hex: 'ABCD', ok: true, level_dbfs: -31, detail: { snr_db: 22, freq_mhz: 151.5 } });
  };
  // Not surveying, receptions off: a reading goes, the reception does not.
  hear(6129, 1);
  assert.equal(agent.uplink.status().queued, 1);
  assert.equal(agent.uplink.status().receptionsQueued, 0);
  agent.survey.open({ name: 'Mt Mee' }, 'now');
  hear(6129, 2); hear(6130, 3);
  assert.equal(agent.uplink.status().queued, 1, 'the survey\'s readings stay on the Pi');
  assert.equal(agent.uplink.status().receptionsQueued, 2);
  agent.uplink.sendNow();
  const ok = async () => { for (let i = 0; i < 100 && m.stored.receptions.length < 2; i++) await new Promise(r => setTimeout(r, 50)); };
  await ok();
  assert.equal(m.stored.receptions.length, 2);
  const rx = m.stored.receptions[0];
  assert.equal(rx.detail.survey, agent.survey.s.id);
  assert.equal(rx.detail.survey_name, 'Mt Mee');
  assert.equal(rx.location_source, 'manual');
  assert.equal(rx.lat, -27.1);
  assert.equal((await agent.status()).survey.addresses, 2);
  agent.survey.stop(); agent.uplink.stop(); agent.clock.stop(); agent.stations.stop();
  await m.close();
});
