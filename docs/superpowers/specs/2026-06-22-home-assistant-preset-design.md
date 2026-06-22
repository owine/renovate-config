# Home Assistant preset (`home-assistant.json`) — design

Date: 2026-06-22
Status: Approved

## Problem

Two `owine/*` repos build Home Assistant add-on images:
`ha-hetrixtools-agent` and `claude-terminal-home-assistant`. Both carry the
**same two byte-identical `packageRules`** in their own `renovate.json`:

1. **HA base image** (`ghcr.io/home-assistant/base`) — `pinDigests: true` +
   `versioning: loose`, so the base is pinned to a versioned tag with a digest
   that Renovate keeps fresh.
2. **`home-assistant/builder`** GitHub Action — a `regex` versioning override
   because the action ships CalVer tags (`YYYY.MM.PATCH`) the default
   `github-actions` versioning can't parse.

This duplication should be a reusable preset so HA add-on repos get it by
extending one line instead of copy-pasting, matching the existing
one-preset-per-ecosystem pattern (`node`, `python`, `docker`, `alpine`, `mcp`).

A second, related gap surfaced while designing this. Both Dockerfiles pin
`ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24@sha256:…` — **the base image
tag is the Alpine release line** (`3.24`). A version bump is therefore always a
*minor* bump (`3.23 → 3.24`; there is no patch component), and it shifts the
underlying Alpine line. That is the exact coupling that forces a hand-edit of
the consumer's repology `customManager` `depNameTemplate` (`alpine_3_24/` →
`alpine_3_25/`). Today the HA base rule only pins digests, so a base version
bump rides `docker.json`'s "dockerfile bases" group plus `automerge.json`'s
bundle and **automerges** — silently leaving the repology template pointing at
the wrong Alpine line. The preset should close this by gating base-image minor
bumps to manual review, mirroring `alpine.json`'s base-image rule.

## Goals

- Ship `home-assistant.json`: a `packageRules`-only preset with three rules —
  the two lifted HA rules plus a new minor-gate on the HA base image.
- Migrate both consumer repos to extend `:home-assistant` and delete their
  duplicated HA `packageRules` (keeping all repo-specific config).
- Document the preset and its ordering requirement in the README.

## Non-goals

- Touching the consumer-side repology apk `customManager`. Its
  `depNameTemplate` hardcodes the Alpine version (`alpine_3_24/{{package}}`),
  which is repo-specific; it stays consumer-side. The new minor-gate exists
  precisely to force a human to update it on a base bump.
- Migrating the app-specific managers (hetrixtools vendored agent; Claude Code
  datasource/customManager/automerge; the generic ARG + shell-script managers;
  `vulnerabilityAlerts` overrides). These are not HA-specific and stay in their
  repos.
- Adopting `:home-assistant` in any other repo — only these two build HA images.

## Design

### `home-assistant.json`

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "description": "Home Assistant add-on repos. HA base image (ghcr.io/home-assistant/base) is pinned to a versioned tag + digest; minor base bumps are gated to manual review because the tag is the Alpine release line, so a bump means hand-editing the consumer's repology alpine_X_Y/ depNameTemplate. The home-assistant/builder action uses CalVer (YYYY.MM.PATCH). Extend AFTER automerge.json and docker.json (and alpine.json if used).",
  "packageRules": [
    {
      "description": "Home Assistant base image — pin to a versioned tag with digest; Renovate keeps the digest updated. The tag is the Alpine release line (e.g. 3.24).",
      "matchDatasources": ["docker"],
      "matchPackageNames": ["ghcr.io/home-assistant/base"],
      "pinDigests": true,
      "versioning": "loose"
    },
    {
      "description": "HA base image version bumps cross the Alpine release line (e.g. 3.23 -> 3.24), which requires hand-editing the consumer's repology depNameTemplate (alpine_X_Y/). Gate minor to manual review; never automerge. Digest-only rebuilds still automerge via the non-major group.",
      "matchDatasources": ["docker"],
      "matchPackageNames": ["ghcr.io/home-assistant/base"],
      "matchUpdateTypes": ["minor"],
      "groupName": "home assistant base image",
      "automerge": false,
      "addLabels": ["needs-review"]
    },
    {
      "description": "home-assistant/builder uses CalVer (YYYY.MM.PATCH); the default github-actions versioning can't parse it",
      "matchManagers": ["github-actions"],
      "matchPackageNames": ["home-assistant/builder"],
      "versioning": "regex:^(?<major>\\d{4})\\.(?<minor>\\d{2})\\.(?<patch>\\d+)$"
    }
  ]
}
```

### Behavior and ordering

- Consumers extend `github>owine/renovate-config:home-assistant` **after**
  `:automerge` and `:docker`. Renovate applies `packageRules` in order and the
  last match wins, so the minor-gate rule must load after `docker.json`'s
  "dockerfile bases" group and `automerge.json`'s "all non-major dependencies"
  bundle to win over their automerge. This is the same composition mechanic
  `:alpine` and `:mcp` use to carve packages out of the prior catch-all.
- HA base **digest-only** rebuilds (same `3.24` tag, new `sha256`) are a
  `digest` update, are not matched by the minor-gate, and automerge.
- HA base **minor** bumps (`3.24 → 3.25`) become a separate `needs-review` PR
  in the "home assistant base image" group, prompting the `alpine_X_Y/`
  hand-edit. There is no patch component in the tag, so the minor gate covers
  every real version bump.
- HA base **major** bumps (`3 → 4`) fall through to `default.json`'s major rule
  (7-day soak, `automerge: false`, `needs-review`).
- The builder rule only sets `versioning`; the action's digest pin and bump
  cadence are otherwise handled by the baseline + `docker.json`.

### Consumer changes

- **`ha-hetrixtools-agent`** (`renovate.json`): add
  `"github>owine/renovate-config:home-assistant"` to `extends` (after
  `:docker`); delete its HA base-image and `home-assistant/builder`
  `packageRules`. Keep the hetrixtools-agent vendored-version `customManager`.
- **`claude-terminal-home-assistant`** (`renovate.json`): same `extends`
  addition; delete the same two `packageRules`. Keep the Claude Code datasource,
  customManagers, repology apk manager, and `vulnerabilityAlerts` override.

### README

- Add a `home-assistant.json` row to the presets table.
- Add a consumer note: opt-in for HA add-on repos; extend after `:docker`;
  base-image minor bumps are review-gated for the `alpine_X_Y/` reason.
- Update the preset-ordering guidance to mention `:home-assistant` loads late
  (like `:alpine`).

## Validation

`renovate-config-validator --strict` (via the pinned
`ghcr.io/renovatebot/renovate` engine in `.github/workflows/validate.yml`) over
`home-assistant.json` plus the existing presets, and over each migrated consumer
`renovate.json`. Add `home-assistant.json` to the validate workflow's file list.
