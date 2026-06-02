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

Only extend the ecosystem presets a repo actually uses. Extend `:mcp` *after* `:node`, and `:alpine` last — after `:automerge` and every other ecosystem preset.

## Presets

| File | Purpose |
|------|---------|
| `default.json` | Baseline. Pinned ranges, 3-day soak, OSV alerts, GH Action digests, lockfile maintenance, pre-commit hook updates, weekly schedule (Mondays, `America/Chicago`). Majors separated into their own PRs and held for manual review. `rebaseWhen: auto` — Renovate rebases stale PRs only when safe (no manual edits, no conflicts); use the PR checkbox to force a rebase otherwise. |
| `automerge.json` | Group all non-major updates into one PR, automerge once CI passes. Skip if you want hand-review of every patch. |
| `node.json` | Node/TS peer-dep groupings: React, TanStack, Radix, Vite, Vitest+testcontainers, ESLint, Prisma, Auth.js, pg, Hono, Preact, Cloudflare Workers (wrangler/@cloudflare/miniflare), toolchain (node+pnpm). |
| `python.json` | pep621 groupings: FastAPI stack, Pydantic, SQLAlchemy stack, pytest, lint/types tooling. |
| `docker.json` | Dockerfile base bundling, GH Actions setup/artifact/docker families, runtime-major flags. |
| `mcp.json` | MCP server repos: isolate `@modelcontextprotocol/sdk` for manual review (`feat:` prefix), keep `engines.node` unpinned for library consumers. Extend after `node.json`. |
| `alpine.json` | Alpine apk packages (Repology datasource): own group, 0-day soak, runs any time, automerges non-major. Carved out of `automerge.json`'s bundle — extend after it. **Requires a consumer-side customManager** (see Consumer notes). |

## Supply-chain posture

- **`rangeStrategy: pin`** — caret/tilde ranges become exact versions in `package.json`/`pyproject.toml`.
- **`minimumReleaseAge: 3 days`** baseline (majors: 7 days) — soak window so a yanked/compromised release is caught before it lands; majors additionally require manual review.
- **`minimumReleaseAgeBehaviour: timestamp-optional`** — Renovate 42's default (`timestamp-required`) marks any release lacking a publish timestamp as *pending forever*, which permanently freezes Docker updates from registries that don't expose timestamps (GHCR, Quay, mcr.microsoft.com, most private registries) under the soak above. `timestamp-optional` treats a timestamp-less release as stable instead — Docker Hub (and npm/PyPI/etc.) still get the real soak; timestamp-less registries skip it (they can't be soaked either way, so the choice is *flow* vs *deadlock*).
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
