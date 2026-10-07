#!/usr/bin/env node
'use strict';
// Sign a release tarball with the Ed25519 release private key. Run in CI by
// build-image.yml, never on a Pi (security appraisal M-1).
//
//   node sign-release.js <private-key.pem> <data-file>   ->  writes <data-file>.sig
//
// The private key comes from the RELEASE_SIGNING_KEY Actions secret; see
// docs/release-signing.md for generating it and pinning the public half.

const crypto = require('node:crypto');
const fs = require('node:fs');

const [keyPath, dataPath] = process.argv.slice(2);
if (!keyPath || !dataPath) {
  process.stderr.write('usage: sign-release.js <private-key.pem> <data-file>\n');
  process.exit(2);
}

const key = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
if (key.asymmetricKeyType !== 'ed25519') {
  process.stderr.write('the release key must be Ed25519\n');
  process.exit(1);
}
const sig = crypto.sign(null, fs.readFileSync(dataPath), key);
fs.writeFileSync(dataPath + '.sig', sig);
process.stdout.write('signed ' + dataPath + ' -> ' + dataPath + '.sig (' + sig.length + ' bytes)\n');
