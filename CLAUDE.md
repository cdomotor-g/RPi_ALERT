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

<!-- run-summary:start · the same in every repository: change it in cdomotor-g/atlas docs/run-summary.md, then copy it out with tools/run-summary.mjs -->
## Run summary — how to end a run
When you finish a piece of work, end your reply with this report, filled in. A short reply that only answers a question (no work done) skips it and doesn't use up a run number.

```markdown
---
# 🏁 THIS RUN SUMMARY (Run N)
> What this run achieved, in one plain sentence. **Needs you:** Y1, Q1 — or **Nothing needs you.**

## ✅ Done
- **D1** What changed and where, with a link when there is one (commit, issue, page).

## 🧪 Checks
- **C1** 🟢 What was checked, and what it showed.

## 🚧 Not done
- **N1** What was skipped, failed or is left for later, and why.

## 🙋 Needs you
- **Y1** What needs your hands, money or say, step by step.

## 💻 Needs your sign-in
- **S1** What needs only your sign-in, as a brief to paste into Dispatch.

## ❓ Questions
- **Q1** The question. Options as **Q1.1**, **Q1.2**, the one you'd pick marked *(recommended)*.
```

- **The marker.** A horizontal rule, then the 🏁 heading word for word, so I can find it by scrolling. N counts the summaries in this chat: Run 1 first, then one more than the last marker. A new chat starts at Run 1. Use it once per reply, at the start of the report: everything above it is working notes, and nothing comes after the report. The line under it lists every Y, S and Q point, or says nothing needs me.
- **Same sections, same letters, every repository.** These headings, emoji and order; leave out any that would be empty, and add none. Every point starts with its section's letter and number: **D** done · **C** checks · **N** not done · **Y** needs you · **S** needs your sign-in · **Q** questions. Nest with a dot (**D2.1**). Numbers restart each run, so when I reply "Q1: yes" or "Run 2 Y1", that's the point I mean.
- **Checks show their result:** 🟢 passed · 🟡 passed with a warning · 🔴 failed · ⚪ not run, and why. Never call something fixed or passing that wasn't checked.
- **Needs you, or needs your sign-in.** **Y** is only what needs my hands, money or say: hardware, a site, an order, a decision. What needs only my sign-in (a dashboard, a setting, an account page) is **S**: do it yourself if this session can use my computer; otherwise write it as a brief I can paste into Dispatch.
- **Short.** One line a point, two at most: what happened and what it means for me, not how it was done.
- **Plain words.** I'm not a software engineer, and I may read only this report. Prefer the everyday word. Where a technical term, an abbreviation, a word used in a special sense, or a mention of something I may not have seen (a file, a tool, an earlier step) is the clearest choice, add a few words saying what it is the first time. Name a thing by what it does, not only by its file or function name.
<!-- run-summary:end -->

## Releases — cut them by default (until v1.0.0)
- When a piece of work bumps `agent/package.json`'s version, cut the release in the same piece of work, once it is on `main`. Don't ask first. A Pi's update check, Flood-Net's Base Stations tab and *Install new releases automatically* only ever see releases, so a version left on `main` reaches no Pi.
- Cut it by starting `build-image.yml` with a release tag: `gh workflow run build-image.yml --ref main -f arch=both -f release_tag=v<version>`. A cloud session's proxy refuses pushing a tag and the releases API, but it lets a workflow be started, and the workflow makes the tag and the release itself. (`git tag v<version> && git push origin v<version>` does the same from anywhere that may push tags.)
- That run builds both images, signs `rpi-alert-<tag>-src.tar.gz` with the `RELEASE_SIGNING_KEY` secret ([docs/release-signing.md](docs/release-signing.md)) and publishes the GitHub release, about 30–60 minutes in all. Check it finished, and that the release carries the tarball and its `.sig` (`gh api repos/cdomotor-g/RPi_ALERT/releases/latest --jq '.tag_name, [.assets[].name]'`). If it failed, fix it and start it again, or say so in the run summary.
- Bump the version for anything a Pi would notice: a feature or setting is a minor (0.16.0 → 0.17.0), a fix a patch. Run the whole suite (`cd agent && npm test`) before tagging.
- Updates roll back on their own (`rpi-alert-update` puts the previous version back if the new one doesn't answer within two minutes), and new behaviour ships behind a setting that defaults to what was there before — the way 0.16's decoder setting defaults to *Full*.
- This holds until v1.0.0. From then, ask the owner before a release.
