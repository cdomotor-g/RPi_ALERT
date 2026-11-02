# Instructions for Claude Code

## Atlas — this repo on the map of all the repos
- The owner keeps one map of every repository, how they depend on each other and where each is up to: **https://cdomotor-g.github.io/atlas/** (source: `cdomotor-g/atlas`). This repo is **`rpi-alert`** there and describes itself in **`atlas.json`** at its root (format: the Atlas's `schema/atlas.schema.json`; every field is explained there). The file is public: nothing private goes in it.
- **When you start**, look at this repo's panel on the Atlas, or `atlas.json`: what it takes from other repos (`consumes`), which repos rely on it (*Gives to* in the panel), anything *behind upstream*, and anything waiting on the owner.
- **Forward — you change something another repo relies on** (a path under one of this repo's `provides`, or one another repo's `consumes` entry watches; the Atlas's *Links* view lists them): in the same piece of work, tell each consumer. If that repo is attached to your session, make the matching change there too; otherwise open an issue in it titled `[Standalone] [<Model>/<Effort>] Upstream: <what changed> in <this repo>`, with the commit, what changed and what the consumer has to do. A breaking change always gets one. The consumer's own daily Atlas check flags the drift as well, but only your issue says why.
- **Back — this repo needs another to change**: open an issue there (attach the repo with `add_repo` if your session doesn't have it) and list it under `asks` in `atlas.json` with the issue reference. If you can't file it, list the ask without one so it shows on the map.
- **Catching up**: when you refresh something this repo copies or follows from another (a vendored copy, a generated table, a build, a citation), move that `consumes` entry's pin in the same commit — the file its `since` points at, or its `since` date. A drift issue the Atlas opened closes itself on the next check.
- **When you finish**: if where this repo is up to has changed — what's being done now, what's next, what's blocked (on the owner: `"on": "human"`) — update `status` in `atlas.json`, with today's date in `updated`. Add a `components` / `provides` / `consumes` entry when you add a part another repo uses, or start using another repo's. `.github/workflows/atlas.yml` checks the file on every push that changes it and once a day.
- **Blocked?** Record it in `status.blocked`: what is blocked, who it waits on (`on`: `human`, `agent`, or another repo's Atlas id), its `kind`, `since`, the tracking `issue`, what it `holds` up (issue refs, Atlas ids, short phrases) and the `options` you can see — the straight fix, plus any workaround, partial step or part an agent could take off the owner's plate — each with who could do it (`by`), rough `effort`, `model` for an agent option, and `recommended: true` on the one you'd pick. Remove the entry when it clears. The Atlas draws these on its map (lines to You, to Agents, or to the repo it waits on) and lists them, most-holding first, on its Blockers view.
- The vendored decoders are the link that matters most: `agent/vendor/meganet/SOURCE` is the pin. `agent/scripts/sync-meganet.sh` moves it; the drift issue closes itself on the next daily check.

## Run summary — mark where it starts
- When you finish a piece of work and write your closing report (what you did, what's left, what I need to do), start it with this marker so I can find it by scrolling — a horizontal rule, then a top-level heading with the run number:

  ```
  ---
  # 🏁 THIS RUN SUMMARY (Run 3)
  ```

- The run number counts the summaries in this chat: the first one is Run 1, and each later one is one more than the last marker already in the conversation. A new chat starts again at Run 1.
- Everything above the marker is working notes; everything below it is the report. Use the marker once per reply, only at the start of that closing report, and put nothing after the report but the report.
- Under it, use these bold labels in this order, leaving out any that would be empty: **What changed**, **Checks run**, **What you need to do**, **Open questions**.
- Short replies that are only an answer (no work done) don't need the marker and don't use up a run number.

## Releases — cut them by default (until v1.0.0)
- When a piece of work bumps `agent/package.json`'s version, cut the release in the same piece of work, once it is on `main`. Don't ask first. A Pi's update check, Flood-Net's Base Stations tab and *Install new releases automatically* only ever see releases, so a version left on `main` reaches no Pi.
- Cut it by starting `build-image.yml` with a release tag: `gh workflow run build-image.yml --ref main -f arch=both -f release_tag=v<version>`. A cloud session's proxy refuses pushing a tag and the releases API, but it lets a workflow be started, and the workflow makes the tag and the release itself. (`git tag v<version> && git push origin v<version>` does the same from anywhere that may push tags.)
- That run builds both images, signs `rpi-alert-<tag>-src.tar.gz` with the `RELEASE_SIGNING_KEY` secret ([docs/release-signing.md](docs/release-signing.md)) and publishes the GitHub release, about 30–60 minutes in all. Check it finished, and that the release carries the tarball and its `.sig` (`gh api repos/cdomotor-g/RPi_ALERT/releases/latest --jq '.tag_name, [.assets[].name]'`). If it failed, fix it and start it again, or say so in the run summary.
- Bump the version for anything a Pi would notice: a feature or setting is a minor (0.16.0 → 0.17.0), a fix a patch. Run the whole suite (`cd agent && npm test`) before tagging.
- Updates roll back on their own (`rpi-alert-update` puts the previous version back if the new one doesn't answer within two minutes), and new behaviour ships behind a setting that defaults to what was there before — the way 0.16's decoder setting defaults to *Full*.
- This holds until v1.0.0. From then, ask the owner before a release.
