# Alpine apk pins: Repology → custom CDN datasource — design

Date: 2026-08-19
Status: Approved (revised after spec review, same day)

## Problem

Every `owine/*` repo that pins Alpine apk packages resolves them through the
**Repology** datasource. Repology rate-limits its `tools/project-by` endpoint
aggressively, Mend-hosted Renovate runs from shared IPs, and each run resolves
up to ~20 packages per repo through it. `alpine.json` already carries a
`hostRules` throttle (2 req/s, 2 concurrent, 60s timeout, `abortOnError: false`)
to keep lookups alive.

The throttle is a mitigation, not a fix, and the failure it mitigates is
ambiguous by construction: the Repology datasource emits `no-result` **both**
when a package genuinely does not exist *and* when the HTTP request failed.
While lookups fail, Renovate cannot see apk drift. Because Alpine purges the
older build of every package the moment it drifts, the first signal is a red
Docker build (`apk add` cannot find the pinned version) rather than a PR — the
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
- Keep the Alpine release line a **single-place edit** in each consumer — the
  `depNameTemplate`, and nothing else.
- Close the ungated `node`-image → Alpine-line coupling (see Node coupling).
- Retire the `repology.org` throttle only once no repo still needs it.
- Document the new failure modes and the preset↔consumer contract.

## Non-goals

- Changing the grouping or automerge posture for apk packages. The invariants
  that produced them (Alpine purges old builds; split apk PRs deadlock) are
  unaffected by the datasource swap.
- Multi-arch lookups. See Arch assumption.
- A `hostRules` entry for `dl-cdn.alpinelinux.org`. Decided 2026-08-19: no host
  policy. Renovate's defaults apply. The consequence is recorded under Failure
  modes.
- Moving the consumer-side `customManager` into the shared preset. Its
  `depNameTemplate` encodes a repo-specific Alpine release line.
- **A CI guard for silently-untracked apk pins.** Considered and declined
  2026-08-19: a per-repo build step asserting every pinned `name=version`
  appears in the index its config points at would convert the one failure
  Renovate cannot report (see Failure modes) into a loud one. The accepted
  mitigation is the per-dep `currentVersion` assertion at migration time
  (Validation) plus a documented rule for new pins. Rationale: the eventual
  detector is unchanged from today (Alpine purges the build, CI goes red), so
  this migration does not make the fleet worse on that axis, and five
  hand-maintained CI steps is machinery the risk does not yet justify. Revisit
  if a pin is ever found to have gone untracked in practice.
- Preemptively restructuring for #40250 beyond keeping the future swap to one
  line per file.

## Fleet inventory (measured 2026-08-19)

Method, so a future session can refresh it: `gh api search/code?q=repology+user:owine`
plus a read of each hit's `renovate.json`; pins extracted from each repo's
Dockerfile; `main`/`community` membership determined by fetching
`https://dl-cdn.alpinelinux.org/alpine/v3.24/{main,community}/x86_64/` and
grepping for `^<pkg>-[0-9]`.

Five consumer repos extend `:alpine`. All five are on **Alpine v3.24** and all
five use `alpine_3_24/{{package}}` (confirmed for the two `node`-based repos by
`docker run --rm --entrypoint cat node:24.19.0-alpine /etc/alpine-release` →
`3.24.1`):

| Repo | Base image | Pins | In `community` |
|------|-----------|------|----------------|
| `nut-cgi` | `alpine:3.24.1` | 6 | — |
| `ha-hetrixtools-agent` | `ghcr.io/home-assistant/base:3.24` | 12 | — |
| `doc-scanner` | `node:24.19.0-alpine` (= 3.24.1) | 1 | `tini` |
| `house-manager` | `node:24.19.0-alpine` (= 3.24.1) | 2 | — |
| `claude-terminal-home-assistant` | `ghcr.io/home-assistant/base:3.24` | 19 | `npm`, `py3-aiohttp`, `py3-beautifulsoup4`, `ttyd`, `vim`, `yq-go` |

40 pins, 35 distinct packages; 7 live in `community`, the rest in `main`.

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
`replace`s turn `alpine_3_24` into `3.24`.

**The same template works in a packageRule's `registryUrls`** (verified — see
Validation; note the debug log prints the *unrendered* template in the reported
config, so read the resolved `currentVersion`, not the printed URL, to confirm
it rendered). Combined with a release-line-agnostic `matchPackageNames` regex,
the community override carries no version either:

```json
{
  "matchDatasources": ["custom.alpine"],
  "matchPackageNames": ["/^alpine_.*/(tini|ttyd|vim)$/"],
  "registryUrls": ["https://dl-cdn.alpinelinux.org/alpine/v{{ replace '_' '.' (replace 'alpine_' '' (lookup (split packageName '/') 0)) }}/community/x86_64/"]
}
```

So an Alpine 3.24 → 3.25 bump remains a **one-line edit** to `depNameTemplate`
in every repo, including the two with community packages. This was the single
most important correction from spec review: an earlier draft hardcoded
`v3.24`/`alpine_3_24/` in the community block, which would have made a release
bump an 8-place edit in `claude-terminal-home-assistant` — strictly worse than
the status quo the design claims to preserve.

### `alpine.json`

1. **Add** a top-level `customDatasources.alpine` entry (`format: "html"`) with
   the derived `main` URL above.
2. **Flip** both `matchDatasources: ["repology"]` packageRules to
   `["custom.alpine"]`. Their bodies are otherwise unchanged.
3. **Add** the node-image gate (see Node coupling).
4. **Keep** the `hostRules` repology throttle for now. It is deleted in a
   separate follow-up PR once the last consumer has migrated — see Sequencing.
   An earlier draft deleted it in the same PR and justified that with "nothing
   contacts repology.org any more", which is false during the migration tail.
5. **Rewrite** the affected `description` strings: drop the Repology
   rate-limit narrative from the apk rules (the `hostRules` description keeps
   its own, plus a note that it is scheduled for deletion), document the new
   failure modes, and state the contract below. The top-level preset
   `description` and `home-assistant.json`'s Repology references get the same
   treatment.

### Preset ↔ consumer contract

The preset matches on the datasource name, parses the release line out of the
depName, and hardcodes two other coordinates. Consumers MUST:

- use `datasourceTemplate: "custom.alpine"` — the name `alpine` is load-bearing;
  `custom.apk` would silently drop the repo out of every Alpine rule; and
- keep `depNameTemplate: "alpine_<major>_<minor>/{{package}}"`.

Preset-side constants, fleet-wide, with no per-repo knob:

- **`/main/`** — the default index. Community packages need a consumer-side
  override (above).
- **`/x86_64/`** — see Arch assumption.

`customDatasources` **merges** across config layers, so a consumer that already
defines its own custom datasource (`claude-terminal-home-assistant` ships
`claude-code`) keeps it alongside the preset's `alpine`.

### Consumer change

In the existing apk `customManager`, replace `"datasourceTemplate": "repology"`
with:

```json
"datasourceTemplate": "custom.alpine",
"extractVersionTemplate": "^{{{package}}}-(?<version>\\d.*)\\.apk$"
```

The `html` format turns every `href` in the directory listing into a version
candidate; `extractVersionTemplate` selects the one belonging to this package.
The `\d` anchor after the package name is load-bearing: it prevents `gd` from
matching `gd-dev-2.3.3-r10.apk` (a live pair in `nut-cgi`) and `docker` from
matching `docker-bash-completion-*`. The triple-stash `{{{package}}}` avoids
HTML-escaping the name into the regex.

No consumer defines a `customDatasources` block for Alpine. Two repos add the
community packageRule. Per-repo detail is in the Appendix.

### Node coupling

`alpine.json` gates Alpine base-image minor bumps, and `home-assistant.json`
gates `ghcr.io/home-assistant/base` minor bumps, because both cross the Alpine
release line and invalidate the consumer's `depNameTemplate` — and now, by
derivation, its registry URL too.

Neither gate covers `doc-scanner` or `house-manager`, which take their Alpine
line from `node:24.19.0-alpine`. Node's images move their Alpine base at times
of Node's choosing, including on **patch** rebuilds, so no update-type subset
short of minor+patch is sufficient. Add to `alpine.json`:

```json
{
  "description": "Node runtime images carry an Alpine release line (node:24.19.0-alpine is Alpine 3.24.1), and Node moves that base at its own cadence — including on patch rebuilds. A crossing invalidates the consumer's alpine_X_Y/ depNameTemplate AND, since the preset derives the CDN registry URL from that prefix, its registry URL. Gate every node image bump to manual review so a human checks the resulting line. Deliberately sets NO groupName: node.json's toolchain-versions group must keep node and pnpm co-bumping in one PR, and setting a group here would split them. Majors already carry needs-review via docker.json's runtime rule.",
  "matchDatasources": ["docker"],
  "matchPackageNames": ["node", "docker.io/library/node"],
  "matchUpdateTypes": ["minor", "patch"],
  "automerge": false,
  "addLabels": ["needs-review"]
}
```

Accepted cost: node and pnpm bumps stop automerging in `doc-scanner` and
`house-manager` (the only `:alpine` consumers using the node image; the rule is
inert in the other three). Ordering holds because consumers extend `:alpine`
after `:node` and `:docker`, and last match wins.

### Arch assumption

The preset looks up `x86_64` only. Measured 2026-08-19 across
`x86_64`/`aarch64`/`armv7` for all 35 fleet packages: **zero** version skew.
This is an **ongoing invariant, not a one-time measurement** — two consumers
(`ha-hetrixtools-agent`, `claude-terminal-home-assistant`) build `aarch64` and
`armv7`. A transient per-arch builder lag would produce a pin that resolves on
x86_64 and fails `apk add` on another arch; multi-arch CI fails loudly on it.
Re-measure by diffing the `href` lists of the three arch indexes.

### Failure modes (measured on Renovate 44.33.0, not assumed)

- **Package in the wrong repository index** (`main` vs `community`), or a
  typo'd name: the index fetch **succeeds** (HTTP 200, 5,963 hrefs), none match
  `extractVersion`, and Renovate reports `updates: []`, `warnings: []`, **no
  `skipReason`, no `currentVersion`, and no Dependency Dashboard entry**. The
  package is silently untracked. `hassio-addons/app-ssh#1119` claims such a miss
  "fails loudly"; that is **not** what Renovate does, and this design does not
  rely on it. Repology's `no-result` was ambiguous but at least *present*; this
  signal is absent. Not silent forever — an untracked pin stops receiving
  bumps, and when Alpine purges that build the Docker build goes red — but the
  early warning is gone. Detected at migration by the `currentVersion`
  assertion (Validation).
- **Wrong Alpine line in `depNameTemplate`** (e.g. `alpine_3_99/`): the derived
  URL 404s and Renovate emits
  `Failed to look up custom.alpine package alpine_3_99/curl: no-result`.
  This is **the same visibility Repology already gave** — an earlier draft
  claimed an improvement here; there is none. The real delta is that the
  *transport-failure* ambiguity is gone: Repology conflated 429/5xx with "not
  found", whereas a CDN 404 means what it says. The existing README
  troubleshooting text for this case needs rewording, not deletion.
- **CDN 5xx or outage**: produces the same `no-result` warning as a 404, so a
  transient outage is indistinguishable from a wrong release line. Accepted —
  no host policy, by decision. Renovate's default `abortOnError: false` for
  datasources means a hiccup should not kill the run.
- **Two `registryUrls` listed instead of one**: Renovate emits
  `WARN: Excess registryUrls found for datasource lookup - using first
  configured only` and never tries the second. This lands in the run's warning
  set, making it the one loud misconfiguration in this design. The community
  override must **replace** the URL, not append to it.
- **Index size / cost**: the `main/x86_64` listing is 717 KB / 5,963 entries;
  two fetches per run per repo, against a CDN built for package traffic.
  A CDN edge serving a stale index could briefly lag a purge.

### README

- Update the `alpine.json` presets-table row: custom CDN datasource; the
  Repology throttle is transitional.
- Replace the "Repology lookups are throttled, and `no-result` is ambiguous"
  consumer note with one covering the new datasource, the naming contract, the
  community-index requirement, and the failure modes above — keeping the
  `no-result` troubleshooting text, reworded, since the string is unchanged.
- Update the reference `customManager` snippet, and add the community
  packageRule as a second snippet.
- Extend the "Alpine version in `depNameTemplate` is repo-specific" note: that
  one edit now also drives the registry URL, and it is still exactly one edit.
- Add the node-image gate to the consumer notes, including its automerge cost.
- Note the all-or-nothing rollback.

## Validation

### What the config validator does NOT cover

Measured: a preset containing `"customDatasources": {"alpine": {"format":
"htmlx", …}}` — an invalid format — passes `renovate-config-validator --strict`
clean, exit 0 (`Config validated successfully against 1 file(s)`). The
validator does not check the `customDatasources` sub-schema at all. A typo in
`format` or in the URL template is caught **only at lookup time**. The validator
therefore stays in CI as a syntax gate but provides no coverage for this change;
the dry-run fixture is the real one.

### Verified during design (Renovate 44.33.0, `--platform=local --dry-run=lookup`)

- Derived `main` URL resolves with no explicit `registryUrls`:
  `alpine_3_24/curl` 8.20.0-r0 → 8.21.0-r0.
- Derived **community** URL in a packageRule renders and resolves:
  `alpine_3_24/tini` 0.19.0-r1 → 0.19.0-r3, `alpine_3_24/ttyd` 1.7.6-r0 →
  1.7.7-r0, and `alpine_3_24/vim` (community-only) resolves
  `currentVersion: 9.2.0854-r0`.
- Release-line-agnostic `matchPackageNames` regex (`/^alpine_.*/(tini|ttyd|vim)$/`)
  matches correctly.
- `gd` and `gd-dev` resolve as distinct packages.
- `customDatasources` merges across config layers without dropping either key.
- `registryStrategy: "first"` confirmed, with the `Excess registryUrls` WARN.
- The silent-untracked failure reproduces exactly as described above.

### Per-repo gate before each consumer PR merges

Consumers resolve presets from the default branch, so before the preset lands,
dry-run against the branch ref
(`github>owine/renovate-config:alpine#feat/alpine-custom-datasource`); after it
lands, the plain ref is fine. Resolving a `github>` preset needs a token in the
environment (`RENOVATE_TOKEN`); `--platform=local` cannot resolve `local>`
presets at all.

Two assertions per repo:

1. **Every `custom.alpine` dep reports a non-null `currentVersion`.** This is
   the discriminator, and it is the one that matters: a silently-untracked dep
   has `updates: []`, `warnings: []` and **no** `currentVersion`, while a
   tracked-and-current dep has `currentVersion` set. Dependency *count* parity
   does **not** work here — the count comes from the unchanged `customManager`
   regex extraction and is identical whether the datasource resolves or not.
2. The expected dep count for that repo (Appendix table) is present, and any
   genuinely stale pin produces the expected `newValue`.

```bash
LOG_LEVEL=debug renovate --platform=local --dry-run=lookup > lookup.log 2>&1
python3 - <<'EOF'
import json
lines = open('lookup.log').read().splitlines()
i = [n for n, l in enumerate(lines) if 'packageFiles with updates' in l][-1]
buf = []
for l in lines[i+1:]:
    if l.startswith((' ', '\t')): buf.append(l)
    else: break
cfg = json.loads('{' + '\n'.join(buf).strip() + '}')['config']
deps = [d for files in cfg.values() for f in files for d in f.get('deps', [])
        if d.get('datasource') == 'custom.alpine']
seen = {d['depName']: d for d in deps}          # dedupe repeated blocks
bad = [n for n, d in seen.items() if not d.get('currentVersion')]
print(f"{len(seen)} custom.alpine deps; UNTRACKED: {bad or 'none'}")
for n, d in sorted(seen.items()):
    up = (d.get('updates') or [{}])[0].get('newValue', '-')
    print(f"  {n:36} {d.get('currentVersion','** UNTRACKED **'):14} -> {up}")
EOF
```

Exit criterion: `UNTRACKED: none`, and the dep count matches the Appendix.

## Sequencing and rollback

Hard cutover, preset first, by explicit decision. Consumer migrations are
performed in **separate sessions in each consumer repo**, using the Appendix.

**Phase 1 — preset PR** (this repo): add `customDatasources`, flip both
`matchDatasources`, add the node gate, rewrite descriptions, update README.
**Keep `hostRules`.**

**Phase 2 — five consumer PRs**, one session each, any order.

**Phase 3 — cleanup PR** (this repo): delete the `hostRules` repology throttle
and the README text that describes it, once all five have merged.

Exposure window: consumers resolve the preset from the default branch, so the
moment Phase 1 merges, an un-migrated repo's apk deps (still
`datasource: repology`) stop matching the Alpine rules and fall back into
`automerge.json`'s generic non-major bundle, where `default.json`'s 3-day soak
and `separateMinorPatch` apply — the split-PR deadlock `alpine.json` exists to
prevent. Keeping the throttle through Phase 2 means those repos at least keep
resolving. Renovate runs weekly on Mondays (plus dashboard-checkbox and
push-triggered runs, which can shorten this), so landing Phase 1 midweek and
finishing Phase 2 before the next Monday keeps the window close to dead time.

**Post-migration check, per repo** — the headline failure mode is silent, so
pre-merge verification alone is not enough. After the repo's next Renovate run:
confirm the Dependency Dashboard shows no `no-result` warnings, and that apk
updates (if any) arrive as a single `alpine packages` PR rather than split PRs.

**Rollback.** Reverting the preset while consumers are on `custom.alpine`
leaves apk pins ungrouped, which is worse than either end state. Unwind order,
including from a half-migrated fleet:

1. Revert the migrated consumer repos to `datasourceTemplate: "repology"`
   (dropping their community packageRules).
2. Revert the preset.
3. If Phase 3 already merged, **restore the `hostRules` throttle** — otherwise
   the reverted fleet lands on unthrottled Repology, the original failure.

## Appendix: per-repo migration recipe

Each consumer migration happens in a separate session in that repo. All five
are on Alpine v3.24 and use `depNameTemplate: "alpine_3_24/{{package}}"`, which
does **not** change. In every repo the `customManager` edit is identical:

```json
"datasourceTemplate": "custom.alpine",
"extractVersionTemplate": "^{{{package}}}-(?<version>\\d.*)\\.apk$"
```

replacing `"datasourceTemplate": "repology"`. Also update that manager's
`description`, which names Repology in all five repos. Then run the Validation
gate above and confirm `UNTRACKED: none` and the expected dep count.

| Repo | Config file | `managerFilePatterns` | Expected deps | Community rule |
|------|-------------|----------------------|---------------|----------------|
| `nut-cgi` | `.github/renovate.json` | `/Dockerfile$/` | 6 | no |
| `ha-hetrixtools-agent` | `renovate.json` | `/^hetrixtools-agent/Dockerfile$/` | 12 | no |
| `doc-scanner` | `renovate.json` | `/Dockerfile$/` | 1 | **yes** |
| `house-manager` | `renovate.json` | `/Dockerfile$/` | 2 | no |
| `claude-terminal-home-assistant` | `renovate.json` | `/^claude-terminal/Dockerfile$/` | 19 | **yes** |

### Community packageRule — `doc-scanner`

```json
{
  "description": "tini lives in the Alpine community repository. Custom datasources use registryStrategy 'first', so this REPLACES the main index rather than adding to it — listing both URLs would warn and use only the first. The URL derives its release line from the depName, so an Alpine bump stays a one-line edit to depNameTemplate. A community package missing from this rule is SILENTLY untracked: no warning, no dashboard entry. See owine/renovate-config README.",
  "matchDatasources": ["custom.alpine"],
  "matchPackageNames": ["/^alpine_.*/tini$/"],
  "registryUrls": ["https://dl-cdn.alpinelinux.org/alpine/v{{ replace '_' '.' (replace 'alpine_' '' (lookup (split packageName '/') 0)) }}/community/x86_64/"]
}
```

### Community packageRule — `claude-terminal-home-assistant`

```json
{
  "description": "These packages live in the Alpine community repository. Custom datasources use registryStrategy 'first', so this REPLACES the main index rather than adding to it. The URL derives its release line from the depName, so an Alpine bump stays a one-line edit to depNameTemplate. A community package missing from this rule is SILENTLY untracked: no warning, no dashboard entry. See owine/renovate-config README.",
  "matchDatasources": ["custom.alpine"],
  "matchPackageNames": ["/^alpine_.*/(npm|py3-aiohttp|py3-beautifulsoup4|ttyd|vim|yq-go)$/"],
  "registryUrls": ["https://dl-cdn.alpinelinux.org/alpine/v{{ replace '_' '.' (replace 'alpine_' '' (lookup (split packageName '/') 0)) }}/community/x86_64/"]
}
```

### Determining which index a package lives in

Required whenever a new apk pin is added to any of these repos:

```bash
PKG=tini; LINE=3.24
for R in main community; do
  printf '%-10s ' "$R"
  curl -s "https://dl-cdn.alpinelinux.org/alpine/v$LINE/$R/x86_64/" \
    | grep -oE "href=\"$PKG-[0-9][^\"]*" | sed 's/href="//' || echo '-'
done
```

### Repo-specific cautions

- **`house-manager`** carries top-level `dockerfile` and `regex` `ignorePaths`
  blocks that un-ignore test directories, with a standing note that the two
  lists must stay in sync. This migration touches neither; leave both alone.
  It also picks up the new node-image gate: node/pnpm bumps stop automerging.
- **`doc-scanner`** pins exactly one apk package, so a silent miss means the
  repo tracks nothing at all. It also picks up the node-image gate.
- **`claude-terminal-home-assistant`** already defines
  `customDatasources.claude-code`. Do **not** add an Alpine entry there — the
  preset supplies `customDatasources.alpine` and the two keys merge. Its
  `matchDatasources: ["custom.claude-code"]` packageRule is unaffected. This
  repo is a **fork**; confirm Renovate runs on the fork before relying on its
  dashboard to confirm the migration.
- **`nut-cgi`** pins both `gd` and `gd-dev` — the pair the `\d` anchor exists
  for. Verify both resolve to distinct versions in the dry-run. Its config
  lives at `.github/renovate.json`, not the repo root.
