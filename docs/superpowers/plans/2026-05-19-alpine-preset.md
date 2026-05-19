# Alpine apk Preset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable `alpine.json` Renovate preset that groups Alpine apk (Repology) packages, removes the release soak, runs off-schedule, and automerges non-major — plus the README docs covering downstream-consumer caveats.

**Architecture:** A single `packageRule` keyed on `matchDatasources: ["repology"]`, composed *after* `automerge.json` so last-match-wins peels Repology deps out of the catch-all automerge bundle into their own group (same mechanic `mcp.json` uses). Documentation additions to README explain that the preset is packageRules-only and the consumer remains responsible for the Dockerfile customManager.

**Tech Stack:** Renovate JSON presets; validated with `renovate-config-validator --strict` (renovate@43.150.0) via `npx`, mirroring `.github/workflows/validate.yml`.

**Spec:** `docs/superpowers/specs/2026-05-19-alpine-preset-design.md`

> **Note (out of scope, flag to maintainer):** `.github/workflows/validate.yml` does not list `mcp.json` in its validator file list — a pre-existing gap. This plan adds `alpine.json` to that list but intentionally does not touch the `mcp.json` omission (separate concern, not in spec).

---

### Task 1: Create `alpine.json` preset

**Files:**
- Create: `alpine.json`

- [ ] **Step 1: Write the preset file**

Create `alpine.json` with exactly this content:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "description": "Alpine apk packages (Repology datasource). Routine apk pins are low-risk and benefit from fast turnaround: own group, no release soak, runs any time, automerges non-major. Carved out of automerge.json's bundle. Extend AFTER automerge.json. Major bumps still fall through to default.json's manual-review rule.",
  "packageRules": [
    {
      "description": "Group all Repology (Alpine apk) pins, skip the soak, run off-schedule, automerge non-major",
      "matchDatasources": ["repology"],
      "matchUpdateTypes": ["patch", "minor", "pin", "digest"],
      "groupName": "alpine packages",
      "minimumReleaseAge": "0 days",
      "schedule": ["at any time"],
      "automerge": true,
      "automergeType": "pr"
    }
  ]
}
```

- [ ] **Step 2: Validate the preset (this is the test)**

Run:
```bash
npx --yes --package "renovate@43.150.0" -- renovate-config-validator --strict alpine.json
```
Expected: exit 0, output contains `Config validated successfully`. There is no unit-test framework in this repo; the validator is the verification gate.

- [ ] **Step 3: Add `alpine.json` to the CI validator list**

Modify `.github/workflows/validate.yml`. In the `Validate Renovate presets` step, append `alpine.json` to the backslash-continued file list (after `docker.json`, keeping the trailing-backslash style; the last file has no trailing backslash):

```yaml
      - name: Validate Renovate presets
        run: |
          npx --yes --package "renovate@43.150.0" -- renovate-config-validator --strict \
            renovate.json \
            default.json \
            automerge.json \
            node.json \
            python.json \
            docker.json \
            alpine.json
```

- [ ] **Step 4: Re-validate the full list locally**

Run:
```bash
npx --yes --package "renovate@43.150.0" -- renovate-config-validator --strict \
  renovate.json default.json automerge.json node.json python.json docker.json alpine.json
```
Expected: exit 0, every file reports validated successfully.

- [ ] **Step 5: Commit**

```bash
git add alpine.json .github/workflows/validate.yml
git commit -m "feat: add alpine apk preset"
```

---

### Task 2: Document downstream-consumer considerations in README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the preset to the Usage `extends` example**

In `README.md`, in the ```json Usage block, add this line to the `extends` array immediately after the `:mcp` line (it is the last entry — add a comma to the `:mcp` line):

```json
    "github>owine/renovate-config:mcp",
    "github>owine/renovate-config:alpine"
```

- [ ] **Step 2: Add the ordering note**

Directly below that code block, the README currently reads:
`Only extend the ecosystem presets a repo actually uses. Extend ` + "`:mcp`" + ` *after* ` + "`:node`" + `.`

Change it to also mention alpine ordering:

`Only extend the ecosystem presets a repo actually uses. Extend ` + "`:mcp`" + ` *after* ` + "`:node`" + `, and ` + "`:alpine`" + ` *after* ` + "`:automerge`" + `.`

- [ ] **Step 3: Add the Presets table row**

In the `## Presets` table, add this row immediately after the `mcp.json` row (last row of the table):

```markdown
| `alpine.json` | Alpine apk packages (Repology datasource): own group, 0-day soak, runs any time, automerges non-major. Carved out of `automerge.json`'s bundle — extend after it. **Requires a consumer-side customManager** (see Consumer notes). |
```

- [ ] **Step 4: Add the "Consumer notes & caveats" section**

Append this new section to the end of `README.md`, after the `## Supply-chain posture` list:

```markdown
## Consumer notes & caveats

- **`alpine.json` is packageRules-only.** It acts only on dependencies already
  classified `datasource: repology`. The consuming repo must define its own
  `customManager` that detects `pkg=version` apk pins in its Dockerfile and
  templates `datasource=repology` with
  `depName=alpine_<major>_<minor>/{{package}}` (e.g. `alpine_3_23/{{package}}`).
  Reference regex:

  ```json
  {
    "customType": "regex",
    "managerFilePatterns": ["/Dockerfile$/"],
    "matchStringsStrategy": "any",
    "matchStrings": ["\\s\\s(?<package>[a-z0-9][a-z0-9-_]+)=(?<currentValue>[a-z0-9-_.]+)\\s+"],
    "versioningTemplate": "loose",
    "datasourceTemplate": "repology",
    "depNameTemplate": "alpine_3_23/{{package}}"
  }
  ```

- **The Alpine version in `depNameTemplate` is repo-specific and unmanaged.**
  When a repo bumps its Alpine base image (e.g. `3.23` → `3.24`), it must
  hand-edit `alpine_3_23/` → `alpine_3_24/` in its own customManager, or
  Repology lookups silently return zero updates. This repo-specific knob is
  exactly why the customManager is **not** shipped in the shared preset.

- **Preset ordering is load-bearing.** Compose as: `default` → `automerge` →
  ecosystem presets → `mcp` (after `node`) → `alpine` (after `automerge`).
  Renovate applies `packageRules` in order and the last match wins; each later
  preset peels its packages out of the prior catch-all group. Wrong order
  leaves packages mis-grouped (e.g. apk pins stuck in the generic non-major
  automerge bundle).

- **Major apk bumps fall through to `default.json`.** `alpine.json` matches
  only `patch`/`minor`/`pin`/`digest`, so a major bump is handled by the
  baseline major rule (7-day soak, `automerge: false`, `needs-review`). Rare in
  practice — Repology seldom classifies an apk bump as major.
```

- [ ] **Step 5: Verify Markdown renders and links are consistent**

Run:
```bash
grep -n "alpine" README.md
```
Expected: the `extends` line, the ordering sentence, the Presets table row, and the Consumer notes section all reference `alpine` consistently. Confirm the Presets table still has aligned `|` columns and the new row uses the same `| `file` | desc |` shape as siblings.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document alpine preset and consumer caveats"
```

---

### Task 3: Final verification

- [ ] **Step 1: Full validator pass**

Run:
```bash
npx --yes --package "renovate@43.150.0" -- renovate-config-validator --strict \
  renovate.json default.json automerge.json node.json python.json docker.json alpine.json
```
Expected: exit 0, all files validated successfully.

- [ ] **Step 2: Confirm clean tree and review log**

```bash
git status --porcelain   # expected: empty
git log --oneline -3     # expected: docs commit, feat commit, spec commit
```

- [ ] **Step 3: Done.** Hand off to finishing-a-development-branch for PR/merge decision. Mention to the maintainer the out-of-scope observation that `mcp.json` is absent from `validate.yml`'s validator list.
