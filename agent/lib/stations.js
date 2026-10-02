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

const fs = require('node:fs');
const path = require('node:path');

const REFRESH_MS = 24 * 60 * 60 * 1000;

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

// stations.json → { byAid: { aid: [[stationIndex, kind], …] }, stations: [{ id, name, number, lat, lon }] }
function buildIndex(doc) {
  const list = Array.isArray(doc && doc.stations) ? doc.stations : [];
  const stations = [];
  const byAid = {};
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
  });
  return { byAid, stations, builtAt: new Date().toISOString(), count: stations.length };
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
      if (j && j.byAid && Array.isArray(j.stations)) { this.index = j; this.fetchedAt = Date.parse(j.builtAt) || 0; }
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

  status() { return { count: this.index ? this.index.count : 0, builtAt: this.index ? this.index.builtAt : null, error: this.error || null }; }
}

module.exports = { Stations, buildIndex, kindOf, km };
