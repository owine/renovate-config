# renovate-config

Shared [Renovate](https://docs.renovatebot.com/) presets for `owine/*` repositories. Supply-chain hardened defaults: pin everything, soak releases, fast-track CVE fixes.

## Usage

In any repo's `renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [
    "github>owine/renovate-config",
    "github>owine/renovate-config:automerge",
    "github>owine/renovate-config:node",
    "github>owine/renovate-config:python",
    "github>owine/renovate-config:docker",
    "github>owine/renovate-config:mcp",
    "github>owine/renovate-config:alpine"
  ]
}
```

Only extend the ecosystem presets a repo actually uses. Extend `:mcp` *after* `:node`, and `:alpine` / `:home-assistant` last — after `:automerge`, `:docker`, and every other ecosystem preset.

## Presets

| File | Purpose |
|------|---------|
| `default.json` | Baseline. Pinned ranges, 3-day soak, OSV alerts, GH Action digests, lockfile maintenance, pre-commit hook updates, weekly schedule (Mondays, `America/Chicago`). Majors separated into their own PRs and held for manual review. `rebaseWhen: auto` — Renovate rebases stale PRs only when safe (no manual edits, no conflicts); use the PR checkbox to force a rebase otherwise. |
| `automerge.json` | Group all non-major updates into one PR, automerge once CI passes. Skip if you want hand-review of every patch. |
| `node.json` | Node/TS peer-dep groupings: React, TanStack, Radix, Vite, Vitest+testcontainers, ESLint, Prisma, Auth.js, pg, Hono, Preact, Cloudflare Workers (wrangler/@cloudflare/miniflare), toolchain (node+pnpm). |
| `python.json` | pep621 groupings: FastAPI stack, Pydantic, SQLAlchemy stack, pytest, lint/types tooling. Plus a `python runtime` group binding an exact-pinned `requires-python` (via customManager) to the `python` Docker base image — **needs a manual `uv lock` commit**, see Consumer notes. |
| `docker.json` | Dockerfile base bundling, GH Actions setup/artifact/docker families, runtime-major flags. The `dockerfile bases` group **excludes the language-runtime images** (`node`/`pnpm`/`python`, both bare and `docker.io/library/…` spellings) so they stay with their own runtime groups — see Consumer notes. |
| `mcp.json` | MCP server repos: isolate `@modelcontextprotocol/sdk` for manual review (`feat:` prefix), keep `engines.node` unpinned for library consumers. Extend after `node.json`. |
| `alpine.json` | Alpine updates. apk pins (Repology datasource): one `alpine packages` group, 0-day soak, runs any time, **automerges every non-major bump (patch/pin/digest/minor) together**. Adds a **`hostRules` throttle for `repology.org`** (2 req/s, 2 concurrent, 60s timeout, `abortOnError: false`) so apk lookups stop silently failing. Also gates **alpine base-image (`docker`) minor bumps** to manual review (the base-image patch line automerges). Carved out of `automerge.json`'s bundle — extend after it (and after `docker.json`). **Requires a consumer-side customManager** (see Consumer notes). |
| `home-assistant.json` | Home Assistant add-on repos. Pins the HA base image (`ghcr.io/home-assistant/base`) to a versioned tag + digest and gates its **minor bumps** to manual review (the tag *is* the Alpine line, so a bump means hand-editing the repology `alpine_X_Y/` template); digest rebuilds automerge. Adds CalVer versioning for the `home-assistant/builder` action. Extend after `:automerge`/`:docker` (and `:alpine` if used). |

## Commit types & release-please

These presets are tuned for consumer repos running [release-please](https://github.com/googleapis/release-please), which parses the Conventional Commit **type** to decide releases: `feat` → minor, `fix`/`deps` → patch, `chore` → **hidden, no release**.

Renovate ships built-in default `packageRules` that type every bump `chore:` (npm production deps `fix:`), and `packageRules` always beat top-level config — so a bare `semanticCommitType` is inert and Dockerfile/Actions/apk repos would get **no release-please releases at all**. `default.json` reclaims the types via `packageRules`:

| Update | Commit type | release-please effect |
|--------|-------------|-----------------------|
| patch / minor / pin / digest | `deps:` | patch → *Dependencies* section |
| major | `feat:` | minor → *Features* section |
| security (`vulnerabilityAlerts`) | `fix:` | patch → *Bug Fixes* section |
| lock file maintenance | `chore:` | **no release** (hidden) |
| hand-picked consumer dep (e.g. `mcp.json`'s `@modelcontextprotocol/sdk`) | `feat:` | minor → *Features* section |

Rule precedence (last match wins) is: catch-all `*` → `deps` → lock file maintenance → `chore` → `major` → `feat` → security `fix` (forced) → any per-repo `feat` opt-in. A repo where a specific dependency's *minor* bumps are consumer-facing can add its own `{ "matchPackageNames": [...], "semanticCommitType": "feat" }` rule — see `mcp.json`.

## Supply-chain posture

- **`rangeStrategy: pin`** — caret/tilde ranges become exact versions in `package.json`/`pyproject.toml`.
- **`minimumReleaseAge: 3 days`** baseline (majors: 7 days) — soak window so a yanked/compromised release is caught before it lands; majors additionally require manual review.
- **`minimumReleaseAgeBehaviour: timestamp-optional`** — a timestamp-less release is treated as stable rather than held by the soak above.
  - Renovate 42's default (`timestamp-required`) marks any release lacking a publish timestamp as *pending indefinitely*.
  - Combined with the soak, that permanently freezes Docker updates from registries that don't expose timestamps: GHCR, Quay, `mcr.microsoft.com`, most private/Artifactory registries.
  - Docker Hub (and npm/PyPI/crates.io/etc.) still get the real soak — they provide timestamps. Timestamp-less registries skip it (they can't be soaked either way, so the choice is *flow* vs *deadlock*).
- **`vulnerabilityAlerts`** override — CVE fixes skip the soak and automerge.
- **`helpers:pinGitHubActionDigests`** — every `uses:` resolves to a 40-char commit SHA.
- **`pinDigests: true`** for Dockerfiles — base images pinned by `@sha256:` digest.
- **`osvVulnerabilityAlerts`** + **`security:openssf-scorecard`** — extra vuln signal beyond GitHub's native alerts.

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

  Adjust `managerFilePatterns` to match your Dockerfile's path (the example matches any file ending in `Dockerfile`). The `\s\s` anchor in `matchStrings` assumes apk pins are indented by exactly two spaces (typical of a line-continued `RUN apk add` block); widen it to `\s+` or anchor on `RUN apk add` if your Dockerfile uses a different style, or the pins will be silently skipped.

- **Repology lookups are throttled, and `no-result` is ambiguous.** `alpine.json`
  ships a top-level `hostRules` entry for `repology.org` (`maxRequestsPerSecond: 2`,
  `concurrentRequestLimit: 2`, `timeout: 60000`, `abortOnError: false`). Repology
  rate-limits aggressively and Mend-hosted Renovate runs from shared IPs, so
  unthrottled bursts get throttled and land on the Dependency Dashboard as:

  ```
  WARN: Repology lookup failed with unexpected error
  Failed to look up repology package alpine_3_24/tini: no-result
  ```

  The Repology datasource emits `no-result` **both** when a package genuinely
  doesn't exist *and* when the HTTP request failed — so this reads like a broken
  `depNameTemplate` or a typo'd package name when it's really transport-layer.
  Before chasing a config bug, hit the endpoint Renovate itself uses:

  ```
  https://repology.org/tools/project-by?repo=alpine_3_24&name_type=binname&target_page=api_v1_project&noautoresolve=on&name=tini
  ```

  A `200` with the expected payload means the config is fine. Because the entry
  lives in the shared preset, every repo pinning apks via Repology inherits it.
  Don't raise the rate limits to speed lookups up — that re-triggers the
  throttling. This isn't cosmetic: while lookups fail, Renovate can't see apk
  drift, and since Alpine purges older builds the first signal becomes a red
  Docker build instead of a PR. (Longer term, upstream
  [renovatebot/renovate#40250](https://github.com/renovatebot/renovate/pull/40250)
  adds a first-class APK datasource; until it ships, Repology is the only option.)

- **The Alpine version in `depNameTemplate` is repo-specific and unmanaged.**
  When a repo bumps its Alpine base image (e.g. `3.23` → `3.24`), it must
  hand-edit `alpine_3_23/` → `alpine_3_24/` in its own customManager, or
  Repology lookups silently return zero updates. This repo-specific knob is
  exactly why the customManager is **not** shipped in the shared preset.
  To protect this coupling, `alpine.json` gates **base-image `minor` bumps**
  (`datasource: docker`, `packageName: alpine`) to manual review — they're the
  ones that cross release lines and demand the hand-edit. Base-image `patch`
  bumps stay within the line, leave the template valid, and automerge normally.

- **Preset ordering is load-bearing.** Compose as: `default` → `automerge` →
  ecosystem presets → `mcp` (after `node`) → `alpine` / `home-assistant` (after
  `automerge` **and `docker`**). Renovate applies `packageRules` in order and the
  last match wins; each later preset peels its packages out of the prior
  catch-all group. Wrong order leaves packages mis-grouped (e.g. apk pins stuck
  in the generic non-major automerge bundle, or the alpine / HA base-image minor
  gate losing to `docker.json`'s "dockerfile bases" group / `automerge.json`'s
  bundle).

- **Language runtimes move as one PR, by exclusion — not by ordering.** Both
  `node.json`'s `toolchain-versions` and `python.json`'s `python runtime` group a
  runtime's Docker base image together with the manifest that pins the same
  version. `docker.json`'s `dockerfile bases` rule matches
  `matchManagers: ["dockerfile"]`, so it would otherwise re-group those base
  images out — last matching rule wins, and `:node`/`:python` are extended before
  `:docker`. It therefore **negates** `node`, `pnpm`, `python`, and their
  `docker.io/library/…` spellings. The negation is deliberate rather than a
  reliance on preset order: `extends` order lives in each consumer's
  `renovate.json`, and no consumer should have to know that grouping depends on
  it. The exclusion list and the two runtime rules must stay in sync — a name
  excluded in `docker.json` but missing from its runtime rule gets no group at
  all and splits exactly as before. Entries are plain strings, glob-matched with
  `.` and `/` literal, so `python-slim`, `my.registry/python`, `nodered/node-red`,
  and `docker.io/library/postgres` all still group as `dockerfile bases`.

- **A `python runtime` PR lands red and needs a manual `uv lock` commit.**
  `uv.lock` carries its own `requires-python`, and nothing in these presets can
  refresh it: the exact-pin tracker is a `customManager` (a text substitution
  that runs no lockfile update), and `postUpgradeTasks` isn't available on the
  Mend-hosted app. Push one hand-authored `uv lock` commit to the PR branch or
  every uv job fails `The current Python version … is not compatible with the
  locked Python requirement`. Lockfile maintenance reconciles `uv.lock`
  eventually, but on its own schedule and on a different branch — it will not
  unblock the open PR.

  What each split actually breaks:

  | Runtime | Split halves | Failure on *both* halves |
  |---------|--------------|--------------------------|
  | Node | `FROM node:X` vs `.nvmrc` + `engines.node` + `packageManager` | `ERR_PNPM_UNSUPPORTED_ENGINE` under `engineStrict`, mirrored expected/got |
  | Python | `FROM python:X` vs `requires-python = "==X.Y.Z"` | `No interpreter found for Python <old>` / `not compatible with the locked Python requirement` |

  Digest pinning is unaffected either way: `pinDigests` comes from
  `default.json`'s `matchManagers: ["dockerfile", "github-actions"]` rule, and
  the runtime images' `digest`/`pinDigest` updates just group under their runtime
  name. In a repo that extends `:docker` but **not** the matching ecosystem
  preset, a runtime base-image bump becomes its own PR (or joins
  `automerge.json`'s non-major bundle) — self-consistent, since there is no
  manifest on the other side to disagree with it.

- **Runtime majors stay grouped.** Neither runtime rule sets
  `matchUpdateTypes`, so the group covers majors too — a runtime major has the
  same drift hazard as a patch, and both deps bump to the same version. This
  doesn't weaken the major policy: `separateMajorMinor`/`separateMultipleMajor`
  still isolate the major onto its own branch, and `default.json`'s major rule
  still applies the 7-day soak, `automerge: false`, `feat:`, and
  `major-update`/`needs-review`. Grouping decides who shares the branch, not how
  it's reviewed.

- **`home-assistant.json` is opt-in for HA add-on repos.** It pins
  `ghcr.io/home-assistant/base` (tag + digest) and gates its `minor` bumps to
  manual review for the same reason as the alpine base image: the HA base tag
  *is* the Alpine release line, so a bump forces the `alpine_X_Y/`
  `depNameTemplate` hand-edit. It also gives the `home-assistant/builder` action
  CalVer (`YYYY.MM.PATCH`) versioning. Extend it late, after `:docker`.

- **Major apk bumps fall through to `default.json`.** `alpine.json`'s apk group
  matches only `patch`/`pin`/`digest`/`minor` (all automerged together), so a major
  bump is handled by the baseline major rule (7-day soak, `automerge: false`,
  `needs-review`). Rare in practice — Repology seldom classifies an apk bump as
  major.
