'use strict';
// MegaNet's station register, reduced to what a receiver needs: which station
// an ALERT address belongs to, what that address reports, and where it is.
//
// Fetched from MegaNet's public stations.json (the same document the website
// loads) once a day, and kept on disk so a base station with no internet still
// names what it hears. Purely for display and for "where is this receiver":
// MegaNet resolves addresses itself when readings arrive, so nothing here
// changes what is stored.
//
// ALERT addresses are unique only within a region — hundreds are carried by
// more than one station — so a lookup returns every candidate, nearest first
// when the receiver's location is known.
//
// And the frequencies the stations use — each repeater's own RX/TX pair, and
// every other pair a station lists (its `frequencies`, MegaNet 0033) — for the
// settings page to offer a stick's channels from: which stations transmit on
// each and which listen on it (a field station transmits on its repeater's
// RX), what it is for, and how near.

const fs = require('node:fs');
const path = require('node:path');

const REFRESH_MS = 24 * 60 * 60 * 1000;
const NEAR_KM = 150;         // "near" a receiver, for the frequencies it is offered: a long VHF path

function kindOf(type) {
  const t = String(type || '').toLowerCase();
  if (/batt|volt/.test(t)) return 'BATT';
  if (/rain/.test(t)) return 'RAIN';
  if (/level|stage|height|river/.test(t)) return 'LVL';
  if (/repeat/.test(t)) return 'REP';
  return 'SNSR';
}

function km(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// The index's shape: an older one is fetched again at once.
const INDEX_V = 2;

// stations.json → { v, byAid: { aid: [[stationIndex, kind], …] }, stations: [{ id, name, number, lat, lon }],
//   freqs: [[hz, [tx stationIndex…], [rx stationIndex…], [label…]]] }
function buildIndex(doc) {
  const list = Array.isArray(doc && doc.stations) ? doc.stations : [];
  const stations = [];
  const byAid = {};
  const freqs = new Map();
  const use = (mhz, side, idx, label) => {
    const hz = Math.round(Number(mhz) * 1e6);
    if (!(hz >= 24e6 && hz <= 1766e6)) return;
    const f = freqs.get(hz) || freqs.set(hz, { tx: new Set(), rx: new Set(), labels: new Set() }).get(hz);
    f[side].add(idx);
    if (label) f.labels.add(String(label).slice(0, 60));
  };
  list.forEach(st => {
    const kinds = new Map();
    for (const s of st.sensors || []) if (Number.isInteger(s.alert_id) && s.alert_id > 0) {
      const k = kindOf(s.type);
      if (!kinds.has(s.alert_id) || kinds.get(s.alert_id) === 'SNSR') kinds.set(s.alert_id, k);
    }
    const ids = st.alert_ids || {};
    for (const [key, k] of [['rainfall', 'RAIN'], ['water_level', 'LVL'], ['battery', 'BATT']]) {
      if (Number.isInteger(ids[key]) && !kinds.has(ids[key])) kinds.set(ids[key], k);
    }
    const idx = stations.length;
    stations.push({ id: st.id, name: st.name || st.id, number: st.station_number || '', lat: st.lat ?? null, lon: st.lon ?? null });
    for (const [aid, k] of kinds) (byAid[aid] = byAid[aid] || []).push([idx, k]);
    const pairs = (st.repeater ? [st.repeater] : []).concat(Array.isArray(st.frequencies) ? st.frequencies : []);
    for (const p of pairs) {
      if (!p || typeof p !== 'object') continue;
      // A pair's label says what it is for when something is sent on it; on a
      // pair only listened to it is a note about the listening.
      if (p.tx_mhz != null) use(p.tx_mhz, 'tx', idx, p.label);
      if (p.rx_mhz != null) use(p.rx_mhz, 'rx', idx, p.tx_mhz != null ? p.label : null);
    }
  });
  const fl = [...freqs].sort((a, b) => a[0] - b[0]).map(([hz, f]) => [hz, [...f.tx], [...f.rx], [...f.labels]]);
  return { v: INDEX_V, byAid, stations, freqs: fl, builtAt: new Date().toISOString(), count: stations.length };
}

class Stations {
  constructor(opts) {
    this.file = path.join(opts.dataDir, 'stations-index.json');
    this.log = opts.log;
    this.getUrls = opts.getUrls;
    this.index = null;
    this.fetchedAt = 0;
    this.error = '';
    this.timer = null;
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // An index from before it held the frequencies is used, and fetched again at once.
      if (j && j.byAid && Array.isArray(j.stations)) { this.index = j; this.fetchedAt = j.v === INDEX_V ? Date.parse(j.builtAt) || 0 : 0; }
    } catch (_) {}
    return this;
  }

  start() {
    const due = Math.max(5000, REFRESH_MS - (Date.now() - this.fetchedAt));
    this.timer = setTimeout(() => this.refresh(), this.index ? due : 5000);
    this.timer.unref?.();
    return this;
  }
  stop() { clearTimeout(this.timer); }

  async refresh() {
    clearTimeout(this.timer);
    for (const url of this.getUrls()) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const idx = buildIndex(await res.json());
        if (!idx.count) throw new Error('no stations in it');
        this.index = idx; this.fetchedAt = Date.now(); this.error = '';
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(idx));
        fs.renameSync(this.file + '.tmp', this.file);
        this.log.info('station register: ' + idx.count + ' stations from ' + url);
        break;
      } catch (e) {
        this.error = url + ': ' + e.message;
      }
    }
    if (this.error && Date.now() - this.fetchedAt > REFRESH_MS) this.log.warn('could not refresh the station register (' + this.error + ')');
    this.timer = setTimeout(() => this.refresh(), this.error && !this.index ? 10 * 60 * 1000 : REFRESH_MS);
    this.timer.unref?.();
  }

  // Every station carrying this address, nearest first when `near` is given.
  lookup(aid, near) {
    if (!this.index) return [];
    const rows = (this.index.byAid[aid] || []).map(([i, kind]) => Object.assign({ kind }, this.index.stations[i]));
    if (near && Number.isFinite(near.lat) && Number.isFinite(near.lon)) {
      rows.forEach(r => { r.km = r.lat != null ? Math.round(km(near.lat, near.lon, r.lat, r.lon) * 10) / 10 : null; });
      rows.sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9));
    }
    return rows;
  }

  // For the location picker: by id, number, or name.
  search(q, limit) {
    if (!this.index) return [];
    const s = String(q || '').trim().toLowerCase();
    if (!s) return [];
    const exact = this.index.stations.filter(x => String(x.id).toLowerCase() === s || String(x.number).toLowerCase() === s);
    if (exact.length) return exact.slice(0, limit || 10);
    return this.index.stations.filter(x => String(x.name).toLowerCase().includes(s)).slice(0, limit || 10);
  }

  byId(id) { return this.index ? this.index.stations.find(x => x.id === id || x.number === id) || null : null; }

  // The frequencies the stations use, the most used first — or, given where
  // this receiver is, the most used within NEAR_KM — each with how many
  // stations transmit and listen on it, what for, and the nearest that do.
  // → [{ freqHz, tx, rx, near (within NEAR_KM; null with no location), km
  //      (the nearest; null), labels, stations: [{ name, km, tx, rx }] }]
  frequencies(near) {
    const fl = this.index && Array.isArray(this.index.freqs) ? this.index.freqs : [];
    const here = near && Number.isFinite(near.lat) && Number.isFinite(near.lon) ? near : null;
    const st = this.index ? this.index.stations : [];
    const out = fl.map(([hz, tx, rx, labels]) => {
      const who = [...new Set(tx.concat(rx))].map(i => {
        const s = st[i] || {};
        const km1 = here && s.lat != null && s.lon != null ? Math.round(km(here.lat, here.lon, s.lat, s.lon)) : null;
        return { name: s.name || s.id, km: km1, tx: tx.includes(i), rx: rx.includes(i) };
      }).sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9) || String(a.name).localeCompare(String(b.name)));
      return { freqHz: hz, tx: tx.length, rx: rx.length, near: here ? who.filter(w => w.km != null && w.km <= NEAR_KM).length : null,
        km: who.length && who[0].km != null ? who[0].km : null, labels: labels.slice(0, 4), stations: who.slice(0, 5) };
    });
    return out.sort((a, b) => (here ? (b.near - a.near) || ((a.km ?? 1e9) - (b.km ?? 1e9)) : 0) || (b.tx + b.rx) - (a.tx + a.rx) || a.freqHz - b.freqHz);
  }

  status() { return { count: this.index ? this.index.count : 0, builtAt: this.index ? this.index.builtAt : null, error: this.error || null }; }
}

module.exports = { Stations, buildIndex, kindOf, km, NEAR_KM };
