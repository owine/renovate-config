# Alpine Custom CDN Datasource — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `repology` datasource with a custom Alpine-CDN `html` datasource in the shared `alpine.json` preset, add a `node`-image review gate, and document both — leaving the five consumer repos to migrate in their own sessions.

**Architecture:** `alpine.json` gains a top-level `customDatasources.alpine` whose registry URL is derived, via Handlebars, from the `alpine_X_Y/` prefix that consumers already put in their `depNameTemplate` — so the Alpine release line stays a one-line edit per repo and the shared preset stays version-agnostic. The two existing apk `packageRules` flip from `matchDatasources: ["repology"]` to `["custom.alpine"]` with their bodies untouched, preserving the unified `alpine packages` group and its automerge posture. The `repology.org` `hostRules` throttle **stays** in this phase and is deleted in Phase 3.

**Tech Stack:** Renovate JSON presets. Verified with `renovate --platform=local --dry-run=lookup` (renovate 44.33.0 on PATH) against throwaway clones of the real consumer repos, plus `renovate-config-validator --strict` mirroring `.github/workflows/validate.yml`.

**Spec:** `docs/superpowers/specs/2026-08-19-alpine-custom-datasource-design.md`

**Scope:** Phase 1 only — this repo. Phase 2 (five consumer PRs) and Phase 3 (delete the throttle) are separate sessions; the spec's Appendix is their recipe.

> **Critical, read before starting:** `renovate-config-validator --strict` does **not** validate the `customDatasources` sub-schema — an invalid `"format"` passes clean with exit 0 (measured). The validator is a syntax gate only. **The dry-run harness in Task 1 is the real gate for every change in this plan.**

> **Do not** delete the `hostRules` repology block in this phase. Un-migrated consumers still resolve through Repology for the whole of Phase 2 and need it.

---

### Task 1: Build the dry-run verification harness

The harness serves this repo's `alpine.json` over HTTP and points a throwaway clone of a consumer repo at it, so preset edits can be verified locally without pushing. Renovate resolves plain-URL presets, and `--platform=local` cannot resolve `local>` presets — this is the workaround.

**Files:**
- Create: `$SCRATCH/harness.sh` (scratchpad only — **never committed**)
- Create: `$SCRATCH/gate.py` (scratchpad only — **never committed**)

- [ ] **Step 1: Set the scratchpad variable**

```bash
export SCRATCH=/private/tmp/claude-501/-Users-owine-Git-renovate-config/d684098c-3087-4686-8cda-38f20e6e49dc/scratchpad
export REPO=/Users/owine/Git/renovate-config
mkdir -p "$SCRATCH"
```

- [ ] **Step 2: Write the gate script**

This is the spec's Validation script verbatim. It filters on `depName`, **not** on datasource, so the same script works before the migration (deps are `repology`), after it (`custom.alpine`), and after a rollback.

Create `$SCRATCH/gate.py`:

```python
import json, sys
lines = open(sys.argv[1]).read().splitlines()
i = [n for n, l in enumerate(lines) if 'packageFiles with updates' in l][-1]
buf = []
for l in lines[i+1:]:
    if l.startswith((' ', '\t')): buf.append(l)
    else: break
cfg = json.loads('{' + '\n'.join(buf).strip() + '}')['config']
deps = [d for files in cfg.values() for f in files for d in f.get('deps', [])
        if d.get('depName', '').startswith('alpine_')]
seen = {d['depName']: d for d in deps}          # dedupe repeated packageFile blocks
bad = [n for n, d in seen.items() if not d.get('currentVersion')]
ds = sorted({d.get('datasource') for d in seen.values()})
print(f"{len(seen)} apk deps via {ds}; UNTRACKED: {bad or 'none'}")
for n, d in sorted(seen.items()):
    up = (d.get('updates') or [{}])[0].get('newValue', '-')
    print(f"  {n:36} {d.get('currentVersion','** UNTRACKED **'):14} -> {up}")
sys.exit(1 if bad else 0)
```

- [ ] **Step 3: Write the harness script**

Create `$SCRATCH/harness.sh`. It clones a consumer, repoints only its `:alpine` extends entry at the locally served preset, optionally applies the consumer-side customManager edit, and runs the gate.

```bash
#!/usr/bin/env bash
# usage: harness.sh <repo> <config-path> [--migrate]
set -euo pipefail
REPO_NAME="$1"; CFG="$2"; MIGRATE="${3:-}"
WORK="$SCRATCH/h/$REPO_NAME"
rm -rf "$WORK"; mkdir -p "$SCRATCH/h"
git clone -q --depth 1 "https://github.com/owine/$REPO_NAME" "$WORK"

python3 - "$WORK/$CFG" "$MIGRATE" <<'EOF'
import json, re, sys
path, migrate = sys.argv[1], sys.argv[2]
raw = open(path).read()
raw = raw.replace('"github>owine/renovate-config:alpine"',
                  '"http://127.0.0.1:8899/alpine.json"')
if migrate == '--migrate':
    raw = raw.replace('"datasourceTemplate": "repology"',
                      '"datasourceTemplate": "custom.alpine",\n'
                      '      "extractVersionTemplate": "^{{{package}}}-(?<version>\\\\d.*)\\\\.apk$"')
open(path, 'w').write(raw)
EOF

cd "$WORK"
LOG_LEVEL=debug renovate --platform=local --dry-run=lookup > lookup.log 2>&1 || true
python3 "$SCRATCH/gate.py" lookup.log
```

```bash
chmod +x "$SCRATCH/harness.sh"
```

- [ ] **Step 4: Start the preset server**

```bash
cd "$REPO" && python3 -m http.server 8899 --bind 127.0.0.1 > /dev/null 2>&1 &
echo $! > "$SCRATCH/server.pid"
curl -sf http://127.0.0.1:8899/alpine.json | head -2
```
Expected: the first two lines of the current `alpine.json`. Kill it later with `kill $(cat $SCRATCH/server.pid)`.

- [ ] **Step 5: Establish the baseline (this is the "test currently passes on the old behavior" check)**

```bash
"$SCRATCH/harness.sh" doc-scanner renovate.json
```
Expected: `1 apk deps via ['repology']; UNTRACKED: none`, listing `alpine_3_24/tini`.

If this reports `UNTRACKED`, stop — the harness or Repology is broken, and nothing downstream in this plan is trustworthy.

- [ ] **Step 6: Prove the harness detects the change (this is the failing test)**

```bash
"$SCRATCH/harness.sh" doc-scanner renovate.json --migrate
```
Expected: **failure** — the config references `custom.alpine`, which the served `alpine.json` does not yet define. Renovate reports the dep with no `currentVersion` (or errors on the unknown datasource); the gate exits non-zero.

This failing run is what Task 2 fixes. Do not proceed until you have seen it fail.

---

### Task 2: Add the custom datasource to `alpine.json`

**Files:**
- Modify: `alpine.json` (add a top-level `customDatasources` key)

- [ ] **Step 1: Add the block**

Insert `customDatasources` immediately after the top-level `"description"` and before `"hostRules"`:

```json
  "customDatasources": {
    "alpine": {
      "description": "Alpine apk versions, read from the distro's own package index on dl-cdn.alpinelinux.org - the same host apk installs from. format 'html' turns every href in the directory listing into a version candidate; the consumer's extractVersionTemplate picks the one belonging to each package. The registry URL is DERIVED from the alpine_X_Y/ prefix in the consumer's depNameTemplate, so the Alpine release line stays a single-place edit in the consumer and this preset stays version-agnostic - do NOT hardcode a release line here. The datasource name 'alpine' is load-bearing: every packageRule below matches on 'custom.alpine'. /main/ and /x86_64/ are fleet-wide constants; community packages need a consumer-side registryUrls override (custom datasources use registryStrategy 'first', so the override REPLACES this URL rather than adding to it - listing both warns 'Excess registryUrls found' and uses only the first).",
      "defaultRegistryUrlTemplate": "https://dl-cdn.alpinelinux.org/alpine/v{{ replace '_' '.' (replace 'alpine_' '' (lookup (split packageName '/') 0)) }}/main/x86_64/",
      "format": "html"
    }
  },
```

- [ ] **Step 2: Validate JSON syntax**

```bash
cd "$REPO" && python3 -m json.tool alpine.json > /dev/null && echo OK
```
Expected: `OK`

- [ ] **Step 3: Re-run the previously failing gate**

```bash
"$SCRATCH/harness.sh" doc-scanner renovate.json --migrate
```
Expected: `1 apk deps via ['custom.alpine']; UNTRACKED: ['alpine_3_24/tini']` — still failing, but for a **different and correct** reason: `tini` is a community package and the default URL is `/main/`. This is the spec's silent-untrack failure mode, now caught by the gate.

- [ ] **Step 4: Confirm a `main` package resolves**

```bash
"$SCRATCH/harness.sh" house-manager renovate.json --migrate
```
Expected: `2 apk deps via ['custom.alpine']; UNTRACKED: none`, listing `alpine_3_24/curl` and `alpine_3_24/postgresql18-client` with real `currentVersion` values.

- [ ] **Step 5: Commit**

```bash
cd "$REPO"
git add alpine.json
git commit -m "feat(alpine): add custom CDN datasource for apk lookups

Reads Alpine's own package index instead of Repology. The registry URL is
derived from the alpine_X_Y/ prefix in the consumer's depNameTemplate, so the
release line stays a one-line edit per repo and this preset stays
version-agnostic."
```

---

### Task 3: Flip the apk packageRules to `custom.alpine`

**Files:**
- Modify: `alpine.json` (the two `matchDatasources: ["repology"]` rules)

- [ ] **Step 1: Flip the separate-flags rule**

Change `"matchDatasources": ["repology"]` to `"matchDatasources": ["custom.alpine"]` in the rule whose description begins "Keep every Alpine apk (repology) bump on ONE branch". Replace `(repology)` with `(custom.alpine)` in that description and change the trailing sentence `Force both flags false for the whole repology datasource` to `Force both flags false for the whole custom.alpine datasource`.

- [ ] **Step 2: Flip the unified-group rule**

In the rule whose description begins "Repology (Alpine apk) non-major pins", change `"matchDatasources": ["repology"]` to `["custom.alpine"]` and replace the leading `Repology (Alpine apk)` with `Alpine apk (custom.alpine)`. Leave every other key — `matchUpdateTypes`, `groupName`, `minimumReleaseAge`, `schedule`, `automerge`, `automergeType` — exactly as-is. **The grouping and automerge posture must not change in this migration.**

- [ ] **Step 3: Update the Alpine base-image rule's description**

In the rule with `"groupName": "alpine base image"`, replace `requires hand-editing the consumer's repology depNameTemplate (alpine_X_Y/)` with `requires hand-editing the consumer's depNameTemplate (alpine_X_Y/), which now also drives the CDN registry URL`.

- [ ] **Step 4: Update the top-level preset description**

Replace the `(1) Repology apk pins:` opening with `(1) apk pins (custom.alpine CDN datasource):` and the `separateMinorPatch/separateMajorMinor are forced false for the repology datasource` clause with `... for the custom.alpine datasource`. Replace `(3) hostRules throttle repology.org so apk lookups stop silently failing` with `(3) a TRANSITIONAL hostRules throttle for repology.org, retained only until every consumer has migrated off the repology datasource - delete it then`.

- [ ] **Step 5: Validate and re-gate**

```bash
cd "$REPO" && python3 -m json.tool alpine.json > /dev/null && echo OK
"$SCRATCH/harness.sh" house-manager renovate.json --migrate
```
Expected: `OK`, then `2 apk deps via ['custom.alpine']; UNTRACKED: none`.

- [ ] **Step 6: Verify the grouping survived**

```bash
grep -c 'renovate/alpine-packages\|"alpine packages"' "$SCRATCH/h/house-manager/lookup.log"
```
Expected: a non-zero count — the deps still land in the `alpine packages` group. If this is 0, the flip broke the group and Task 3 is not done.

- [ ] **Step 7: Commit**

```bash
cd "$REPO"
git add alpine.json
git commit -m "feat(alpine)!: point apk packageRules at the custom.alpine datasource

Bodies unchanged: the unified 'alpine packages' group, 0-day soak,
at-any-time schedule, automerge, and the forced separateMinorPatch/
separateMajorMinor:false all carry over. Consumers must switch their
customManager to datasourceTemplate: custom.alpine - see the migration
appendix in the design spec."
```

---

### Task 4: Add the node-image review gate

Closes the hole where `doc-scanner` and `house-manager` take their Alpine line from `node:*-alpine` with nothing gating a crossing.

**Files:**
- Modify: `alpine.json` (append one packageRule)

- [ ] **Step 1: Append the rule**

Add as the **last** entry in `packageRules`:

```json
    {
      "description": "Node runtime images carry an Alpine release line (node:24.19.0-alpine is Alpine 3.24.1), and Node moves that base at its own cadence - including on patch rebuilds. A crossing invalidates the consumer's alpine_X_Y/ depNameTemplate AND, because this preset derives the CDN registry URL from that prefix, its registry URL too. Gate every node image bump to manual review so a human checks the resulting line. Deliberately sets NO groupName: node.json's toolchain-versions group must keep node and pnpm co-bumping in one PR, and a group here would split them (a single automerge:false upgrade disables the whole branch, and addLabels is unioned across upgrades, so the gate works without one). Majors already carry needs-review via docker.json's runtime rule. digest/pinDigest are EXCLUDED and this is a known gap: a same-tag rebuild can re-point the floating node:*-alpine alias at a new Alpine line. Pinning node:X-alpine3.24 instead was rejected - Renovate cannot couple the node version and the Alpine suffix, so an explicit suffix would freeze the line with nothing ever signalling the move to 3.25, trading a rare silent crossing for a permanent silent stall. This rule is UNCONDITIONAL for :alpine consumers, and is the THIRD place node/docker.io/library/node is named across these presets - keep it in sync with node.json's toolchain-versions and docker.json's dockerfile-bases negation list.",
      "matchDatasources": ["docker"],
      "matchPackageNames": ["node", "docker.io/library/node"],
      "matchUpdateTypes": ["minor", "patch"],
      "automerge": false,
      "addLabels": ["needs-review"]
    }
```

- [ ] **Step 2: Validate and re-gate**

```bash
cd "$REPO" && python3 -m json.tool alpine.json > /dev/null && echo OK
"$SCRATCH/harness.sh" house-manager renovate.json --migrate
```
Expected: `OK`, then `2 apk deps via ['custom.alpine']; UNTRACKED: none` — unchanged. The node gate must not disturb apk resolution.

- [ ] **Step 3: Verify node and pnpm stay grouped**

```bash
grep -o 'toolchain-versions' "$SCRATCH/h/house-manager/lookup.log" | head -1
```
Expected: `toolchain-versions` present. If node has been split onto its own branch, the rule wrongly set a `groupName` — re-check Step 1.

- [ ] **Step 4: Commit**

```bash
cd "$REPO"
git add alpine.json
git commit -m "feat(alpine): gate node image bumps to manual review

doc-scanner and house-manager take their Alpine line from node:*-alpine, and
neither the alpine nor the HA base-image gate covers it. Sets no groupName so
node.json's toolchain-versions keeps node and pnpm co-bumping; accepted cost
is that those bumps stop automerging in the two node-based consumers."
```

---

### Task 5: Update `home-assistant.json`'s Repology references

**Files:**
- Modify: `home-assistant.json` (two description strings, lines 3 and 13)

- [ ] **Step 1: Update both descriptions**

In the top-level `description` and in the `home assistant base image` rule description, replace both occurrences of `repology alpine_X_Y/ depNameTemplate` / `repology depNameTemplate (alpine_X_Y/)` with `alpine_X_Y/ depNameTemplate (which also drives the CDN registry URL)`. The word `repology` must not remain in this file.

- [ ] **Step 2: Verify**

```bash
cd "$REPO" && python3 -m json.tool home-assistant.json > /dev/null && echo OK
grep -ci repology home-assistant.json
```
Expected: `OK`, then `0`.

- [ ] **Step 3: Commit**

```bash
cd "$REPO"
git add home-assistant.json
git commit -m "docs(home-assistant): drop stale Repology references from descriptions"
```

---

### Task 6: Update the README

**Files:**
- Modify: `README.md` (presets table row ~36, consumer notes ~68-130, ~199)

- [ ] **Step 1: Update the `alpine.json` table row**

Replace `apk pins (Repology datasource)` with `apk pins (custom Alpine-CDN datasource)`, and replace the `Adds a **hostRules throttle for repology.org** …` sentence with: `Retains a **transitional `hostRules` throttle for `repology.org`** until every consumer has migrated off Repology. Also gates **node image** bumps (minor/patch) to manual review.`

- [ ] **Step 2: Rewrite the consumer customManager snippet**

In the "**`alpine.json` is packageRules-only**" bullet, change `datasource: repology` to `datasource: custom.alpine`, and update the reference snippet to:

```json
  {
    "customType": "regex",
    "managerFilePatterns": ["/Dockerfile$/"],
    "matchStringsStrategy": "any",
    "matchStrings": ["\\s\\s(?<package>[a-z0-9][a-z0-9-_]+)=(?<currentValue>[a-z0-9-_.]+)\\s+"],
    "versioningTemplate": "loose",
    "datasourceTemplate": "custom.alpine",
    "depNameTemplate": "alpine_3_24/{{package}}",
    "extractVersionTemplate": "^{{{package}}}-(?<version>\\d.*)\\.apk$"
  }
```

Add after it: the datasource name `alpine` is fixed by the preset; the `\d` anchor in `extractVersionTemplate` is what keeps `gd` from matching `gd-dev-*.apk`; and `{{{package}}}` must be triple-stashed so the name is not HTML-escaped into the regex.

- [ ] **Step 3: Add a community-index bullet**

New consumer note, with the packageRule from the spec, stating: custom datasources use `registryStrategy: "first"`, so the override **replaces** the main index; the URL derives its release line from the depName so an Alpine bump stays a one-line edit; and **a community package missing from this rule is silently untracked — no warning, no dashboard entry**. Include the index-determination command from the spec Appendix verbatim (the `hit=$(…)` form — not a `grep | sed || echo` pipeline, which never fires its miss branch).

- [ ] **Step 4: Rewrite the throttle bullet**

Keep the `no-result` troubleshooting text — the string is unchanged — but reframe it: `custom.alpine` emits the same `Failed to look up custom.alpine package …: no-result` on a wrong Alpine line or a 404, so that warning is **not** proof of a config typo; a CDN 5xx produces the same message. State that the `repology.org` throttle is transitional and scheduled for deletion once all consumers migrate.

- [ ] **Step 5: Extend the depNameTemplate bullet**

Add: the `alpine_X_Y/` prefix now also drives the CDN registry URL, so it remains exactly **one** edit per repo on a release bump — including for repos with community packages, whose override derives the same prefix.

- [ ] **Step 6: Add a node-gate bullet**

Document the gate, its unconditional scope for `:alpine` consumers, its automerge cost in node-based consumers, the excluded `digest`/`pinDigest` gap and why, and that `node` is now named in three presets that must stay in sync.

- [ ] **Step 7: Fix the stray line ~199 reference**

`Rare in practice — Repology seldom classifies an apk bump as …` → replace `Repology` with `the CDN datasource`.

- [ ] **Step 8: Verify**

```bash
cd "$REPO" && grep -n 'epology' README.md
```
Expected: hits **only** in the transitional-throttle bullet and the rollback/migration context. No hit should describe Repology as the live apk datasource.

- [ ] **Step 9: Commit**

```bash
cd "$REPO"
git add README.md
git commit -m "docs: document the custom Alpine CDN datasource and node gate"
```

---

### Task 7: Full pre-merge gate across all five consumers

This is the gate the spec requires before Phase 1 merges. **All five must pass.**

**Files:** none modified — verification only.

- [ ] **Step 1: Run the harness against every consumer**

```bash
"$SCRATCH/harness.sh" nut-cgi .github/renovate.json --migrate
"$SCRATCH/harness.sh" ha-hetrixtools-agent renovate.json --migrate
"$SCRATCH/harness.sh" doc-scanner renovate.json --migrate
"$SCRATCH/harness.sh" house-manager renovate.json --migrate
"$SCRATCH/harness.sh" claude-terminal-home-assistant renovate.json --migrate
```

Expected distinct-depName counts: **6, 12, 1, 2, 19.**

`doc-scanner` and `claude-terminal-home-assistant` **will** report `UNTRACKED` for their community packages — that is correct at this point, because their community packageRules are Phase 2 consumer-side work. Verify the untracked sets are **exactly**:

- `doc-scanner`: `['alpine_3_24/tini']`
- `claude-terminal-home-assistant`: `alpine_3_24/` × `npm`, `py3-aiohttp`, `py3-beautifulsoup4`, `ttyd`, `vim`, `yq-go`

Any **other** untracked package is a real defect in this phase — investigate before proceeding. The other three repos must report `UNTRACKED: none`.

- [ ] **Step 2: Confirm the community override fixes the two**

Re-run `doc-scanner` with its Phase 2 community packageRule appended to the clone's config (copy it from the spec Appendix), and confirm `UNTRACKED: none`. This proves the Phase 2 recipe works against the Phase 1 preset before any consumer session starts.

- [ ] **Step 3: Confirm `nut-cgi`'s `gd` / `gd-dev` pair resolved distinctly**

```bash
grep -E 'alpine_3_24/(gd|gd-dev)' "$SCRATCH/h/nut-cgi/lookup.log" | head -4
```
Expected: both present with their own `currentVersion`. A shared or missing version means the `\d` anchor failed.

- [ ] **Step 4: Run the config validator**

```bash
cd "$REPO"
renovate-config-validator --strict renovate.json default.json automerge.json \
  node.json python.json docker.json alpine.json home-assistant.json
```
Expected: `Config validated successfully`. Ignore the `RE2 not usable` warning — it is benign on this machine. Remember this gate does **not** cover the `customDatasources` block.

- [ ] **Step 5: Stop the preset server**

```bash
kill "$(cat "$SCRATCH/server.pid")" && rm -f "$SCRATCH/server.pid"
```

- [ ] **Step 6: Confirm no scratchpad artifacts leaked into the repo**

```bash
cd "$REPO" && git status --short
```
Expected: clean. `harness.sh`, `gate.py`, clones and logs live only in `$SCRATCH`.

---

### Task 8: Open the Phase 1 PR

- [ ] **Step 1: Push and open**

```bash
cd "$REPO"
git push -u origin feat/alpine-custom-datasource
gh pr create --title "feat(alpine): replace Repology with a custom Alpine CDN datasource" --body "$(cat <<'BODY'
Phase 1 of the migration described in
`docs/superpowers/specs/2026-08-19-alpine-custom-datasource-design.md`.

Replaces the `repology` datasource with a custom `html` datasource over
Alpine's own package index. The registry URL is derived from the `alpine_X_Y/`
prefix consumers already carry in `depNameTemplate`, so the release line stays
a one-line edit per repo and this preset stays version-agnostic.

The unified `alpine packages` group, 0-day soak, at-any-time schedule,
automerge, and forced `separateMinorPatch`/`separateMajorMinor: false` are
unchanged.

Also adds a `node`-image review gate: `doc-scanner` and `house-manager` take
their Alpine line from `node:*-alpine`, and nothing gated a crossing.

**The `repology.org` throttle is deliberately retained** — un-migrated
consumers still need it through Phase 2. Phase 3 deletes it.

Verified with `renovate --platform=local --dry-run=lookup` (44.33.0) against
throwaway clones of all five consumers: expected dep counts 6/12/1/2/19, no
unexpected untracked packages, `gd`/`gd-dev` distinct, grouping preserved.
Note `renovate-config-validator` does not check the `customDatasources`
sub-schema, so the dry-run is the real gate.

**Merging this starts the Phase 2 window** — un-migrated repos fall back into
`automerge.json`'s generic bundle until their consumer PR lands. Migrate the
five promptly, using the spec's Appendix as the per-repo recipe.
BODY
)"
```

- [ ] **Step 2: Report the PR URL and the Phase 2 checklist to the maintainer**

List the five repos with their expected dep counts and which two need a community packageRule.
