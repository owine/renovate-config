# Alpine apk preset (`alpine.json`) — design

Date: 2026-05-19
Status: Approved

## Problem

`owine/*` repos that build Alpine-based container images pin apk packages
(`package=version`) in their Dockerfiles. The `claude-terminal-home-assistant`
repo already handles these well: a consumer-side `customManager` regex surfaces
each pin as a Renovate dependency with `datasource: repology`, and a
`packageRule` drops `minimumReleaseAge` to 0 so routine apk bumps aren't held
behind the global 3-day soak.

This pattern is good practice and should be a reusable preset in
`owine/renovate-config` so other Alpine-image repos get it by extending one
line instead of copy-pasting the rule.

## Goals

- Ship `alpine.json`: a single `packageRule` that, for `repology`-datasource
  deps, groups them, removes the release soak, runs off the weekly schedule,
  and automerges non-major updates.
- Document the downstream-consumer considerations, decisions, and caveats in
  the README so adopters understand what the preset does *not* do and what they
  remain responsible for.

## Non-goals

- Shipping the `customManager` regex that detects apk pins in Dockerfiles. Its
  `depNameTemplate` hardcodes the Alpine version (`alpine_3_23/{{package}}`),
  which is repo-specific and changes when the base image's Alpine version
  changes. Bundling a repo-specific knob into a shared preset is a sharp edge;
  it stays consumer-side. (Considered and rejected: a parametrized manager —
  more design surface than the value justifies right now. YAGNI.)
- Touching the existing `claude-terminal-home-assistant` config. Migrating it to
  consume `:alpine` is a separate follow-up for that repo.

## Design

### `alpine.json`

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

### Behavior and ordering

- Consumers extend `github>owine/renovate-config:alpine` **after**
  `:automerge`. Renovate applies `packageRules` in order, last match wins, so
  Repology deps leave `automerge.json`'s "all non-major dependencies" bundle
  and form their own "alpine packages" group. This is the same composition
  mechanic `mcp.json` uses to carve out `@modelcontextprotocol/sdk`.
- Per-rule `schedule: ["at any time"]` overrides the top-level
  `["on monday"]` for matched packages only — the same lever
  `default.json`'s `vulnerabilityAlerts` uses to fast-track CVEs without
  changing the global weekly cadence.
- Per-rule `minimumReleaseAge: "0 days"` overrides the global 3-day soak for
  Repology deps only.
- `matchUpdateTypes` deliberately excludes `major`. Major bumps fall through to
  `default.json`'s major rule (7-day soak, `automerge: false`,
  `needs-review`). In practice Repology rarely classifies an apk bump as major,
  so nearly all apk updates flow through this rule; the exclusion exists to
  preserve the baseline's major-review invariant rather than to handle a common
  case.

### Documentation changes (README.md)

1. **Usage block** — add `"github>owine/renovate-config:alpine"` to the
   `extends` example, and a sentence: extend `:alpine` *after* `:automerge`.

2. **Presets table** — new row:

   | `alpine.json` | Alpine apk packages (Repology datasource): own group, 0-day soak, runs any time, automerges non-major. Carved out of `automerge.json`'s bundle — extend after it. **Requires a consumer-side customManager** (see Consumer notes). |

3. **New "Consumer notes & caveats" section** (after Supply-chain posture):
   - `alpine.json` is packageRules-only. It acts only on deps already
     classified `datasource: repology`. The consumer repo must define its own
     `customManager` regex to detect `pkg=version` apk pins in its Dockerfile
     and template `datasource=repology`,
     `depName=alpine_3_XX/{{package}}`. A reference regex is included.
   - The Alpine version in `depNameTemplate` is repo-specific and unmanaged.
     When a repo bumps its Alpine base image (`3.23` → `3.24`), it must
     hand-edit `alpine_3_23/` → `alpine_3_24/` in its own customManager, or
     Repology lookups silently return no updates. This is precisely why the
     manager is not in the shared preset.
   - Preset ordering is load-bearing: `:automerge`, then `:mcp` (after
     `:node`), then `:alpine`. Each later preset peels its packages out of the
     prior catch-all group; wrong order leaves packages mis-grouped.
   - Major apk bumps fall through to `default.json` (7-day soak, manual
     review); rare in practice.

## Testing / validation

- `renovate-config-validator` (or the repo's existing JSON-schema check, if
  any) must pass for `alpine.json`.
- Manual review confirming the rule shape matches the proven
  `claude-terminal-home-assistant` behavior, minus the manager.

## Rollout

1. Land `alpine.json` + README edits in `owine/renovate-config`.
2. (Follow-up, separate change in that repo) Migrate
   `claude-terminal-home-assistant` to `extends: [..., ":alpine"]` and delete
   its inline Repology `packageRule`, keeping its customManager.
