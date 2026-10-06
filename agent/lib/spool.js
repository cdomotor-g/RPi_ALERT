'use strict';
// A queue kept on disk that does not have to fit in memory.
//
// The uplink used to keep everything waiting for MegaNet in memory and write
// it out whole, as one JSON file, two seconds after every change. That is fine
// for the few minutes an internet outage usually lasts, and wrong for days of
// it — a site survey with no network, or a base station whose link is down
// over a long weekend: 150,000 readings and as many receptions are ~100 MB of
// heap, a Pi 3's whole V8 heap is ~250 MB, and rewriting 100 MB every couple
// of seconds blocks the agent for seconds at a time and wears out the SD card.
//
// So each queue is a directory of segment files, one item per line, written
// only by appending:
//
//   0000000007.jsonl          the newest segment, still being added to
//   0000000006.n1000.jsonl    a full one (the line count in its name)
//   0000000006.ack            the line numbers of segment 6 already sent, appended
//
// What is in memory is the newest segment (at most `segItems` items) and the
// oldest one or two being sent from — a few megabytes however long the queue
// on disk grows. A segment whose every line is sent is deleted. Appends and
// acks are buffered and written by flush(), which the uplink calls two seconds
// after a change, as it always has: a power cut loses at most the last couple
// of seconds. Sending again what was sent is safe (MegaNet stores a reading or
// a reception once), so an ack lost to a power cut costs a resend, never data.

const fs = require('node:fs');
const path = require('node:path');

const NAME = /^(\d{10})(?:\.n(\d+))?\.jsonl$/;
const pad = (n) => String(n).padStart(10, '0');

class Spool {
  // opts: { dir, segItems (1000), log }
  constructor(opts) {
    this.dir = opts.dir;
    this.segItems = opts.segItems || 1000;
    this.log = opts.log;
    this.inUse = new Set(); // the segments the last peek() came from
    this.segs = [];        // oldest first: { seq, closed, n, ackedN, bytes, items|null, acked: Set|null, lines: [], acks: [] }
    this.bad = 0;          // lines on disk that could not be read back (a power cut mid-write)
  }

  file(s) { return path.join(this.dir, pad(s.seq) + (s.closed ? '.n' + s.n : '') + '.jsonl'); }
  ackFile(s) { return path.join(this.dir, pad(s.seq) + '.ack'); }

  load() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (_) {}
    const bySeq = new Map();
    for (const name of names) {
      const m = NAME.exec(name);
      if (!m) continue;
      const seq = Number(m[1]);
      if (bySeq.has(seq)) continue;
      let bytes = 0;
      try { bytes = fs.statSync(path.join(this.dir, name)).size; } catch (_) { continue; }
      bySeq.set(seq, { seq, closed: m[2] != null, n: m[2] != null ? Number(m[2]) : 0, ackedN: 0, bytes, items: null, acked: null, lines: [], acks: [] });
    }
    // Ack files with no segment are left over from a delete cut short.
    for (const name of names) {
      const m = /^(\d{10})\.ack$/.exec(name);
      if (m && !bySeq.has(Number(m[1]))) try { fs.unlinkSync(path.join(this.dir, name)); } catch (_) {}
    }
    this.segs = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    for (const s of this.segs) {
      // A segment still open when the agent stopped is closed now, with the
      // lines it has: it is never appended to again, so a line half-written
      // as the power went is never followed by another.
      if (!s.closed) {
        const from = this.file(s);
        s.n = this.readLines(from).length;
        s.closed = true;
        try { fs.renameSync(from, this.file(s)); } catch (_) {}
      }
      s.ackedN = this.readAcks(s).size;
    }
    for (const s of this.segs.slice()) if (s.ackedN >= s.n) this.remove(s);
    this.open();
    return this;
  }

  readLines(file) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  readAcks(s) {
    const set = new Set();
    for (const line of this.readLines(this.ackFile(s))) {
      try { for (const i of JSON.parse(line)) if (Number.isInteger(i) && i >= 0 && i < s.n) set.add(i); } catch (_) {}
    }
    return set;
  }

  // A new segment to add to.
  open() {
    const last = this.segs[this.segs.length - 1];
    const s = { seq: last ? last.seq + 1 : 1, closed: false, n: 0, ackedN: 0, bytes: 0, items: [], acked: new Set(), lines: [], acks: [] };
    this.segs.push(s);
    return s;
  }

  tail() { const t = this.segs[this.segs.length - 1]; return t && !t.closed ? t : this.open(); }

  push(item) {
    let t = this.tail();
    const line = JSON.stringify(item) + '\n';
    t.items.push(item);
    t.lines.push(line);
    t.n++;
    t.bytes += Buffer.byteLength(line);
    if (t.n >= this.segItems) this.close(t);
  }

  close(s) {
    this.writeLines(s);
    const from = this.file(s);
    s.closed = true;
    try { if (fs.existsSync(from)) fs.renameSync(from, this.file(s)); } catch (e) { this.warn('could not close a queue segment: ' + e.message); }
    if (s.ackedN >= s.n) this.remove(s);
    this.unload();
  }

  load1(s) {
    if (s.items) return;
    const lines = this.readLines(this.file(s));
    s.items = new Array(s.n).fill(null);
    s.acked = this.readAcks(s);
    for (let i = 0; i < s.n; i++) {
      if (i >= lines.length) { s.acked.add(i); this.bad++; continue; }
      try { s.items[i] = JSON.parse(lines[i]); } catch (_) { s.acked.add(i); this.bad++; }
    }
    s.ackedN = s.acked.size;
  }

  // Keep the newest segment and those being sent from in memory; let the
  // rest go once what they owe the disk is written.
  unload() {
    for (const s of this.segs) {
      if (!s.closed || !s.items || this.inUse.has(s)) continue;
      if (s.lines.length || s.acks.length) continue;
      s.items = null; s.acked = null;
    }
  }

  // The oldest `max` items not yet sent: [{ s, i, item }], oldest first.
  peek(max) {
    const out = [];
    for (const s of this.segs) {
      if (out.length >= max) break;
      if (s.ackedN >= s.n) continue;
      this.load1(s);
      for (let i = 0; i < s.n && out.length < max; i++) if (!s.acked.has(i) && s.items[i] != null) out.push({ s, i, item: s.items[i] });
    }
    this.inUse = new Set(out.map(e => e.s));
    this.unload();
    return out;
  }

  // These went (or will never go): forget them.
  ack(entries) {
    const by = new Map();
    for (const e of entries) {
      if (!this.segs.includes(e.s)) continue;
      this.load1(e.s);
      if (e.s.acked.has(e.i)) continue;
      e.s.acked.add(e.i); e.s.ackedN++;
      if (!by.has(e.s)) by.set(e.s, []);
      by.get(e.s).push(e.i);
    }
    for (const [s, list] of by) {
      if (s.closed && s.ackedN >= s.n) { this.remove(s); continue; }
      s.acks.push(JSON.stringify(list) + '\n');
    }
  }

  remove(s) {
    for (const f of [this.file(s), this.ackFile(s)]) try { fs.unlinkSync(f); } catch (_) {}
    const k = this.segs.indexOf(s);
    if (k >= 0) this.segs.splice(k, 1);
  }

  // Make room: forget the oldest segment. → how many unsent items went with it.
  dropOldest() {
    const s = this.segs.find(x => x.ackedN < x.n);
    if (!s) return 0;
    const lost = s.n - s.ackedN;
    if (s.closed) this.remove(s);
    else { s.acked = new Set(Array.from({ length: s.n }, (_, i) => i)); s.ackedN = s.n; s.acks = [JSON.stringify([...s.acked]) + '\n']; }
    return lost;
  }

  // Every item not yet sent, oldest first, one segment in memory at a time;
  // all of them are gone from the queue afterwards (for timing held items).
  drain(fn) {
    this.flush();
    for (const s of this.segs.slice()) {
      this.load1(s);
      for (let i = 0; i < s.n; i++) if (!s.acked.has(i) && s.items[i] != null) fn(s.items[i]);
      this.remove(s);
    }
    this.open();
  }

  writeLines(s) {
    if (!s.lines.length) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file(s), s.lines.join(''));
      s.lines = [];
    } catch (e) { this.warn('could not save the queue: ' + e.message); }
  }

  flush() {
    for (const s of this.segs) {
      this.writeLines(s);
      if (s.acks.length && !s.lines.length) {
        try { fs.appendFileSync(this.ackFile(s), s.acks.join('')); s.acks = []; } catch (e) { this.warn('could not save the queue: ' + e.message); }
      }
    }
    // An open segment with nothing in it is no file at all.
  }

  get length() { let n = 0; for (const s of this.segs) n += s.n - s.ackedN; return n; }
  bytes() { let b = 0; for (const s of this.segs) b += s.bytes; return b; }
  loadedItems() { let n = 0; for (const s of this.segs) if (s.items) n += s.items.length; return n; }

  warn(msg) { if (msg !== this.lastWarn) { this.lastWarn = msg; this.log && this.log.warn(msg); } }
}

module.exports = { Spool };
