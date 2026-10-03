'use strict';
// The "set up a base station" page: which image, how to write it, and the
// card's rpi-alert.conf — written straight onto the SD card's boot partition
// where the browser allows it (Chrome and Edge: the File System Access API),
// downloaded where it does not.

const $ = (s) => document.querySelector(s);
const REPO_URL = new URL('os_list.json', location.href).href;
const PI = {
  pi5: { arch: 'arm64', note: 'Fastest choice: the RTL-SDR decoder has CPU to spare and the screen dashboard is smooth. <b>No 3.5 mm audio jack</b> — chirps play over HDMI or a USB sound card. Use the official 27 W (5 V 5 A) supply.' },
  pi4: { arch: 'arm64', note: 'The recommended base station: plenty for the RTL-SDR decoder, the screen dashboard, and the audio jack for the chirps. Use the official 15 W (5 V 3 A) supply — a weak supply makes USB receivers drop out.' },
  pi3: { arch: 'arm64', note: 'Works well for radios, ERT-A2s and an RTL-SDR (if the decoder ever falls behind, choose 240 ksps under Settings → RTL-SDR). Audio jack for the chirps. 1 GB is just enough for the screen dashboard.' },
  z2w: { arch: 'arm64', note: '512 MB of RAM: the full-screen dashboard is left off (the web page and console still work). Fine for a Quansheng radio or ERT-A2; an RTL-SDR runs at 240 ksps. No audio jack (use a USB sound card); Wi-Fi only unless you add a USB Ethernet adapter.' },
  old: { arch: 'armhf', note: 'The 32-bit image. These Pis are too slow for the RTL-SDR decoder; use a Quansheng radio or an ERT-A2. No screen dashboard (text console only).' },
};

let release = null;

async function loadRelease() {
  try {
    const r = await fetch('os_list.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    release = j.os_list || [];
  } catch (_) { release = []; }
  const any = release[0];
  $('#release-line').textContent = any ? 'Latest image: ' + any.name.replace(/ \(.*/, '') + ' ' + (any.url.match(/rpi-alert-([\d.]+)-/) || [, ''])[1] + ', built ' + any.release_date + '.'
    : 'No image has been released yet — the "Already running Raspberry Pi OS?" route below works today.';
  showPi();
}

function showPi() {
  const pi = (document.querySelector('input[name=pi]:checked') || {}).value || 'pi4';
  const info = PI[pi];
  $('#pi-note').innerHTML = info.note;
  const img = (release || []).find(e => (e.url || '').includes('-' + info.arch + '.'));
  $('#dl-box').innerHTML = img
    ? '<a href="' + img.url + '"><b>' + esc(img.url.split('/').pop()) + '</b></a> (' + Math.round(img.image_download_size / 1048576) + ' MB)<br><span class="small">SHA-256 of the download: <code>' + esc(img.image_download_sha256) + '</code></span>'
    : (release ? 'No ' + (info.arch === 'arm64' ? '64-bit' : '32-bit') + ' image has been released yet.' : 'Loading…');
}

function imagerCommand() {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return '"C:\\Program Files (x86)\\Raspberry Pi Imager\\rpi-imager.exe" --repo ' + REPO_URL;
  if (/Mac OS/.test(ua)) return '"/Applications/Raspberry Pi Imager.app/Contents/MacOS/rpi-imager" --repo ' + REPO_URL;
  return 'rpi-imager --repo ' + REPO_URL;
}

function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ── the file ────────────────────────────────────────────────────────────────

let stations = null, pickedStation = null;

function confText() {
  const f = $('#conf');
  const v = (n) => (f.elements[n].value || '').trim();
  const lines = ['# RPi ALERT settings — written by https://cdomotor-g.github.io/RPi_ALERT/ on ' + new Date().toISOString().slice(0, 10),
    '# Applied at the next boot, then renamed rpi-alert.conf.applied with the secrets removed.', ''];
  const put = (k, val) => { if (val !== '' && val != null) lines.push(k + ' = ' + val); };
  put('token', v('token'));
  // With no token, the Pi asks MegaNet for one at boot (MegaNet 0048); an
  // administrator approves the request on the Admin tab.
  if (!v('token') && f.elements.request_token.checked) put('request_token', 'yes');
  put('name', v('name'));
  if (pickedStation && v('station') === pickedStation.name) {
    put('location_station', pickedStation.id); put('location_station_name', pickedStation.name);
    put('latitude', pickedStation.lat); put('longitude', pickedStation.lon);
  } else { put('latitude', v('latitude')); put('longitude', v('longitude')); }
  put('use_gps', f.elements.use_gps.checked ? 'yes' : 'no');
  if (v('gps_bluetooth')) { put('gps_bluetooth', v('gps_bluetooth').toUpperCase().replace(/-/g, ':')); put('gps_bluetooth_pin', v('gps_bluetooth_pin')); }
  put('sdr_frequency_mhz', v('sdr_frequency_mhz'));
  put('sdr_format', v('sdr_format'));
  put('sdr_gain_db', v('sdr_gain_db') || 'auto');
  put('audio', v('audio'));
  put('kiosk', v('kiosk'));
  put('web_password', v('web_password'));
  if (v('wifi_ssid')) { put('wifi_country', v('wifi_country').toUpperCase()); put('wifi_ssid', v('wifi_ssid')); put('wifi_password', v('wifi_password')); }
  put('hostname', v('hostname').toLowerCase());
  put('timezone', v('timezone'));
  put('ssh', f.elements.ssh.checked ? 'on' : 'off');
  return lines.join('\r\n') + '\r\n';
}

function problems() {
  const f = $('#conf'), out = [];
  const lat = f.elements.latitude.value.trim(), lon = f.elements.longitude.value.trim();
  if ((lat || lon) && !(Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180 && lat && lon)) out.push('latitude and longitude must both be numbers');
  const t = f.elements.token.value.trim();
  if (t && !/^mgn_/.test(t)) out.push('an ingest token starts with mgn_');
  const h = f.elements.hostname.value.trim();
  if (h && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(h)) out.push('a hostname is lower-case letters, digits and dashes');
  const pw = f.elements.wifi_password.value;
  if (pw && (pw.length < 8 || pw.length > 63)) out.push('a Wi-Fi password is 8–63 characters');
  const bt = f.elements.gps_bluetooth.value.trim();
  if (bt && !/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(bt)) out.push('a Bluetooth address looks like 58:A8:39:01:93:61');
  return out;
}

function preview() {
  const red = confText().replace(/^(token|web_password|wifi_password|gps_bluetooth_pin) = .+$/gm, (m, k) => k + ' = ••••••••');
  $('#preview').textContent = red;
}

function status(msg, ok) { const s = $('#write-status'); s.textContent = msg; s.className = 'small ' + (ok ? 'ok' : 'bad'); }

async function write() {
  const bad = problems();
  if (bad.length) return status('Check: ' + bad.join('; ') + '.', false);
  if (!window.showDirectoryPicker) { download(); status('This browser cannot write to the card directly — the file was downloaded instead: copy it onto the card\'s bootfs drive.', true); return; }
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'rpi-bootfs', mode: 'readwrite', startIn: 'desktop' }); }
  catch (e) {
    // Cancelled, or a browser (an embedded one) that cannot show the picker: say so —
    // a silent page reads as "written" when nothing was.
    status(e && e.name === 'AbortError'
      ? 'Nothing written — no drive was chosen. Press Write again and pick the bootfs drive, or use Download.'
      : 'Could not open a drive: ' + (e && e.message) + ' — use Download instead.', false);
    return;
  }
  // Make sure it is a Raspberry Pi boot partition, not someone's Documents.
  let isBoot = false;
  for (const n of ['config.txt', 'cmdline.txt']) { try { await dir.getFileHandle(n); isBoot = true; } catch (_) {} }
  if (!isBoot && !confirm('"' + dir.name + '" does not look like a Raspberry Pi boot partition (no config.txt in it). Write rpi-alert.conf there anyway?')) return;
  try {
    const fh = await dir.getFileHandle('rpi-alert.conf', { create: true });
    const w = await fh.createWritable();
    await w.write(confText());
    await w.close();
    status('Written to ' + dir.name + '/rpi-alert.conf. Eject the card safely and put it in the Pi.', true);
  } catch (e) { status('Could not write: ' + e.message + ' — use Download instead.', false); }
}

function download() {
  const bad = problems();
  if (bad.length) return status('Check: ' + bad.join('; ') + '.', false);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([confText()], { type: 'text/plain' }));
  a.download = 'rpi-alert.conf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  status('Downloaded. Copy rpi-alert.conf onto the card\'s bootfs drive (next to config.txt).', true);
}

async function loadStations() {
  if (stations) return;
  stations = [];
  for (const u of ['https://cdomotor-g.github.io/MegaNet/stations.json', 'https://floodwarning.net/stations.json']) {
    try {
      $('#station-note').textContent = 'Loading MegaNet\'s station list…';
      const j = await (await fetch(u)).json();
      stations = (j.stations || []).filter(s => s.lat != null).map(s => ({ id: s.id, name: s.name, number: s.station_number || '', lat: s.lat, lon: s.lon }));
      $('#station-note').textContent = stations.length + ' stations — type a name or number.';
      return;
    } catch (_) {}
  }
  $('#station-note').textContent = 'Could not load the station list; type the coordinates instead.';
}

function onStation() {
  const q = $('#conf').elements.station.value.trim().toLowerCase();
  if (q.length < 2 || !stations) return;
  const hits = stations.filter(s => s.name.toLowerCase().includes(q) || s.number === q || s.id === q).slice(0, 12);
  $('#stations').innerHTML = hits.map(s => '<option value="' + esc(s.name) + '">' + esc(s.number + ' · ' + s.id) + '</option>').join('');
  const exact = stations.find(s => s.name.toLowerCase() === q) || (hits.length === 1 ? hits[0] : null);
  pickedStation = exact;
  if (exact) {
    $('#station-note').textContent = exact.name + ' — ' + exact.lat + ', ' + exact.lon;
    $('#conf').elements.latitude.value = exact.lat; $('#conf').elements.longitude.value = exact.lon;
  }
}

document.querySelectorAll('input[name=pi]').forEach(r => r.addEventListener('change', showPi));
document.querySelectorAll('pre.copy').forEach(p => p.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(p.textContent); p.classList.add('copied'); setTimeout(() => p.classList.remove('copied'), 1500); } catch (_) {}
}));
$('#imager-cmd').textContent = imagerCommand();
$('#conf').addEventListener('input', preview);
$('#conf').elements.station.addEventListener('focus', loadStations);
$('#conf').elements.station.addEventListener('input', onStation);
$('#here').addEventListener('click', () => {
  if (!navigator.geolocation) return status('This browser cannot give a location.', false);
  navigator.geolocation.getCurrentPosition(p => {
    $('#conf').elements.latitude.value = p.coords.latitude.toFixed(5);
    $('#conf').elements.longitude.value = p.coords.longitude.toFixed(5);
    preview();
    status('Location filled in (±' + Math.round(p.coords.accuracy) + ' m) — this computer\'s, so check it is where the Pi will be.', true);
  }, e => status('No location: ' + e.message, false), { timeout: 15000 });
});
$('#write').addEventListener('click', write);
$('#download').addEventListener('click', download);
$('#write-hint').textContent = window.showDirectoryPicker
  ? 'Write to the SD card asks you to choose a drive: pick the one called bootfs (it holds config.txt).'
  : 'This browser cannot write to a drive itself (Chrome and Edge can), so it downloads the file for you to copy onto the bootfs drive.';
preview();
loadRelease();
