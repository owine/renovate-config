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
    "github>owine/renovate-config:docker"
  ]
}
```

Only extend the ecosystem presets a repo actually uses.

## Presets

| File | Purpose |
|------|---------|
| `default.json` | Baseline. Pinned ranges, 3-day soak, OSV alerts, GH Action digests, lockfile maintenance, weekly schedule. Major bumps separated with 7-day soak. |
| `automerge.json` | Group all non-major updates into one PR, automerge once CI passes. Skip if you want hand-review of every patch. |
| `node.json` | Node/TS peer-dep groupings: React, TanStack, Radix, Vite/Vitest, ESLint, Prisma, Auth.js, toolchain (node+pnpm). |
| `python.json` | pep621 groupings: FastAPI stack, Pydantic, SQLAlchemy stack, pytest, lint/types tooling. |
| `docker.json` | Dockerfile base bundling, GH Actions setup/artifact/docker families, runtime-major flags. |

## Supply-chain posture

- **`rangeStrategy: pin`** — caret/tilde ranges become exact versions in `package.json`/`pyproject.toml`.
- **`minimumReleaseAge: 3 days`** (7 for majors) — soak window so a yanked/compromised release is caught before it lands.
- **`vulnerabilityAlerts`** override — CVE fixes skip the soak and automerge.
- **`helpers:pinGitHubActionDigests`** — every `uses:` resolves to a 40-char commit SHA.
- **`pinDigests: true`** for Dockerfiles — base images pinned by `@sha256:` digest.
- **`osvVulnerabilityAlerts`** + **`security:openssf-scorecard`** — extra vuln signal beyond GitHub's native alerts.
