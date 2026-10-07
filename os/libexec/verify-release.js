#!/usr/bin/env node
'use strict';
// Verify a detached Ed25519 signature over a downloaded release tarball, against
// the public key pinned in the image (os/release-signing-key.pem). rpi-alert-update
// runs this before it installs a release, so a tree that is not signed by the
// holder of the release key is never run as root (security appraisal M-1).
//
//   node verify-release.js <public-key.pem> <signature-file> <data-file>
//
// Exit 0 — the signature is valid for this data under the pinned key.
// Exit 1 — the signature does not verify (tampered, wrong key, truncated).
// Exit 2 — no usable key is pinned (the shipped placeholder), so the caller can
//          tell "signing not set up yet" apart from "bad signature".

const crypto = require('node:crypto');
const fs = require('node:fs');

const [pubPath, sigPath, dataPath] = process.argv.slice(2);
if (!pubPath || !sigPath || !dataPath) {
  process.stderr.write('usage: verify-release.js <public-key.pem> <signature-file> <data-file>\n');
  process.exit(2);
}

let pub;
try {
  const pem = fs.readFileSync(pubPath, 'utf8');
  if (!pem.includes('BEGIN PUBLIC KEY')) process.exit(2);   // placeholder — not configured
  pub = crypto.createPublicKey(pem);
  if (pub.asymmetricKeyType !== 'ed25519') { process.stderr.write('pinned key is not Ed25519\n'); process.exit(2); }
} catch (e) {
  process.stderr.write('cannot read the pinned release key: ' + e.message + '\n');
  process.exit(2);
}

try {
  const ok = crypto.verify(null, fs.readFileSync(dataPath), pub, fs.readFileSync(sigPath));
  process.exit(ok ? 0 : 1);
} catch (e) {
  process.stderr.write('verification error: ' + e.message + '\n');
  process.exit(1);
}
