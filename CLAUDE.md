# Instructions for Claude Code

## Atlas — this repo on the map of all the repos
- This repo is **`rpi-alert`** on the Atlas (<https://cdomotor-g.github.io/atlas/>). How to work with the map — `atlas.json`, the repositories that rely on this one, asks, pins, status and blockers — is in the shared instructions (`shared/on-the-atlas.md` in the Atlas).
- The vendored decoders are the link that matters most: `agent/vendor/meganet/SOURCE` is the pin. `agent/scripts/sync-meganet.sh` moves it; the drift issue closes itself on the next daily check.

<!-- shared:start · written by tools/shared.mjs in cdomotor-g/atlas; the rules themselves live in its shared/ folder -->
## Shared instructions — loaded from the Atlas
The rules every one of my repositories shares live in one file in the Atlas: how to end a run (the run summary), pushing to `main`, plain words, private data, who clears what, and issue titles — <https://github.com/cdomotor-g/atlas/blob/main/shared/instructions.md>. This repository is on the Atlas map, so <https://github.com/cdomotor-g/atlas/blob/main/shared/on-the-atlas.md> holds as well.
`.claude/settings.json` loads them when a session starts. If they are not in front of you, fetch them before you reply (`curl -fsS https://raw.githubusercontent.com/cdomotor-g/atlas/main/shared/instructions.md`, and the same for `on-the-atlas.md`) and follow them. Where this file says something different, this file wins.
<!-- shared:end -->

## Releases — cut them by default (until v1.0.0)
- When a piece of work bumps `agent/package.json`'s version, cut the release in the same piece of work, once it is on `main`. Don't ask first. A Pi's update check, Flood-Net's Base Stations tab and *Install new releases automatically* only ever see releases, so a version left on `main` reaches no Pi.
- Cut it by starting `build-image.yml` with a release tag: `gh workflow run build-image.yml --ref main -f arch=both -f release_tag=v<version>`. A cloud session's proxy refuses pushing a tag and the releases API, but it lets a workflow be started, and the workflow makes the tag and the release itself. (`git tag v<version> && git push origin v<version>` does the same from anywhere that may push tags.)
- That run builds both images, signs `rpi-alert-<tag>-src.tar.gz` with the `RELEASE_SIGNING_KEY` secret ([docs/release-signing.md](docs/release-signing.md)) and publishes the GitHub release, about 30–60 minutes in all. Check it finished, and that the release carries the tarball and its `.sig` (`gh api repos/cdomotor-g/RPi_ALERT/releases/latest --jq '.tag_name, [.assets[].name]'`). If it failed, fix it and start it again, or say so in the run summary.
- Bump the version for anything a Pi would notice: a feature or setting is a minor (0.16.0 → 0.17.0), a fix a patch. Run the whole suite (`cd agent && npm test`) before tagging.
- Updates roll back on their own (`rpi-alert-update` puts the previous version back if the new one doesn't answer within two minutes), and new behaviour ships behind a setting that defaults to what was there before — the way 0.16's decoder setting defaults to *Full*.
- This holds until v1.0.0. From then, ask the owner before a release.
