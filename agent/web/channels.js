'use strict';
// A stick's channels, as people write them and back: "151.525, 151.95, 152.4 EIF".
//
// One RTL-SDR stick hands over a slice of the band up to about two megahertz
// wide, and the agent decodes every ALERT channel in that slice at once, each
// one a receiver of its own (lib/devices/sdr.js). Its channels are written as
// a list of frequencies in MHz, with commas or spaces between them. A channel
// sent in another frame format from the stick's own has that format after it:
//
//   151.525, 151.95, 152.4 EIF
//
// Formats: ABF (ALERT Binary), EIF (Enhanced iFLOWS), ASCII. Never "iFLOWS"
// alone: NSW's network is called iFLOWS and sends ALERT Binary (alert-dsp.js
// explains). A frequency is MHz up to 2000 and Hz from 100000 up, as MegaNet's
// SDR Pi reads them; one written with a decimal comma (151,5) is one
// frequency; "none" is the empty list.
//
// Loaded by web/index.html as the global Channels, and with require() by the
// command line and the boot-partition file (lib/bootconf.js).
//
//   Channels.parse(text)        → { channels: [{ freqHz, format? }], blank, error }
//   Channels.text(list, format) → '151.525, 152.4 EIF' (a format only where it differs from format)
//   Channels.mhz(hz)            → '151.525' (three decimals, more where the frequency has them)

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Channels = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const SHORT = { BINARY: 'ABF', ENHANCED_IFLOWS: 'EIF', ASCII: 'ASCII' };
  const FORMAT = { abf: 'BINARY', binary: 'BINARY', alert_binary: 'BINARY',
    eif: 'ENHANCED_IFLOWS', enhanced: 'ENHANCED_IFLOWS', enhanced_iflows: 'ENHANCED_IFLOWS',
    ascii: 'ASCII', asc: 'ASCII', alert_ascii: 'ASCII' };
  const MIN_HZ = 24e6, MAX_HZ = 1766e6;

  function mhz(hz) {
    let s = (hz / 1e6).toFixed(6);
    while (/\.\d{4,}$/.test(s) && s.endsWith('0')) s = s.slice(0, -1);
    return s;
  }

  // A format as typed → the settings' own name, or undefined.
  function formatOf(word) {
    return FORMAT[String(word || '').trim().toLowerCase().replace(/[\s-]+/g, '_')];
  }

  function freqOf(token) {
    const m = /^(\d+(?:\.\d*)?|\.\d+)(mhz|m|khz|k|hz)?$/i.exec(token);
    if (!m) return null;
    const v = Number(m[1]), u = (m[2] || '').toLowerCase();
    if (u === 'mhz' || u === 'm') return Math.round(v * 1e6);
    if (u === 'khz' || u === 'k') return Math.round(v * 1e3);
    if (u === 'hz') return Math.round(v);
    if (v <= 2000) return Math.round(v * 1e6);
    if (v >= 100000) return Math.round(v);
    return NaN;
  }

  function parse(text) {
    let s = String(text == null ? '' : text).trim();
    if (!s) return { channels: [], blank: true, error: null };
    if (/^(none|no|off|-)$/i.test(s)) return { channels: [], blank: false, error: null };
    // One number with a decimal comma (151,525) is one frequency, not two.
    if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.');
    const words = s.replace(/enhanced[\s_-]+iflows/gi, 'eif').replace(/alert[\s_-]+(binary|ascii)/gi, '$1')
      .split(/[\s,;/]+/).filter(Boolean);
    const out = [];
    for (const w of words) {
      if (/^mhz$/i.test(w)) continue;
      const f = formatOf(w);
      if (f) {
        if (!out.length) return { channels: [], blank: false, error: 'a format goes after its frequency, e.g. 152.4 EIF' };
        out[out.length - 1].format = f;
        continue;
      }
      const hz = freqOf(w);
      if (hz === null) return { channels: [], blank: false, error: '"' + w + '" is not a frequency or a format (ABF, EIF, ASCII)' };
      if (!(hz >= MIN_HZ && hz <= MAX_HZ)) return { channels: [], blank: false, error: w + ': a frequency of 24–1766 MHz' };
      out.push({ freqHz: hz });
    }
    return { channels: out, blank: false, error: null };
  }

  function text(list, format) {
    return (list || []).map(c => mhz(c.freqHz) + (c.format && c.format !== format ? ' ' + SHORT[c.format] : '')).join(', ');
  }

  return { parse, text, mhz, formatOf, SHORT };
}));
