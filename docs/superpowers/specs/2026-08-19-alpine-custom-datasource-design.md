# Alpine apk pins: Repology → custom CDN datasource — design

Date: 2026-08-19
Status: Approved

## Problem

Every `owine/*` repo that pins Alpine apk packages resolves them through the
**Repology** datasource. Repology rate-limits its `tools/project-by` endpoint
aggressively, Mend-hosted Renovate runs from shared IPs, and each run resolves
~20 packages per repo through it. `alpine.json` already carries a `hostRules`
throttle (2 req/s, 2 concurrent, 60s timeout, `abortOnError: false`) to keep
lookups alive.

The throttle is a mitigation, not a fix, and the failure it mitigates is
silent-by-construction: the Repology datasource emits `no-result` **both** when
a package genuinely does not exist *and* when the HTTP request failed. While
lookups fail, Renovate cannot see apk drift. Because Alpine purges the older
build of every package the moment it drifts, the first signal is a red Docker
build (`apk add` cannot find the pinned version) rather than a PR — the
early-warning system goes dark exactly when it is needed.

`hassio-addons/app-ssh#1119` (merged 2026-08-18) hit this hard enough to break
CI and replaced Repology with a Renovate **custom datasource** reading Alpine's
own package index on `dl-cdn.alpinelinux.org` — the same host `apk` installs
from. That is the approach adopted here.

Upstream `renovatebot/renovate#40250` ("feat(datasource): add APK datasource
support") remains **open** as of this date. It is the correct long-term answer;
this design is the interim step and is shaped so adopting it later is a
one-line `datasourceTemplate` swap per repo plus deleting one preset block.

## Goals

- Replace the `repology` datasource with a custom `html` datasource over the
  Alpine CDN directory index, fleet-wide.
- Keep every existing behavior of `alpine.json` unchanged: the single
  `alpine packages` group, `minimumReleaseAge: 0`, `schedule: at any time`,
  automerge, and the forced `separateMinorPatch`/`separateMajorMinor: false`.
- Keep the Alpine release line a **single-place edit** in each consumer.
- Delete the now-pointless `repology.org` `hostRules` throttle.
- Document the new failure modes and the preset↔consumer contract.

## Non-goals

- Changing the grouping or automerge posture. The invariants that produced them
  (Alpine purges old builds; split apk PRs deadlock) are unaffected by the
  datasource swap.
- Multi-arch lookups. Measured 2026-08-19: **zero** version skew across
  `x86_64`/`aarch64`/`armv7` for all 35 packages the fleet pins. A transient
  per-arch builder lag is possible; multi-arch CI fails loudly on it.
- Moving the consumer-side `customManager` into the shared preset. Its
  `depNameTemplate` encodes a repo-specific Alpine release line.
- Preemptively restructuring for #40250 beyond keeping the future swap to one
  line per file.
- **Building a CI guard for silently-untracked apk pins.** Considered and
  declined 2026-08-19: a per-repo build step asserting every pinned
  `name=version` appears in the index its config points at would convert the
  one failure Renovate cannot report (see Failure modes) into a loud one. The
  accepted mitigation is instead the dependency-count parity assertion at
  migration time plus a documented rule for new pins. Rationale: the eventual
  detector is unchanged from today (Alpine purges the build, CI goes red), so
  this migration does not make the fleet worse on that axis, and five
  hand-maintained CI steps is machinery the risk does not yet justify. Revisit
  if a pin is ever found to have gone untracked in practice.

## Fleet inventory (measured 2026-08-19)

Five consumer repos extend `:alpine`. All five are on **Alpine v3.24** and all
five use `alpine_3_24/{{package}}`:

| Repo | Base image | apk pins | in `community` |
|------|-----------|----------|----------------|
| `nut-cgi` | `alpine:3.24.1` | 6 | — |
| `ha-hetrixtools-agent` | `ghcr.io/home-assistant/base:3.24` | 12 | — |
| `doc-scanner` | `node:24.19.0-alpine` (= Alpine 3.24.1) | 1 | `tini` |
| `house-manager` | `node:24.19.0-alpine` (= Alpine 3.24.1) | 2 | — |
| `claude-terminal-home-assistant` | `ghcr.io/home-assistant/base:3.24` | 19 | `npm`, `py3-aiohttp`, `py3-beautifulsoup4`, `ttyd`, `vim`, `yq-go` |

35 distinct packages fleet-wide; 7 live in `community`, the rest in `main`.

## Design

### Registry URL derived from the depName

Custom datasources use `registryStrategy: "first"` — multiple `registryUrls`
are not tried in turn — so `main` and `community` need distinct URLs, and the
URL must carry the Alpine release line. Rather than write that line a second
time, the preset **derives** it from the `alpine_X_Y/` prefix the consumer's
`depNameTemplate` already produces:

```
https://dl-cdn.alpinelinux.org/alpine/v{{ replace '_' '.' (replace 'alpine_' '' (lookup (split packageName '/') 0)) }}/main/x86_64/
```

`packageName` is `alpine_3_24/curl`; `split`/`lookup` take the prefix, the two
`replace`s turn `alpine_3_24` into `3.24`. Verified working on Renovate 44.33.0
(see Validation). This keeps the release line a one-knob edit per repo and
keeps the shared preset version-agnostic, so repos can move release lines
independently.

### `alpine.json`

1. **Add** a top-level `customDatasources.alpine` entry (`format: "html"`) with
   the derived URL above.
2. **Delete** the `hostRules` block. Nothing contacts `repology.org` any more,
   and a stale throttle for an unused host is a future debugging red herring.
3. **Flip** both `matchDatasources: ["repology"]` packageRules to
   `["custom.alpine"]`. Their bodies are unchanged.
4. **Rewrite** the affected `description` strings: drop the Repology
   rate-limit narrative, document the new failure modes, and state the
   preset↔consumer contract (below). The top-level preset `description` and
   `home-assistant.json`'s Repology references get the same treatment.

### Preset ↔ consumer contract

The preset both matches on the datasource name and parses the release line out
of the depName, so consumers MUST:

- use `datasourceTemplate: "custom.alpine"` (the name `alpine` is load-bearing
  — `custom.apk` would silently drop the repo out of every Alpine rule); and
- keep `depNameTemplate: "alpine_<major>_<minor>/{{package}}"`.

`customDatasources` **merges** across config layers, so a consumer that already
defines its own custom datasource (`claude-terminal-home-assistant` ships
`claude-code`) keeps it alongside the preset's `alpine`.

### Consumer change (identical shape in all five repos)

In the existing apk `customManager`:

```json
"datasourceTemplate": "custom.alpine",
"depNameTemplate": "alpine_3_24/{{package}}",
"extractVersionTemplate": "^{{{package}}}-(?<version>\\d.*)\\.apk$"
```

The `html` format turns every `href` in the directory listing into a version
candidate; `extractVersionTemplate` selects the one belonging to this package.
The `\d` anchor after the package name is load-bearing: it prevents `gd` from
matching `gd-dev-2.3.3-r10.apk` (a live pair in `nut-cgi`) and `docker` from
matching `docker-bash-completion-*`. The triple-stash `{{{package}}}` avoids
HTML-escaping the name into the regex.

No consumer defines a `customDatasources` block for Alpine.

`doc-scanner` and `claude-terminal-home-assistant` additionally need a local
packageRule pointing their `community` packages at the community index:

```json
{
  "description": "Packages that live in the Alpine community repository. Custom datasources use registryStrategy 'first' (verified: listing both URLs logs 'Excess registryUrls found ... using first configured only'), so this REPLACES the main index rather than adding to it. A package missing from this list is SILENTLY untracked - no warning, no dashboard entry - so check the index when adding any apk pin.",
  "matchDatasources": ["custom.alpine"],
  "matchPackageNames": ["alpine_3_24/tini"],
  "registryUrls": ["https://dl-cdn.alpinelinux.org/alpine/v3.24/community/x86_64/"]
}
```

This list stays consumer-side because which packages a repo installs is
repo-specific knowledge — the same reason the `customManager` is not shared.

### New failure modes (measured, not assumed)

Verified on Renovate 44.33.0 by pointing a `community` package at the `main`
index:

- **Package in the wrong repository index** (`main` vs `community`), or a
  typo'd name: the index fetch **succeeds** (HTTP 200, ~6000 hrefs), none match
  `extractVersion`, and Renovate reports `updates: []`, `warnings: []`, **no
  `skipReason` and no Dependency Dashboard entry**. The package is silently
  untracked. `hassio-addons/app-ssh#1119` claims such a miss "fails loudly";
  that is **not** what Renovate does, and this design does not rely on it.
  Repology's `no-result` was ambiguous but at least *present*; this signal is
  absent. It is not silent forever — an untracked pin stops receiving bumps,
  and when Alpine purges that build the Docker build goes red — but the early
  warning is gone. Mitigations: the dependency-count parity assertion at
  migration time (below), and the standing rule that adding a new apk pin
  requires checking which index it lives in.
- **Wrong Alpine line in `depNameTemplate`** (e.g. `alpine_3_99/`): the derived
  URL 404s and the lookup fails visibly. Better than Repology, where a wrong
  line returned a clean empty result.
- **Two `registryUrls` listed instead of one**: Renovate logs
  `Excess registryUrls found for datasource lookup - using first configured
  only` and never tries the second. The community override must **replace** the
  URL, not append to it.

### README

- Update the `alpine.json` presets-table row: custom CDN datasource, no
  Repology, no `hostRules`.
- Replace the "Repology lookups are throttled, and `no-result` is ambiguous"
  consumer note with a note covering the new datasource, the naming contract,
  the community-index requirement, and the failure modes above.
- Update the reference `customManager` snippet to the new three lines.
- Extend the "Alpine version in `depNameTemplate` is repo-specific" note: that
  one edit now also drives the registry URL, and getting it wrong 404s loudly
  instead of failing silently.
- Note the all-or-nothing rollback (below).

## Validation

Verified during design on Renovate 44.33.0 against a local fixture
(`--platform=local --dry-run=lookup`):

- a `community` package left pointing at `main` yields `updates: []`,
  `warnings: []`, no `skipReason` — silently untracked (see failure modes);
- listing both URLs uses only the first (`registryStrategy: "first"` confirmed);
- the derived URL resolves with no explicit `registryUrls`:
  `alpine_3_24/curl` 8.20.0-r0 → 8.21.0-r0;
- the community override resolves: `alpine_3_24/tini` 0.19.0-r1 → 0.19.0-r3;
- `gd` and `gd-dev` resolve as distinct packages;
- zero lookup failures, zero warnings;
- `customDatasources` merges across config layers without dropping either key.

Before merge, each of the five consumer repos is dry-run against the preset
**branch** (`github>owine/renovate-config:alpine#feat/alpine-custom-datasource`)
— consumers resolve presets from the default branch, so a branch ref is the
only way to prove the change before it lands. Three assertions per repo:

1. zero lookup failures / `no-result`;
2. **dependency count parity with the current Repology run** — a silently
   untracked package is the worst regression available here and produces no
   error of its own;
3. deps land in the `alpine packages` group, and any genuinely stale pin
   produces the expected `newValue`.

`renovate-config-validator --strict` over the modified presets, as usual.

## Sequencing and rollback

Hard cutover, preset first, by explicit decision. Consumer migrations are
performed in **separate sessions in each consumer repo**, using the recipe in
this spec.

The exposure window: consumers resolve the preset from the default branch, so
the moment the preset merges, an un-migrated repo's apk deps (still
`datasource: repology`) stop matching the Alpine rules and fall back into
`automerge.json`'s generic non-major bundle, where `default.json`'s 3-day soak
and `separateMinorPatch` apply — the split-PR deadlock `alpine.json` exists to
prevent. Renovate runs weekly on Mondays, so landing the preset midweek and
migrating the five repos before the next Monday run makes the window dead time.
Un-migrated repos are also still subject to Repology's failures during the
window, with the throttle removed.

Rollback is all-or-nothing: reverting the preset while consumers are on
`custom.alpine` leaves apk pins ungrouped, which is worse than either end
state. Revert the consumers first, or not at all.


## Appendix: per-repo migration recipe

Each consumer migration happens in a separate session in that repo. All five
are on Alpine v3.24 and use `depNameTemplate: "alpine_3_24/{{package}}"`, which
does **not** change. In every repo, the edit to the apk `customManager` is the
same two lines:

```json
"datasourceTemplate": "custom.alpine",
"extractVersionTemplate": "^{{{package}}}-(?<version>\\d.*)\\.apk$"
```

(replacing `"datasourceTemplate": "repology"`). Also update that manager's
`description`, which names Repology in all five repos.

Before editing, record the parity baseline:

```
renovate --platform=local --dry-run=lookup   # count deps with datasource repology
```

After editing, re-run against the preset branch
(`github>owine/renovate-config:alpine#feat/alpine-custom-datasource`) and assert
the same dep count now resolves under `custom.alpine`, with zero lookup
failures. A dropped dep is the failure this check exists to catch.

| Repo | Config file | Manager `managerFilePatterns` | Pins | Community rule needed |
|------|-------------|-------------------------------|------|----------------------|
| `nut-cgi` | `.github/renovate.json` | `/Dockerfile$/` | 6 | no |
| `ha-hetrixtools-agent` | `renovate.json` | `/^hetrixtools-agent/Dockerfile$/` | 12 | no |
| `doc-scanner` | `renovate.json` | `/Dockerfile$/` | 1 | **yes** — `tini` |
| `house-manager` | `renovate.json` | `/Dockerfile$/` | 2 | no |
| `claude-terminal-home-assistant` | `renovate.json` | `/^claude-terminal/Dockerfile$/` | 19 | **yes** — `npm`, `py3-aiohttp`, `py3-beautifulsoup4`, `ttyd`, `vim`, `yq-go` |

Repo-specific cautions:

- **`house-manager`** carries top-level `dockerfile` and `regex` `ignorePaths`
  blocks that un-ignore test directories, with a standing note that the two
  lists must stay in sync. This migration touches neither; leave both alone.
- **`claude-terminal-home-assistant`** already defines
  `customDatasources.claude-code`. Do **not** add an Alpine entry there — the
  preset supplies `customDatasources.alpine` and the two keys merge. Its
  `matchDatasources: ["custom.claude-code"]` packageRule is unaffected. This
  repo is a fork; confirm Renovate is running on the fork before relying on the
  dashboard to confirm the migration.
- **`nut-cgi`** pins both `gd` and `gd-dev`. This is the pair the `\d` anchor in
  `extractVersionTemplate` exists for; verify both resolve to distinct versions
  in the dry-run.
- **`doc-scanner`** pins exactly one apk package, so its parity baseline is 1.
  A silent miss here means the repo tracks nothing at all.
