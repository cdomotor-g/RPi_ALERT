'use strict';
// A serial port with no native module: the tty is opened non-blocking, its
// line settings are made with stty(1) while the agent holds it open, and it is
// read by polling. Nothing here can wedge a libuv thread on a blocking read, so
// a port that goes quiet, or away, never takes the rest of the agent with it.
//
//   * A read with nothing waiting answers EAGAIN: poll again shortly.
//   * A read that answers 0 bytes, EIO, ENXIO or ENODEV is the device hanging
//     up (unplugged, powered off, rebooted): the port reports 'close' with the
//     reason and the device manager reopens it when the device node returns.
//   * HUPCL is set, so the last close drops DTR and the next open raises it.
//     That is how DTR is toggled without an ioctl — the Quansheng ALERT
//     firmware sends only while the host holds DTR, and needs it toggled after
//     it decides the host has gone (its ALERT_SERIAL.md §2).
//   * A read in flight is never raced by a close: the fd is closed only once
//     the read has come back, so a reused fd number can never be read by the
//     wrong port.

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const POLL_MS = 25;
const GONE = new Set(['EIO', 'ENXIO', 'ENODEV', 'EBADF', 'ENOENT', 'EPIPE']);
const BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

function stty(dev, baud) {
  // raw: no line discipline processing, 8N1, no flow control; clocal: ignore
  // carrier detect; hupcl: drop DTR on the last close; min 1 time 0 with
  // O_NONBLOCK makes an empty read answer EAGAIN and a hung-up one answer 0.
  const args = ['-F', dev, String(baud), 'raw', '-echo', '-echoe', '-echok', '-echoctl', '-echoke', '-iexten',
    'cs8', '-cstopb', '-parenb', 'clocal', 'cread', 'hupcl', '-crtscts', '-ixon', '-ixoff', 'min', '1', 'time', '0'];
  return new Promise((resolve, reject) => {
    execFile('stty', args, { timeout: 5000 }, (err, _out, serr) => {
      if (err) reject(new Error('stty ' + dev + ' ' + baud + ': ' + String(serr || err.message).trim()));
      else resolve();
    });
  });
}

class SerialPort extends EventEmitter {
  constructor(dev, opts) {
    super();
    this.path = dev;
    this.baud = (opts && opts.baud) || 9600;
    this.fd = null;
    this.reading = false;
    this.inflight = false;
    this.pendingClose = null;
    this.timer = null;
    this.buf = Buffer.alloc(16384);
    this.rx = 0;
    this.tx = 0;
    this.lastRx = 0;
    this.opened = 0;
  }

  get isOpen() { return this.fd != null && !this.pendingClose; }

  open() {
    if (this.fd != null) return Promise.resolve();
    const flags = fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK;
    return new Promise((resolve, reject) => {
      fs.open(this.path, flags, (err, fd) => {
        if (err) return reject(err);
        this.fd = fd;
        stty(this.path, this.baud).then(() => {
          this.opened = Date.now();
          this.reading = true;
          this.poll();
          resolve();
        }, (e) => {
          const f = this.fd; this.fd = null;
          fs.close(f, () => reject(e));
        });
      });
    });
  }

  // A new speed, on the open port.
  async setBaud(baud) {
    this.baud = baud;
    if (this.fd != null) await stty(this.path, baud);
  }

  poll() {
    if (!this.reading || this.fd == null || this.inflight) return;
    this.inflight = true;
    fs.read(this.fd, this.buf, 0, this.buf.length, null, (err, n) => {
      this.inflight = false;
      if (this.pendingClose) { this.finishClose(); return; }
      if (!this.reading) return;
      if (err) {
        if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK' || err.code === 'EINTR') {
          this.timer = setTimeout(() => this.poll(), POLL_MS);
          return;
        }
        this.fail(err);
        return;
      }
      if (n === 0) { this.fail(Object.assign(new Error('the device hung up'), { code: 'EOF' })); return; }
      this.rx += n;
      this.lastRx = Date.now();
      const chunk = Buffer.from(this.buf.subarray(0, n));
      setImmediate(() => this.poll());
      this.emit('data', chunk);
    });
  }

  write(data) {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return new Promise((resolve, reject) => {
      let off = 0, tries = 0;
      const step = () => {
        if (this.fd == null || this.pendingClose) return reject(new Error('port is closed'));
        fs.write(this.fd, b, off, b.length - off, null, (err, n) => {
          if (err) {
            if ((err.code === 'EAGAIN' || err.code === 'EINTR') && ++tries < 200) return setTimeout(step, 10);
            if (GONE.has(err.code)) this.fail(err);
            return reject(err);
          }
          off += n; this.tx += n;
          if (off < b.length) return setImmediate(step);
          resolve();
        });
      };
      step();
    });
  }

  fail(err) {
    if (this.fd == null || this.pendingClose) return;
    this.close().then(() => this.emit('close', err));
  }

  close() {
    this.reading = false;
    clearTimeout(this.timer);
    if (this.fd == null) return Promise.resolve();
    if (this.pendingClose) return this.pendingClose;
    this.pendingClose = new Promise((resolve) => { this.resolveClose = resolve; });
    if (!this.inflight) this.finishClose();
    return this.pendingClose;
  }

  finishClose() {
    const fd = this.fd, done = this.resolveClose;
    this.fd = null;
    fs.close(fd, () => { this.pendingClose = null; done(); });
  }

  // Drop DTR, wait, raise it: close (HUPCL drops it) and open again.
  async toggleDtr(ms) {
    await this.close();
    await new Promise(r => setTimeout(r, ms || 100));
    await this.open();
  }
}

module.exports = { SerialPort, stty, BAUDS, GONE };
