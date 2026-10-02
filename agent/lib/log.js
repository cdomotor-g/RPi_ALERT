'use strict';
// One logger for the whole agent. Lines go to stderr, which systemd hands to
// the journal (`journalctl -u rpi-alert`), and the newest few hundred are kept
// in memory for the web page's log panel and `rpi-alert status`.

const { EventEmitter } = require('node:events');

const RING = 400;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const bus = new EventEmitter();
bus.setMaxListeners(100);
const ring = [];
let threshold = LEVELS[process.env.RPI_ALERT_LOG_LEVEL] || LEVELS.info;
// Under systemd the journal stamps each line itself; on a terminal, we do.
const stamp = !process.env.INVOCATION_ID;

function fmt(v) {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'object' && v !== null) { try { return JSON.stringify(v); } catch (_) { return String(v); } }
  return String(v);
}

function write(level, tag, args) {
  if (LEVELS[level] < threshold) return;
  const msg = args.map(fmt).join(' ');
  const entry = { t: Date.now(), level, tag, msg };
  ring.push(entry);
  if (ring.length > RING) ring.shift();
  const line = (stamp ? new Date(entry.t).toISOString() + ' ' : '') + level.toUpperCase().padEnd(5) + ' [' + tag + '] ' + msg;
  process.stderr.write(line + '\n');
  bus.emit('line', entry);
}

function logger(tag) {
  return {
    debug: (...a) => write('debug', tag, a),
    info: (...a) => write('info', tag, a),
    warn: (...a) => write('warn', tag, a),
    error: (...a) => write('error', tag, a),
    child: (sub) => logger(tag + '/' + sub),
  };
}

module.exports = {
  logger,
  recent: (n) => ring.slice(-(n || RING)),
  on: (fn) => { bus.on('line', fn); return () => bus.off('line', fn); },
  setLevel: (l) => { if (LEVELS[l]) threshold = LEVELS[l]; },
};
