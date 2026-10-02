'use strict';
// The decoders, exactly as MegaNet's website runs them.
//
// agent/vendor/meganet/ holds verbatim copies of three files from
// cdomotor-g/MegaNet (see vendor/meganet/SOURCE for the commit). Nothing here
// re-implements a decoder: a frame the Pi decodes is decoded by the same code a
// browser on floodwarning.net runs, so the two cannot disagree about a reading.
//
//   alert-dsp.js   the off-air ALERT decoder (RTL-SDR): exports under Node.
//   quansheng.js   the ALERT receiver firmware's serial codec: exports under Node.
//   alert2.js      the ERT-A2 / ALERT2 parser. A classic browser script with no
//                  module.exports, whose IIFE "declares and calls nothing" at
//                  load, so it is run here in its own V8 context and the
//                  Alert2 object it builds is lifted out. Only its pure parsing
//                  functions are used (parseAscii, parseBinBytes, hexStream,
//                  decodeRecord); the rest of it is the website's tab UI.
//   serial-gps.js  the GPS card; its NMEA `parse` is pure and lifted out the
//                  same way.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VENDOR = path.join(__dirname, '..', 'vendor', 'meganet');

const AlertDsp = require(path.join(VENDOR, 'alert-dsp.js'));
const Quansheng = require(path.join(VENDOR, 'quansheng.js'));

// Run a classic browser script in a context of its own and hand back the
// top-level const it declares. The scripts declare and call nothing at load;
// TextDecoder is the one browser global any of them touches (only inside
// functions), so it is lent.
function lift(file, name, needs) {
  const src = fs.readFileSync(path.join(VENDOR, file), 'utf8');
  const sandbox = { console, TextDecoder };
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;globalThis.__lifted = ' + name + ';', sandbox, { filename: file });
  const mod = sandbox.__lifted;
  for (const fn of needs) {
    if (!mod || typeof mod[fn] !== 'function') throw new Error(file + ' no longer exports ' + fn + ' — re-check the vendored copy');
  }
  return mod;
}

const Alert2 = lift('alert2.js', 'Alert2', ['parseAscii', 'parseBinBytes', 'hexStream', 'decodeRecord']);
const Nmea = lift('serial-gps.js', 'SerialGps', ['parse']);

module.exports = { AlertDsp, Quansheng, Alert2, Nmea };
