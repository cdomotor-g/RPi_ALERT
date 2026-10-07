# Release signing — so a release is root on the fleet only if *you* signed it

`rpi-alert-update` installs a release by downloading it and running its
`install.sh` as root. Without a signature check, anyone who can publish a
release on this repository — or anyone who could tamper with what GitHub serves
— would run code as root on every Pi that updates. Signing closes that: each
release carries an Ed25519 signature, and the updater refuses a release it
cannot verify against a public key pinned in the image.

This is the fix for finding **M-1** of the 2026-10 security appraisal.

## How it fits together

- **The key.** An Ed25519 key pair. You hold the private half; the public half
  is committed to [`os/release-signing-key.pem`](../os/release-signing-key.pem)
  and baked into every image.
- **Signing (CI).** `build-image.yml` tars the installable tree
  (`agent/` + `os/`) into `rpi-alert-<tag>-src.tar.gz` and signs it with
  [`os/libexec/sign-release.js`](../os/libexec/sign-release.js), using the
  private key from the `RELEASE_SIGNING_KEY` Actions secret. Both the tarball
  and its `.sig` are attached to the GitHub release.
- **Verifying (the Pi).** `rpi-alert-update` downloads that tarball and its
  `.sig`, runs [`os/libexec/verify-release.js`](../os/libexec/verify-release.js)
  against the pinned public key, and only extracts and installs on success.
  Verification is pure Node (`crypto`), so it needs nothing the agent does not
  already rely on.

Both halves use Node's `crypto`, so there is no dependency on `ssh-keygen`,
`openssl`, `minisign` or any other tool being present.

## Until you set it up: nothing changes

The committed `os/release-signing-key.pem` is a **placeholder** — it contains no
key. While that is so, the updater installs releases exactly as it always has,
unverified, and prints a one-line note. So shipping the signing code changes no
behaviour until you opt in by pinning a real key.

## One-time setup

1. **Generate the key pair** (anywhere with Node; the private key never leaves
   your control):

   ```sh
   node -e '
     const c=require("crypto"),fs=require("fs");
     const {publicKey,privateKey}=c.generateKeyPairSync("ed25519");
     fs.writeFileSync("rpi-alert-release.pem", privateKey.export({type:"pkcs8",format:"pem"}));
     fs.writeFileSync("rpi-alert-release.pub.pem", publicKey.export({type:"spki",format:"pem"}));
     console.log("wrote rpi-alert-release.pem (PRIVATE — keep safe) and rpi-alert-release.pub.pem (public)");
   '
   ```

   Keep `rpi-alert-release.pem` somewhere durable and private (a password
   manager, a hardware-backed store). If you lose it you can make a new one and
   re-pin; if it leaks, anyone can sign a release, so treat it like the fleet's
   root key — because it is.

2. **Add the private key as an Actions secret.** Repo → Settings → Secrets and
   variables → Actions → New repository secret, name `RELEASE_SIGNING_KEY`,
   value the full contents of `rpi-alert-release.pem` (the
   `-----BEGIN PRIVATE KEY-----` block). Consider putting it in a protected
   Environment that only release runs can read.

3. **Pin the public key.** Replace the contents of
   `os/release-signing-key.pem` with `rpi-alert-release.pub.pem` (the
   `-----BEGIN PUBLIC KEY-----` block) and push to `main`.

## Rollout order (so nothing is bricked)

Verification only becomes strict once a Pi is running a build that has your
public key pinned. Do it in this order:

1. Land the signing code (this change) on `main`.
2. Do the one-time setup above (secret + pinned public key).
3. Cut the next release. That release is **signed**, and the pinned public key
   travels in its image/tarball. Pis still on the old updater install it the old
   way (unverified) — this is the one trust-on-first-use step.
4. From then on, every Pi running that release (or a newer one) verifies each
   future release before installing it. A release cut without the secret, or
   tampered with, is refused — the Pi keeps the version it has.

Do **not** pin the public key in the image without also setting the
`RELEASE_SIGNING_KEY` secret: a pinned key plus unsigned releases means every
such Pi refuses every update until a signed release appears. That is the
intended safety behaviour, but it will look like updates have stopped.

## Checking a release by hand

```sh
tag=v0.10.0
curl -fsSLO https://github.com/cdomotor-g/RPi_ALERT/releases/download/$tag/rpi-alert-$tag-src.tar.gz
curl -fsSLO https://github.com/cdomotor-g/RPi_ALERT/releases/download/$tag/rpi-alert-$tag-src.tar.gz.sig
node os/libexec/verify-release.js os/release-signing-key.pem \
  rpi-alert-$tag-src.tar.gz.sig rpi-alert-$tag-src.tar.gz && echo "verified"
```

## What this does and does not cover

- **Covered:** the normal update path — the nightly `--if-newer` timer, the
  dashboard's *Install update*, and MegaNet's *install update* request all go
  through `rpi-alert-update`, which verifies.
- **Not covered:** `rpi-alert-update --ref <branch>` and the
  `bootstrap.sh | sudo bash` one-liner install a branch from the source archive,
  unverified, by design — they are the developer/testing paths. Treat push
  access to `main` accordingly, and prefer branch protection on `main` and on
  `v*` tags so only intended commits are ever released.
- The base Raspberry Pi OS image and the `rtl-sdr-blog` clone pulled in at build
  time are separate supply-chain inputs; see the appraisal's F7/L-7.
