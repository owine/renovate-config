# Release notes template: polish, grouping, summary, install footers

Date: 2026-10-26
Status: approved design, not yet implemented

## Goal

Make the release-drafter release notes for the ten consumer repos more useful
to read: section emoji, one line per dependency instead of one per bump, a
count summary at the top, a compare link at the bottom, and a per-repo
"use this release" footer.

## Consumers and their shapes

| Shape | Repos | Body also feeds |
|---|---|---|
| npm library | unifi-network-mcp, unifi-protect-mcp | – |
| HA add-on | claude-terminal-home-assistant, ha-hetrixtools-agent | CHANGELOG.md via the `promote` job |
| Docker, retagged | doc-scanner, house-manager, trip-tracker, youth-activity-scheduler | – |
| Docker, rebuilt | MLB-Deferred-Contract-Calculator, nut-cgi | – |

All ten `_extends: owine/renovate-config:/release-drafter.yml` from the default
branch, so a change to the shared config reaches every draft on that repo's
next push to `main`.

## Design

### 1. Shared config (`release-drafter.yml`)

- Category titles: `💥 Breaking Changes`, `✨ Features`, `🐛 Bug Fixes`,
  `⚡ Performance`, `⏪ Reverts`, `📦 Dependencies`. Matching rules,
  `exclusive`, `semver-increment` and the pre-exclude are unchanged.
- `change-template: '- $TITLE ($NUMBERS)'`. For an ungrouped entry `$NUMBERS`
  is `#123`, so single entries render exactly as today.
- `group-changes`, matched against the raw PR title (before replacers):
  1. `/^deps(?:\([^)]*\))?: update (?<group>.+?) to (?<to>\S+)$/`, with
     `title-template: 'deps: update $GROUP to $LAST_TO'`. Covers
     `update pnpm to v12.3.5`, `update dependency lucide-react to v1.58.0`,
     `update curl apk package to v8.17.0-r0`, `update … docker digest to abc1234`.
  2. `/^deps(?:\([^)]*\))?: (?<group>update .+)$/`, with
     `title-template: 'deps: $GROUP'`. Covers Renovate group branches with no
     version: `update all non-major dependencies`, `update toolchain-versions`.
  Titles keep their `deps:` prefix so the existing `change-title` replacers
  still strip it. `fix: … [security]` titles match neither rule and stay
  ungrouped in Bug Fixes.
- Dependencies `collapse-after: 5` (was 10). Grouped entries count once.
- `template`:

  ```
  $CHANGES

  **Full changelog:** [$PREVIOUS_TAG...$RESOLVED_TAG](https://github.com/$OWNER/$REPOSITORY/compare/$PREVIOUS_TAG...$RESOLVED_TAG)
  ```

  `no-changes-template` is unchanged (`_No user-facing changes._`).

### 2. Summary line (per-repo workflow step)

Each repo's `.github/workflows/release-drafter.yml` keeps its own job and gains
one step after release-drafter: an `actions/github-script` step (SHA-pinned)
that

1. reads the release-drafter step's `id` and `body` outputs;
2. returns early if the body is the no-changes template;
3. counts entries per `## ` section (lines starting `- `, including those
   inside `<details>`), plus entries before the first heading as "other";
4. renders one line, in this order, singular/plural as needed, joined with
   ` · `, omitting zero counts:
   breaking change(s), feature(s), bug fix(es), performance improvement(s),
   revert(s), dependency update(s), other change(s);
   e.g. `**1 bug fix · 4 dependency updates**`;
5. writes `<line>\n\n<body>` back with `repos.updateRelease`.

Idempotent: release-drafter rewrites the body from scratch on every run, so
the line never stacks. The job's existing `concurrency: release-drafter` keeps
two runs from interleaving.

The canonical script is `scripts/release-summary.js` in renovate-config,
covered by `test/release-summary.mjs`. Each repo's step carries an identical
copy with a comment naming its source (`owine/renovate-config
scripts/release-summary.js`). renovate-config never runs it in a workflow.

Optional highlight: when publishing, the human may add a sentence above the
summary line. Published releases are never rewritten, so it persists.

### 3. Per-repo footer (`.github/release-drafter.yml`)

Each repo sets `footer:`, which overrides nothing shared (the base has none).

- Docker, retagged and MLB: a `sh` block with
  `docker pull ghcr.io/owine/<image>:$RESOLVED_VERSION`.
- nut-cgi: `docker pull ghcr.io/owine/nut-cgi:v$RESOLVED_VERSION` (its image
  tags keep the `v`).
- npm MCPs: a `### Use this release` heading, a `json` MCP client config with
  `"args": ["-y", "@owine/<pkg>@$RESOLVED_VERSION"]` and only the required env
  (`*_HOST`, `*_API_KEY`), then one line linking the README for optional
  settings.
- HA add-ons: no footer. Home Assistant offers its own update.

trip-tracker's image is private; the pull line assumes GHCR login.

### 4. HA add-on `promote` (CHANGELOG.md)

`claude-terminal-home-assistant` `publish.yml` and `ha-hetrixtools-agent`
`build.yaml` transform the body before prepending it. Extend that transform to
accept both the current and the new body:

- link every `#N` inside a parenthesised list, so `(#486, #490)` becomes two
  links, not just a lone `(#123)`;
- delete `<details>`, `</details>` and `<summary>…</summary>` lines;
- delete the `**Full changelog:**` line (each CHANGELOG heading already links
  the compare view);
- keep emoji headings and the summary line (shown in HA's changelog view).

## Rollout

Order is load-bearing: the shared config goes live everywhere on merge.

1. HA `promote` changes: claude-terminal, then hetrixtools (port). Backward
   compatible, so safe before step 2.
2. renovate-config: shared config, `scripts/release-summary.js`, tests,
   README (consumer section and rendered example).
3. nut-cgi pilot: summary step and footer.
4. The other nine repos: summary step and footer, one PR each.

Held drafts (claude-terminal v2.11.3, both MCPs' 3.0.1) re-render on their
repos' next push.

## Testing

- `test/release-drafter.mjs`: update expected category titles; add the two
  `group-changes` patterns checked against one fixture title per observed
  Renovate shape (versioned, dependency-prefixed, apk, docker digest, group
  branch, `[security]` fix that must not group).
- `test/release-summary.mjs` (new, plain node, no dependencies): runs
  `scripts/release-summary.js` on fixture bodies: no-changes, single fix,
  mixed sections, collapsed `<details>` dependencies, uncategorized entries,
  singular vs plural.
- `promote`: run the script locally against an old-format and a new-format
  body (grouped numbers, `<details>`, compare line, summary), as #467 did.
- nut-cgi pilot: `workflow_dispatch`; because its draft is currently empty,
  also replay an old release range with `dry-run: true` and run the summary
  script on that output to see a full render.

## Out of scope

- Image digests in Docker footers (unknown until the retag at publish).
- Contributors / author lists (single-maintainer fleet plus bots).
- A shared reusable workflow (considered; per-repo workflows kept by choice).
