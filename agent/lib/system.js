'use strict';
// The Pi itself: name, addresses, temperature, power, and the root helper for
// the few things the agent (an unprivileged user) has to ask root to do —
// start the kiosk, join a Wi-Fi network, reboot. The helper takes a fixed list
// of verbs and checks every argument (os/libexec/rpi-alert-priv); sudo lets
// the agent's user run exactly that one program.

const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');

const PRIV = process.env.RPI_ALERT_PRIV || '/opt/rpi-alert/libexec/rpi-alert-priv';

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, Object.assign({ timeout: 30000, maxBuffer: 1 << 20 }, opts || {}), (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && err.code === 'ENOENT' ? cmd + ' not found' : '')), missing: !!(err && err.code === 'ENOENT') });
    });
  });
}

function privAvailable() { try { fs.accessSync(PRIV, fs.constants.X_OK); return true; } catch (_) { return false; } }

async function priv(verb, ...args) {
  if (!privAvailable()) return { code: -1, stdout: '', stderr: 'the system helper is not installed (development machine?)', missing: true };
  return run('sudo', ['-n', PRIV, verb, ...args.map(String)], { timeout: 120000 });
}

function read(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return null; } }

function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (!a.internal && (a.family === 'IPv4' || a.family === 4)) out.push({ iface: name, address: a.address });
  }
  return out;
}

let throttled = { at: 0, value: null };
async function throttledFlags() {
  if (Date.now() - throttled.at < 30000) return throttled.value;
  throttled.at = Date.now();
  const r = await run('vcgencmd', ['get_throttled'], { timeout: 3000 });
  const m = /throttled=(0x[0-9a-f]+)/i.exec(r.stdout);
  if (!m) { throttled.value = null; return null; }
  const v = parseInt(m[1], 16);
  throttled.value = {
    raw: m[1],
    underVoltageNow: !!(v & 0x1), throttledNow: !!(v & 0x4),
    underVoltageSinceBoot: !!(v & 0x10000), throttledSinceBoot: !!(v & 0x40000),
  };
  return throttled.value;
}

async function info() {
  const t = read('/sys/class/thermal/thermal_zone0/temp');
  let disk = null;
  try { const s = fs.statfsSync('/'); disk = { freeMb: Math.round(s.bavail * s.bsize / 1048576), totalMb: Math.round(s.blocks * s.bsize / 1048576) }; } catch (_) {}
  return {
    hostname: os.hostname(), addresses: addresses(), uptimeS: Math.round(os.uptime()),
    model: (read('/proc/device-tree/model') || '').replace(/\0/g, '') || os.type() + ' ' + os.arch(),
    os: (read('/etc/os-release') || '').match(/PRETTY_NAME="([^"]+)"/)?.[1] || os.release(),
    arch: os.arch(), node: process.version,
    tempC: t ? Math.round(Number(t) / 100) / 10 : null,
    load: os.loadavg().map(x => Math.round(x * 100) / 100), cores: os.cpus().length,
    memMb: { total: Math.round(os.totalmem() / 1048576), free: Math.round(os.freemem() / 1048576) },
    disk, power: await throttledFlags(),
  };
}

// Is anything plugged into an HDMI (or DSI/composite) connector?
function displayConnected() {
  let names = [];
  try { names = fs.readdirSync('/sys/class/drm').filter(n => /^card\d+-/.test(n) && !/Writeback/i.test(n)); } catch (_) { return false; }
  return names.some(n => read('/sys/class/drm/' + n + '/status') === 'connected');
}

// rpi-alert-priv update-status: the timer's state, whether an install is running,
// then the last outcome (update-status.json, written by rpi-alert-update).
async function updateStatus() {
  const r = await priv('update-status');
  if (r.code !== 0) return { available: false, error: (r.stderr || '').trim().slice(0, 300) || 'not available on this machine' };
  const [timer = '', running = '', ...rest] = r.stdout.split('\n');
  let last = null;
  try { last = JSON.parse(rest.join('\n')); } catch (_) {}
  return { available: true, auto: timer.trim() === 'enabled', running: running.trim() === 'running', last: last && last.state ? last : null };
}

// rpi-alert-priv access-status: who may log in over SSH, and how (lib/access.js).
async function accessStatus() {
  const r = await priv('access-status');
  if (r.code !== 0) return { available: false, error: (r.stderr || '').trim().slice(0, 300) || 'not available on this machine' };
  try { return Object.assign({ available: true }, JSON.parse(r.stdout)); } catch (_) { return { available: false, error: 'unreadable answer' }; }
}

module.exports = { run, priv, privAvailable, info, addresses, displayConnected, updateStatus, accessStatus, PRIV };
