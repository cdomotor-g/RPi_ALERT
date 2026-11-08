'use strict';
// Reading and writing files in a directory someone else may write to.
//
// /etc/rpi-alert and /var/lib/rpi-alert belong to the agent's own user, and
// some of what lives there is read or written as root: the SD card's settings
// at boot (bootconf.js), the installer, `sudo rpi-alert …`. A file there may
// be a link the agent planted — config.json pointing at /etc/shadow, say —
// and root following it would read or overwrite whatever it points at. So:
//
//   readNoFollow   refuses a link, a device or a FIFO, and a file with a second
//                  name (a hard link), and reads at most maxBytes.
//   writeAtomic    writes a new file under a name nobody can have planted
//                  (random, created exclusively, never through a link), sets
//                  its mode and — as root, when asked — its owner on the open
//                  file, then renames it into place. A rename replaces a link
//                  rather than following it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const C = fs.constants;
const NOFOLLOW = C.O_NOFOLLOW || 0;
const NONBLOCK = C.O_NONBLOCK || 0;

function refuse(file, why) {
  const e = new Error(file + ' ' + why + ' — not read');
  e.code = 'EUNSAFE';
  return e;
}

function readNoFollow(file, maxBytes) {
  const max = maxBytes || 1024 * 1024;
  let fd;
  try { fd = fs.openSync(file, C.O_RDONLY | NOFOLLOW | NONBLOCK); }
  catch (e) { if (e.code === 'ELOOP') throw refuse(file, 'is a link'); throw e; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw refuse(file, 'is not a plain file');
    if (st.nlink > 1) throw refuse(file, 'has more than one name (a hard link)');
    if (st.size > max) throw refuse(file, 'is larger than ' + max + ' bytes');
    const buf = Buffer.alloc(Math.min(st.size, max));
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (!n) break;
      got += n;
    }
    return buf.subarray(0, got).toString('utf8');
  } finally { fs.closeSync(fd); }
}

// opts: { mode (default 0o600), owner: 'dir' — as root, give the file to the
// directory's owner (the agent's user, in its own directories) }.
function writeAtomic(file, data, opts) {
  const o = opts || {};
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + crypto.randomBytes(6).toString('hex') + '.tmp');
  const mode = o.mode == null ? 0o600 : o.mode;
  // wx: O_CREAT|O_EXCL — fails on anything already there, a link included.
  const fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | NOFOLLOW, mode);
  try {
    fs.writeSync(fd, typeof data === 'string' ? data : Buffer.from(data));
    fs.fchmodSync(fd, mode);
    if (o.owner === 'dir' && process.getuid && process.getuid() === 0) {
      const st = fs.statSync(dir);
      fs.fchownSync(fd, st.uid, st.gid);
    }
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  fs.closeSync(fd);
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
}

module.exports = { readNoFollow, writeAtomic };
