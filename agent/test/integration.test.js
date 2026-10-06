'use strict';
// The whole agent, end to end, with stand-ins for the hardware: socat pseudo-
// terminals for a Quansheng radio, an ERT-A2 and a GPS; the fake rtl_sdr and a
// fake sysfs entry for an RTL-SDR Blog V4; and the MegaNet stand-in. Then the
// things a base station in a hut has to survive: a device unplugged and
// plugged back in. Needs socat (skipped without it).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const stub = require('./helpers/meganet-stub');

let hasSocat = true;
try { execFileSync('socat', ['-V'], { stdio: 'ignore' }); } catch (_) { hasSocat = false; }
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await wait(100); } return false; }
function nmea(body) { let c = 0; for (const ch of body) c ^= ch.charCodeAt(0); return '$' + body + '*' + c.toString(16).toUpperCase().padStart(2, '0') + '\r\n'; }

function pty(dir, n) {
  const dev = path.join(dir, 'dev', 'ttyUSB' + n), peer = path.join(dir, 'peer' + n);
  const p = spawn('socat', ['pty,raw,echo=0,link=' + dev, 'pty,raw,echo=0,link=' + peer], { stdio: 'ignore' });
  return { p, dev, peer, write: (s) => fs.writeFileSync(peer, s) };
}

test('serial port: reads, writes, notices a hang-up', { skip: !hasSocat && 'socat not installed' }, async () => {
  const { SerialPort } = require('../lib/serial/port');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-port-'));
  fs.mkdirSync(path.join(dir, 'dev'));
  const t = pty(dir, 0);
  assert.ok(await until(() => fs.existsSync(t.dev) && fs.existsSync(t.peer), 5000));
  const sp = new SerialPort(t.dev, { baud: 38400 });
  await sp.open();
  let got = '';
  sp.on('data', (b) => { got += b.toString(); });
  t.write('hello\r\n');
  assert.ok(await until(() => got.includes('hello'), 3000));
  const peerFd = fs.openSync(t.peer, 'r+');
  await sp.write('CSV HDR\r');
  const buf = Buffer.alloc(64);
  await wait(200);
  let n = 0;
  try { n = fs.readSync(peerFd, buf, 0, 64, null); } catch (_) {}
  fs.closeSync(peerFd);
  assert.equal(buf.subarray(0, n).toString(), 'CSV HDR\r');
  let closed = null;
  sp.on('close', (e) => { closed = e; });
  t.p.kill();
  assert.ok(await until(() => closed, 5000), 'the hang-up is reported');
  assert.equal(sp.isOpen, false);
});

test('the agent: finds, identifies and decodes every receiver, posts to MegaNet, and survives an unplug', { skip: !hasSocat && 'socat not installed', timeout: 90000 }, async (t) => {
  const m = await stub.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-int-'));
  for (const d of ['dev', 'data', 'etc', 'bin']) fs.mkdirSync(path.join(dir, d));
  const usb = path.join(dir, 'sys', 'bus', 'usb', 'devices', '1-1.3');
  fs.mkdirSync(usb, { recursive: true });
  for (const [k, v] of Object.entries({ idVendor: '0bda', idProduct: '2838', serial: '00000001', manufacturer: 'RTLSDRBlog', product: 'Blog V4', busnum: '1', devnum: '4' })) fs.writeFileSync(path.join(usb, k), v + '\n');
  fs.symlinkSync(path.join(__dirname, 'helpers', 'fake-rtl_sdr'), path.join(dir, 'bin', 'rtl_sdr'));
  fs.writeFileSync(path.join(dir, 'bin', 'aplay'), '#!/bin/sh\ncat > /dev/null\n', { mode: 0o755 });
  const port = 18000 + Math.floor(Math.random() * 2000);
  fs.writeFileSync(path.join(dir, 'etc', 'config.json'), JSON.stringify({
    name: 'Integration', web: { port },
    meganet: { token: 'mgn_test_token', endpoints: [m.url + '/rest/v1'], stationsUrls: [m.url + '/stations.json'] },
    location: { source: 'manual', lat: -27.47, lon: 153.02 },
    receivers: { sdr: { sampleRate: 240000 } },
  }));
  const ptys = [0, 1, 2].map(n => pty(dir, n));
  await until(() => ptys.every(p => fs.existsSync(p.dev)), 5000);
  const env = Object.assign({}, process.env, {
    PATH: path.join(dir, 'bin') + ':' + process.env.PATH, RPI_ALERT_CONFIG: path.join(dir, 'etc', 'config.json'), RPI_ALERT_DATA: path.join(dir, 'data'),
    RPI_ALERT_DEV: path.join(dir, 'dev'), RPI_ALERT_SYSFS: path.join(dir, 'sys'), RPI_ALERT_ASSUME_CLOCK: '1', RPI_ALERT_PRIV: '/nonexistent',
  });
  const agent = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'rpi-alert'), 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  agent.stderr.on('data', (d) => { log += d; });
  t.after(async () => { agent.kill('SIGTERM'); ptys.forEach(p => p.p.kill()); await m.close(); });
  const api = async (p) => { try { const r = await fetch('http://127.0.0.1:' + port + p); return await r.json(); } catch (_) { return null; } };
  assert.ok(await until(async () => !!(await api('/api/status')), 15000), 'the web API comes up:\n' + log);

  ptys[0].write('HDR,fw,4d06107f,schema,2\r\nDEC,1041,1790843886,187340,12,2088,MARBURG,BATT,143,14.3,V,ABF,STD,1,0,-20,-121,-109,89,412,16067B23,00010110000001100111101100100011\r\n');
  ptys[1].write('ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,28,32.582,0,0,0,0,0,1,0,0,0,7,11,9999,74,69,20,2D,13,8A,00,2C,13,0C,00\r\n');
  ptys[2].write(nmea('GPGGA,123519,2727.000,S,15301.500,E,1,08,0.9,545.4,M,46.9,M,,'));

  const kinds = async () => { const s = await api('/api/status'); return s ? [...s.devices.ports, ...s.devices.sdrs].filter(d => d.state === 'running').map(d => d.kind).sort() : []; };
  assert.ok(await until(async () => (await kinds()).join() === 'ert-a2,gps,quansheng,sdr', 20000), 'all four receivers running: ' + (await kinds()).join() + '\n' + log);

  // ALERT from the radio, ALERT2 from the ERT-A2, ALERT off the air from the SDR.
  const posted = () => m.calls.filter(c => c.fn === 'ingest_http' && c.body).flatMap(c => c.body.payload.readings.map(r => c.body.payload.protocol + ':' + r.alert_id + '=' + r.value_raw + '@' + c.body.payload.path.split('-').pop()));
  assert.ok(await until(() => ['alert:2088=143@qs1', 'alert2:4909=138@ert1', 'alert2:4908=12@ert1', 'alert:2088=143@sdr1', 'alert:2089=12@sdr1'].every(x => posted().includes(x)), 40000),
    'posted: ' + posted().join(' ') + '\n' + log.slice(-2000));
  const reports = m.calls.filter(c => c.fn === 'report_ingest_point' && c.body).map(c => c.body.payload.receiver);
  assert.ok(['quansheng', 'ert-a2', 'rtl-sdr'].every(r => reports.includes(r)), 'each receiver described itself: ' + reports.join());
  // How each was heard, on the reading itself (MegaNet 0050): the radio's RSSI
  // and its SNR over the noise floor in dBm, the stick's level in dBFS and its
  // SNR, and the frequency of the channel that heard it.
  const sent = (suffix, id) => m.calls.filter(c => c.fn === 'ingest_http' && c.body && c.body.payload.path.endsWith(suffix))
    .flatMap(c => c.body.payload.readings).find(r => r.alert_id === id);
  const qs = sent('-qs1', 2088), sdr = sent('-sdr1', 2088);
  assert.ok(qs && qs.rssi_dbm === -20 && qs.snr_db === 101 && !('level_dbfs' in qs), 'the radio\'s reading: ' + JSON.stringify(qs));
  assert.ok(sdr && sdr.freq_mhz === 151.5 && Number.isFinite(sdr.level_dbfs) && Number.isFinite(sdr.snr_db) && !('rssi_dbm' in sdr), 'the stick\'s reading: ' + JSON.stringify(sdr));

  // Unplug the radio, plug it back in: it is reopened and decodes again.
  ptys[0].p.kill();
  assert.ok(await until(async () => { const s = await api('/api/status'); const q = s.devices.ports.find(d => d.kind === 'quansheng'); return q && q.state !== 'running'; }, 10000));
  ptys[0] = pty(dir, 0);
  await until(() => fs.existsSync(ptys[0].peer), 5000);
  await wait(3000);
  ptys[0].write('DEC,1042,1790843919,220510,12,2443,KINGSHOLME MO,BATT,142,14.2,V,ABF,STD,1,0,-47,-121,-109,62,530,D2663B23,11010010011001100011101100100011\r\n');
  assert.ok(await until(() => posted().includes('alert:2443=142@qs1'), 20000), 'decoding again after the replug:\n' + log.slice(-2000));
});
