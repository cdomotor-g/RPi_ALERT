'use strict';
// rpi-alert-update takes the latest release only when its tag is a version.
// A tag that is not one would not be fetched as a signed release, so it is no
// update at all — never the unsigned source archive on the automatic routes.
// curl is stood in for, so nothing here touches the network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'os', 'libexec', 'rpi-alert-update');

function check(tag) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-upd-'));
  fs.writeFileSync(path.join(bin, 'curl'),
    `#!/bin/sh\ncase "$*" in *api.github.com*) printf '{"tag_name": "%s"}\\n' "${tag}" ;; *) exit 22 ;; esac\n`, { mode: 0o755 });
  const r = spawnSync('bash', [SCRIPT, '--check'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return r.stdout + r.stderr;
}

test('a version tag is a release', () => {
  assert.match(check('v0.99.0'), /Release 0\.99\.0 is available/);
  assert.match(check('v1.2.3-rc.1'), /Release 1\.2\.3-rc\.1 is available/);
});

test('a tag that is not a version is no release, so nothing is installed', () => {
  for (const tag of ['vnext', 'next', 'v1', 'vmain', 'v0.99.0;x', 'v0.99.0/../main']) {
    const out = check(tag);
    assert.doesNotMatch(out, /is available/, `${tag}: ${out}`);
    assert.match(out, /No published release found/, tag);
  }
});
