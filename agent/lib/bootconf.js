'use strict';
// rpi-alert.conf on the SD card's boot partition — the FAT one every computer
// can open — applied at boot, before the agent starts.
//
// It is how a base station is set up without ever plugging a screen into it:
// flash the card, drop this file next to config.txt (the flasher page writes
// it for you), put the card in the Pi. Plain "key = value" lines, # comments:
//
//   token = mgn_…                     MegaNet ingest token
//   request_token = yes               …or none: ask MegaNet for one at boot, and keep asking
//                                     until an administrator approves it on the Admin tab
//   name = Bench Pi                   what MegaNet calls this base station
//   latitude = -27.4698               where it is (approximate unless a GPS says otherwise)
//   longitude = 153.0251
//   location_station = loudoun_br_al  …or the station it sits at (with its latitude/longitude)
//   use_gps = yes                     a USB GPS fix, when there is one, wins
//   sdr_frequency_mhz = 151.5         or several for one stick to hear at once: 151.5, 151.525, 152.4
//   sdr_more_channels_mhz = none      just the more channels (152.4 eif: a format after one that differs)
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
//   auto_update = on                  install new RPi ALERT releases nightly (off by default)
//   update = now                      install the latest release once, at this boot
//   gps_bluetooth = 58:A8:39:01:93:61 a Bluetooth GPS (an Emlid Reach with its position output
//   gps_bluetooth_pin = 123456        set to Bluetooth, NMEA): paired, kept connected, and read
//                                     as /dev/rpi-alert-gps; gps_bluetooth = off removes it
//   remote_management = manage        what MegaNet's Base Stations tab may do: manage | report | off
//   ssh_key = ssh-ed25519 AAAA… name  a key that may log in as alert (one line each; the lines
//                                     on a card replace the ones before; ssh_key = none clears them)
//   ssh_github = name, name           GitHub accounts whose public keys may log in as alert
//   ssh_meganet_keys = yes            MegaNet's team keys may log in as alert
//   ssh_from = private                where GitHub and MegaNet keys work from: private | any
//   ssh_password_login = off          SSH password login: on | off (left as Imager set it if absent)
//   alert_password = …                a password for the alert account (the console; SSH too if
//                                     password login is on) — the way back in when nobody has a
//                                     key; removed from the card. alert_password = none removes it
//
// Once applied the file is renamed rpi-alert.conf.applied with the secrets
// blanked out, and what happened is appended to rpi-alert-boot.log beside it.
// To change something later, write a new rpi-alert.conf.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Config, hashPassword } = require('./config');
const Channels = require('../web/channels');

const BOOT_DIRS = ['/boot/firmware', '/boot'];
const NAMES = ['rpi-alert.conf', 'rpi-alert.txt', 'rpi-alert.conf.txt'];
const SECRET = new Set(['token', 'web_password', 'wifi_password', 'gps_bluetooth_pin', 'alert_password']);
// Keys a card may give more than once, each line one more value.
const MULTI = new Set(['ssh_key', 'ssh_authorized_key']);
const BT_GPS_PORT = '/dev/rpi-alert-gps';
const BT_GPS_CONF = process.env.RPI_ALERT_BTGPS_CONF || '/etc/rpi-alert/bluetooth-gps.conf';

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
    if (MULTI.has(key)) (out[key] = Array.isArray(out[key]) ? out[key] : []).push(v);
    else out[key] = v;
  });
  return out;
}

const yes = (v) => /^(1|y|yes|on|true|enable|enabled)$/i.test(String(v).trim());
const no = (v) => /^(0|n|no|off|false|disable|disabled)$/i.test(String(v).trim());

// key/values → { patch, system: {…}, notes: [] }
function toPatch(kv) {
  const patch = {}, system = {}, notes = [];
  let btGps = null, btPin = '', btChannel = null;
  const access = {};
  const set = (p, v) => { const ks = p.split('.'); let c = patch; ks.slice(0, -1).forEach(k => { c = c[k] = c[k] || {}; }); c[ks[ks.length - 1]] = v; };
  const n = (v) => { const x = Number(String(v).replace(',', '.')); return Number.isFinite(x) ? x : NaN; };
  for (const [k, v] of Object.entries(kv)) {
    switch (k) {
      case 'token': case 'meganet_token': case 'ingest_token': set('meganet.token', v.trim()); break;
      case 'request_token': case 'ask_for_token': set('meganet.autoRequest', yes(v)); break;
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
      // One frequency: the channel. Several: the first, and the more channels
      // the same stick hears at once (web/channels.js reads the list).
      case 'sdr_frequency_mhz': case 'frequency_mhz': {
        const p = Channels.parse(v);
        if (p.error || !p.channels.length) { notes.push(k + ': ' + (p.error || 'a frequency in MHz, e.g. 151.5') + ' — not changed'); break; }
        set('receivers.sdr.freqHz', p.channels[0].freqHz);
        if (p.channels[0].format) set('receivers.sdr.format', p.channels[0].format);
        if (p.channels.length > 1) set('receivers.sdr.moreChannels', p.channels.slice(1));
        break;
      }
      case 'sdr_more_channels_mhz': case 'sdr_channels_mhz': {
        const p = Channels.parse(v);
        if (p.error) notes.push(k + ': ' + p.error + ' — not changed'); else set('receivers.sdr.moreChannels', p.channels);
        break;
      }
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
      case 'auto_update': case 'auto_updates': system.autoUpdate = yes(v) ? 'on' : no(v) ? 'off' : null; break;
      case 'update': if (/^(now|yes|on|true|1)$/i.test(v.trim())) system.updateNow = true; else notes.push('update: expected now'); break;
      case 'gps_bluetooth': case 'bluetooth_gps': {
        const a = v.trim().toUpperCase().replace(/-/g, ':');
        if (no(v)) btGps = { off: true };
        else if (/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(a)) btGps = { address: a };
        else notes.push('gps_bluetooth: expected a Bluetooth address like 58:A8:39:01:93:61, or off');
        break;
      }
      case 'gps_bluetooth_pin': btPin = v.trim(); break;
      case 'remote_management': case 'remote': case 'meganet_management': {
        const m = no(v) ? 'off' : yes(v) ? 'manage' : String(v).trim().toLowerCase();
        if (['manage', 'report', 'off'].includes(m)) set('remote.mode', m); else notes.push('remote_management: manage, report or off');
        break;
      }
      case 'ssh_key': case 'ssh_authorized_key': {
        const lines = [].concat(v).map(x => String(x).trim()).filter(Boolean);
        access.keys = lines.some(x => no(x) || /^none$/i.test(x)) ? [] : lines;
        break;
      }
      case 'ssh_github': case 'ssh_github_users':
        access.github = no(v) || /^none$/i.test(v.trim()) ? [] : v.split(/[\s,;]+/).map(x => x.trim().replace(/^@/, '')).filter(Boolean);
        break;
      case 'ssh_meganet_keys': case 'ssh_team_keys': access.meganet = yes(v) ? 'on' : no(v) ? 'off' : (notes.push('ssh_meganet_keys: yes or no'), undefined); break;
      case 'ssh_from': {
        const f = String(v).trim().toLowerCase();
        if (f === 'private' || f === 'any') access.from = f; else notes.push('ssh_from: private or any');
        break;
      }
      case 'ssh_password_login': case 'ssh_passwords':
        access.password = yes(v) ? 'on' : no(v) ? 'off' : /^unchanged$/i.test(v.trim()) ? 'unchanged' : (notes.push('ssh_password_login: on or off'), undefined);
        break;
      case 'alert_password': access.alertPassword = no(v) || /^none$/i.test(v) ? '' : v; break;
      case 'gps_bluetooth_channel': {
        const c = Number(v.trim());
        if (Number.isInteger(c) && c >= 1 && c <= 30) btChannel = c; else notes.push('gps_bluetooth_channel: a number, 1–30');
        break;
      }
      default: notes.push(k.startsWith('_bad_') ? 'line ' + k.slice(5) + ' is not "key = value": ' + v : 'unknown setting "' + k + '" (ignored)');
    }
  }
  if (btGps && btGps.address) {
    if (btPin) btGps.pin = btPin;
    if (btChannel) btGps.channel = btChannel;
    // A GPS paired on purpose is there to say where this is (a mobile unit).
    if (!('use_gps' in kv)) set('location.useGps', true);
  }
  if (btGps) system.btGps = btGps;
  for (const k of Object.keys(access)) if (access[k] === undefined) delete access[k];
  if (Object.keys(access).length) system.access = access;
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
  if (s.btGps) applyBtGps(s.btGps, log);
  if (s.access) applyAccess(s.access, log);
  if (s.ssh) {
    const r = s.ssh === 'on' ? sh('systemctl', ['enable', '--now', 'ssh']) : sh('systemctl', ['disable', '--now', 'ssh']);
    log(r.ok ? 'SSH ' + s.ssh : 'could not turn SSH ' + s.ssh + ': ' + r.out);
  }
  if (s.autoUpdate) {
    const r = sh('systemctl', [s.autoUpdate === 'on' ? 'enable' : 'disable', '--now', 'rpi-alert-update-auto.timer']);
    log(r.ok ? 'automatic updates ' + s.autoUpdate : 'could not turn automatic updates ' + s.autoUpdate + ': ' + r.out);
  }
  if (s.updateNow) {
    // In the background: it waits for the network, and restarts the agent when done.
    const r = sh('systemctl', ['start', '--no-block', 'rpi-alert-update.service']);
    log(r.ok ? 'installing the latest release (see Settings → System on the web page)' : 'could not start the update: ' + r.out);
  }
}

// A Bluetooth GPS: the settings for rpi-alert-btgps, and Bluetooth and that
// service on (the image leaves Bluetooth off until something needs it).
function applyBtGps(b, log) {
  if (b.off) {
    sh('systemctl', ['disable', '--now', 'rpi-alert-btgps.service']);
    try { fs.unlinkSync(BT_GPS_CONF); } catch (_) {}
    log('Bluetooth GPS removed');
    return;
  }
  const text = '# Written from rpi-alert.conf at boot — see rpi-alert-btgps\naddress = ' + b.address + '\n' +
    (b.pin ? 'pin = ' + b.pin + '\n' : '') + (b.channel ? 'channel = ' + b.channel + '\n' : '');
  try { fs.writeFileSync(BT_GPS_CONF, text, { mode: 0o600 }); fs.chmodSync(BT_GPS_CONF, 0o600); }
  catch (e) { log('could not write ' + BT_GPS_CONF + ': ' + e.message); return; }
  sh('rfkill', ['unblock', 'bluetooth']);
  // hciuart brings up the Pi's own Bluetooth chip; not every board has it.
  sh('systemctl', ['enable', '--now', '--no-block', 'hciuart.service']);
  const r1 = sh('systemctl', ['enable', '--now', '--no-block', 'bluetooth.service']);
  const r2 = sh('systemctl', ['enable', '--no-block', 'rpi-alert-btgps.service']);
  sh('systemctl', ['restart', '--no-block', 'rpi-alert-btgps.service']);
  log(r1.ok && r2.ok ? 'Bluetooth GPS ' + b.address + ' — pairs and connects in the background, read as ' + BT_GPS_PORT
    : 'could not turn on the Bluetooth GPS: ' + [r1, r2].filter(r => !r.ok).map(r => r.out).join('; '));
}

// SSH access (lib/access.js): this runs as root, so the card may do what the
// web page and MegaNet may not — put keys on the list, and set the alert
// account's password. The lists fetched from GitHub and MegaNet are fetched
// in the background (rpi-alert-access.service), once the network is up.
function applyAccess(a, log) {
  const access = require('./access');
  const acct = access.ensureAccount();
  if (!acct.ok) { log('could not make the alert account: ' + acct.error); return; }
  if (acct.created) log('made the alert account (SSH keys only)');
  if (a.keys) {
    const r = access.replaceLocalKeys(a.keys);
    log('SSH keys for alert: ' + r.keys + ' from the card' + (r.errors.length ? ' (refused: ' + r.errors.join('; ') + ')' : ''));
  }
  const setp = (what, value, said) => {
    try { access.setPolicy(what, value); log(said); } catch (e) { log('SSH ' + what + ': ' + e.message); }
  };
  if (a.github) setp('github', a.github, a.github.length ? 'SSH keys of GitHub accounts ' + a.github.join(', ') + ' may log in as alert' : 'no GitHub accounts\' keys');
  if (a.meganet) setp('meganet', a.meganet, 'MegaNet\'s team SSH keys ' + (a.meganet === 'on' ? 'may log in as alert' : 'off'));
  if (a.from) setp('from', a.from, 'fetched SSH keys work from ' + (a.from === 'private' ? 'private networks only' : 'anywhere'));
  if (a.password) {
    setp('password', a.password, 'SSH password login ' + a.password);
    const d = access.applyDropin();
    if (!d.ok) log(d.error);
  }
  if (a.alertPassword !== undefined) {
    const r = access.setAccountPassword(a.alertPassword);
    log(r.ok ? (r.password ? 'the alert account has a password now (removed from the card)' : 'the alert account\'s password is removed: keys only') : 'could not set the alert account\'s password: ' + r.error);
  }
  // The list from what is kept now; then the fetching, once there is a network.
  access.sync({ fetch: false }).catch((e) => log('SSH keys: ' + e.message));
  sh('systemctl', ['start', '--no-block', 'rpi-alert-access.service']);
}

// The Bluetooth GPS's port in (or out of) the agent's extra ports, keeping the rest.
function withBtGpsPort(current, btGps) {
  const rest = (current || []).filter(p => p !== BT_GPS_PORT);
  return btGps && btGps.address ? rest.concat(BT_GPS_PORT) : rest;
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
  if (system.btGps) {
    patch.receivers = patch.receivers || {};
    patch.receivers.extraPorts = withBtGpsPort(cfg.get().receivers.extraPorts, system.btGps);
  }
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

module.exports = { parse, toPatch, redactText, withBtGpsPort, main, BT_GPS_PORT, MULTI };
