'use strict';
// rpi-alert.conf on the SD card's boot partition — the FAT one every computer
// can open — applied at boot, before the agent starts.
//
// It is how a base station is set up without ever plugging a screen into it:
// flash the card, drop this file next to config.txt (the flasher page writes
// it for you), put the card in the Pi. Plain "key = value" lines, # comments:
//
//   token = mgn_…                     MegaNet ingest token
//   name = Bench Pi                   what MegaNet calls this base station
//   latitude = -27.4698               where it is (approximate unless a GPS says otherwise)
//   longitude = 153.0251
//   location_station = loudoun_br_al  …or the station it sits at (with its latitude/longitude)
//   use_gps = yes                     a USB GPS fix, when there is one, wins
//   sdr_frequency_mhz = 151.5
//   sdr_format = binary               binary | enhanced_iflows | ascii
//   sdr_gain_db = 29.7                or auto
//   sdr_ppm = 0
//   sdr_bias_tee = no
//   audio = auto                      auto | live | synth | beep | off
//   audio_device = default
//   audio_volume = 80
//   kiosk = auto                      auto | on | off
//   web_password = …                  stored hashed; removed from the card
//   timezone = Australia/Brisbane
//   hostname = rpi-alert
//   wifi_ssid = …                     a Wi-Fi network to join (Raspberry Pi Imager can do this too)
//   wifi_password = …
//   wifi_country = AU
//   ssh = on
//
// Once applied the file is renamed rpi-alert.conf.applied with the secrets
// blanked out, and what happened is appended to rpi-alert-boot.log beside it.
// To change something later, write a new rpi-alert.conf.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Config, hashPassword } = require('./config');

const BOOT_DIRS = ['/boot/firmware', '/boot'];
const NAMES = ['rpi-alert.conf', 'rpi-alert.txt', 'rpi-alert.conf.txt'];
const SECRET = new Set(['token', 'web_password', 'wifi_password']);

function parse(text) {
  const out = {};
  String(text).replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) return;
    const m = /^([A-Za-z][\w.-]*)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) { out['_bad_' + (i + 1)] = raw; return; }
    const key = m[1].toLowerCase().replace(/-/g, '_');
    let v = m[2];
    // "value   # a comment" — but never inside a password, which may hold a #.
    if (!SECRET.has(key)) v = v.replace(/\s+#.*$/, '');
    v = v.trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
    out[key] = v;
  });
  return out;
}

const yes = (v) => /^(1|y|yes|on|true|enable|enabled)$/i.test(String(v).trim());
const no = (v) => /^(0|n|no|off|false|disable|disabled)$/i.test(String(v).trim());

// key/values → { patch, system: {…}, notes: [] }
function toPatch(kv) {
  const patch = {}, system = {}, notes = [];
  const set = (p, v) => { const ks = p.split('.'); let c = patch; ks.slice(0, -1).forEach(k => { c = c[k] = c[k] || {}; }); c[ks[ks.length - 1]] = v; };
  const n = (v) => { const x = Number(String(v).replace(',', '.')); return Number.isFinite(x) ? x : NaN; };
  for (const [k, v] of Object.entries(kv)) {
    switch (k) {
      case 'token': case 'meganet_token': case 'ingest_token': set('meganet.token', v.trim()); break;
      case 'name': case 'station_name': case 'base_station_name': set('name', v); break;
      case 'meganet': case 'send_to_meganet': set('meganet.enabled', !no(v)); break;
      case 'send_receptions': case 'receptions': set('meganet.receptions', !no(v)); break;
      case 'latitude': case 'lat': set('location.lat', n(v)); break;
      case 'longitude': case 'lon': case 'lng': set('location.lon', n(v)); break;
      case 'location': {
        const m = /(-?\d+(?:[.]\d+)?)\s*[, ]\s*(-?\d+(?:[.]\d+)?)/.exec(v);
        if (m) { set('location.lat', Number(m[1])); set('location.lon', Number(m[2])); } else notes.push('location: expected "lat, lon"');
        break;
      }
      case 'location_station': case 'station': set('location.station', v); break;
      case 'location_station_name': set('location.stationName', v); break;
      case 'location_accuracy_m': set('location.accuracy_m', n(v)); break;
      case 'use_gps': set('location.useGps', !no(v)); break;
      case 'sdr': case 'sdr_enabled': set('receivers.sdr.enabled', !no(v)); break;
      case 'sdr_frequency_mhz': case 'frequency_mhz': set('receivers.sdr.freqHz', Math.round(n(v) * 1e6)); break;
      case 'sdr_frequency_hz': set('receivers.sdr.freqHz', Math.round(n(v))); break;
      case 'sdr_format': case 'format': set('receivers.sdr.format', String(v).trim().toUpperCase().replace(/[\s-]+/g, '_')); break;
      case 'sdr_gain_db': case 'gain_db': set('receivers.sdr.gainDb', /^(auto|agc)$/i.test(v) ? null : n(v)); break;
      case 'sdr_ppm': case 'ppm': set('receivers.sdr.ppm', n(v)); break;
      case 'sdr_sample_rate': set('receivers.sdr.sampleRate', /^auto$/i.test(v) ? 0 : n(v)); break;
      case 'sdr_bias_tee': case 'bias_tee': set('receivers.sdr.biasTee', yes(v)); break;
      case 'sdr_squelch_db': set('receivers.sdr.squelchDb', n(v)); break;
      case 'auto_detect': case 'receivers_auto_detect': set('receivers.autoDetect', !no(v)); break;
      case 'extra_ports': set('receivers.extraPorts', v.split(/[\s,]+/).filter(Boolean)); break;
      case 'audio': case 'audio_mode': if (no(v)) set('audio.mode', 'off'); else set('audio.mode', String(v).trim().toLowerCase()); break;
      case 'audio_device': set('audio.device', v.trim()); break;
      case 'audio_volume': set('audio.volume', n(v)); break;
      case 'kiosk': case 'display': set('kiosk.mode', no(v) ? 'off' : yes(v) ? 'on' : String(v).trim().toLowerCase()); break;
      case 'timezone': case 'time_zone': set('system.timezone', v.trim()); system.timezone = v.trim(); break;
      case 'web_password': case 'password': set('web.passwordHash', hashPassword(v)); break;
      case 'hostname': system.hostname = v.trim().toLowerCase(); break;
      case 'wifi_ssid': case 'wifi': system.wifiSsid = v; break;
      case 'wifi_password': case 'wifi_psk': system.wifiPassword = v; break;
      case 'wifi_country': case 'country': system.wifiCountry = v.trim().toUpperCase(); break;
      case 'ssh': system.ssh = yes(v) ? 'on' : no(v) ? 'off' : null; break;
      default: notes.push(k.startsWith('_bad_') ? 'line ' + k.slice(5) + ' is not "key = value": ' + v : 'unknown setting "' + k + '" (ignored)');
    }
  }
  // A location: typed coordinates, or a station's (which the flasher page fills in).
  const L = patch.location;
  if (L && Number.isFinite(L.lat) && Number.isFinite(L.lon)) L.source = L.station ? 'station' : 'manual';
  else if (L && (L.lat !== undefined || L.lon !== undefined)) { notes.push('latitude and longitude must both be numbers — location not changed'); delete L.lat; delete L.lon; delete L.station; }
  else if (L && L.station) { notes.push('location_station needs latitude and longitude beside it (the flasher page adds them) — location not changed'); delete L.station; }
  return { patch, system, notes };
}

function sh(cmd, args) {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch (e) { return { ok: false, out: String((e.stderr || e.message) || '').trim() }; }
}
function have(cmd) { return sh('sh', ['-c', 'command -v ' + cmd]).ok; }

function applySystem(s, log) {
  if (s.wifiCountry) {
    if (/^[A-Z]{2}$/.test(s.wifiCountry)) {
      const r = have('raspi-config') ? sh('raspi-config', ['nonint', 'do_wifi_country', s.wifiCountry]) : sh('iw', ['reg', 'set', s.wifiCountry]);
      log((r.ok ? 'Wi-Fi country ' : 'could not set Wi-Fi country ') + s.wifiCountry + (r.ok ? '' : ': ' + r.out));
    } else log('wifi_country must be two letters, e.g. AU');
  }
  if (s.hostname) {
    if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s.hostname)) {
      const r = have('raspi-config') ? sh('raspi-config', ['nonint', 'do_hostname', s.hostname]) : sh('hostnamectl', ['set-hostname', s.hostname]);
      log(r.ok ? 'hostname ' + s.hostname + ' (takes full effect after the next reboot)' : 'could not set hostname: ' + r.out);
    } else log('hostname "' + s.hostname + '": lower-case letters, digits and dashes only');
  }
  if (s.timezone) {
    const r = sh('timedatectl', ['set-timezone', s.timezone]);
    log(r.ok ? 'time zone ' + s.timezone : 'could not set time zone ' + s.timezone + ': ' + r.out);
  }
  if (s.wifiSsid) {
    const name = 'rpi-alert-wifi';
    sh('nmcli', ['connection', 'delete', name]);
    const args = ['connection', 'add', 'type', 'wifi', 'con-name', name, 'ifname', 'wlan0', 'ssid', s.wifiSsid, 'connection.autoconnect', 'yes'];
    if (s.wifiPassword) args.push('wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', s.wifiPassword);
    const r = sh('nmcli', args);
    if (r.ok) { sh('nmcli', ['radio', 'wifi', 'on']); sh('nmcli', ['connection', 'up', name]); }
    log(r.ok ? 'Wi-Fi network "' + s.wifiSsid + '" added (joins when in range)' : 'could not add Wi-Fi "' + s.wifiSsid + '": ' + r.out);
  }
  if (s.ssh) {
    const r = s.ssh === 'on' ? sh('systemctl', ['enable', '--now', 'ssh']) : sh('systemctl', ['disable', '--now', 'ssh']);
    log(r.ok ? 'SSH ' + s.ssh : 'could not turn SSH ' + s.ssh + ': ' + r.out);
  }
}

function redactText(text) {
  return String(text).split(/\r?\n/).map(l => {
    const m = /^(\s*)([A-Za-z][\w.-]*)(\s*[=:]\s*)(.*)$/.exec(l);
    if (m && SECRET.has(m[2].toLowerCase().replace(/-/g, '_')) && m[4].trim()) return m[1] + m[2] + m[3] + '(applied — removed from the card)';
    return l;
  }).join('\n');
}

function main(args) {
  let file = args && args[0];
  if (!file) {
    for (const d of BOOT_DIRS) for (const n of NAMES) { const f = path.join(d, n); if (!file && fs.existsSync(f)) file = f; }
  }
  if (!file) { console.log('no rpi-alert.conf on the boot partition — nothing to apply'); return; }
  const dir = path.dirname(file);
  const logLines = [];
  const log = (s) => { logLines.push(s); console.log(s); };
  log('— ' + new Date().toISOString() + ' applying ' + file);
  const text = fs.readFileSync(file, 'utf8');
  const { patch, system, notes } = toPatch(parse(text));
  notes.forEach(n => log('note: ' + n));
  const cfg = new Config().load();
  if (cfg.loadError) log('note: ' + cfg.loadError);
  const r = cfg.update(patch);
  if (r.ok) log(r.changed.length ? 'settings changed: ' + r.changed.join(', ').replace('web.passwordHash', 'web password') : 'settings: nothing new');
  else {
    log('settings NOT applied: ' + r.errors.join('; '));
    // Apply what is valid, one top-level section at a time.
    for (const [k, v] of Object.entries(patch)) {
      const one = cfg.update({ [k]: v });
      log('  ' + k + ': ' + (one.ok ? 'applied' : one.errors.join('; ')));
    }
  }
  try { cfg.save(); } catch (e) { log('could not write the settings: ' + e.message); }
  // The agent's own user owns its settings file.
  sh('chown', ['rpi-alert:rpi-alert', cfg.file]);
  applySystem(system, log);
  try {
    fs.writeFileSync(path.join(dir, 'rpi-alert.conf.applied'), '# Applied ' + new Date().toISOString() + ' — see rpi-alert-boot.log\n' + redactText(text));
    fs.unlinkSync(file);
  } catch (e) { log('could not rename ' + file + ': ' + e.message); }
  try { fs.appendFileSync(path.join(dir, 'rpi-alert-boot.log'), logLines.join('\r\n') + '\r\n'); } catch (_) {}
}

module.exports = { parse, toPatch, redactText, main };
