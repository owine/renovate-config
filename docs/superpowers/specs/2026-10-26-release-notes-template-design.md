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
  ungrouped in Bug Fixes. Hard-coding `deps:` drops any scope from a grouped
  title; harmless because `default.json` sets no `semanticCommitScope`, so
  Renovate titles have none. Revisit both templates if that changes.
- Dependencies `collapse-after: 5` (was 10). Grouped entries count once.
- `template`:

  ```
  $CHANGES

  **Full changelog:** [$PREVIOUS_TAG...$RESOLVED_TAG](https://github.com/$OWNER/$REPOSITORY/compare/$PREVIOUS_TAG...$RESOLVED_TAG)
  ```

  `no-changes-template` is unchanged (`_No user-facing changes._`).
  `$PREVIOUS_TAG` is empty when a repo has no previous release, which breaks
  the link; every consumer has releases today, and onboarding already cuts a
  first release by hand before adding release-drafter.

### 2. Summary line (per-repo workflow step)

Each repo's `.github/workflows/release-drafter.yml` keeps its own job and gains
one step after release-drafter. Wiring:

- The release-drafter step gets `id: draft` (nut-cgi's has none today).
- The new step is `actions/github-script` (SHA-pinned), guarded by
  `if: steps.draft.outputs.id != ''` (a `dry-run` leaves no `id`).
- The body arrives through `env: { BODY: ${{ steps.draft.outputs.body }} }`
  and is read as `process.env.BODY`. Never interpolate `${{ }}` into
  `script:`: PR titles with backticks or `${` would break the JS, and it is an
  injection path. The id arrives the same way (`RELEASE_ID`).

The script:

1. counts entries per `## ` section (lines starting `- `, including those
   inside `<details>`), plus entries before the first heading as "other", and
   **stops at the `**Full changelog:**` line** so footer content (the MCP
   block) is never counted;
2. returns without writing if the total is 0. (The body is never exactly the
   no-changes template, because the compare line and footer follow it.)
3. renders one line, in this order, singular/plural as needed, joined with
   ` · `, omitting zero counts:
   breaking change(s), feature(s), bug fix(es), performance improvement(s),
   revert(s), dependency update(s), other change(s);
   e.g. `**1 bug fix · 4 dependency updates**`;
4. fetches the release with `github.rest.repos.getRelease({ ...context.repo,
   release_id: Number(process.env.RELEASE_ID) })` and returns unless
   `draft` is true (it may have been published between the two steps);
5. writes `<line>\n\n<body>` back with `github.rest.repos.updateRelease`
   (same `release_id`), sending `tag_name: release.tag_name` from step 4's
   read. A PATCH without `tag_name` drops a draft's tag: GitHub resets it to
   `untagged-<hash>` and keeps the name, target and body. release-drafter then
   finds no draft with its tag prefix and creates a new one on every run. v1
   omitted it, and the nut-cgi pilot (#130) ended with two untagged `v1.10.2`
   drafts; v2 sends it.

Form: `scripts/release-summary.js` is written as the body of an
`actions/github-script` inline `script:`, which runs as an async function
with `github`, `context` and `core` in scope and allows top-level
`await`/`return`. Detect the stop line with `startsWith('**Full changelog:**')`.
`test/release-summary.mjs` reads the file and runs it the same way,
`new AsyncFunction('github', 'context', 'core', 'process', src)`, with a mock
octokit that records `updateRelease` calls and a fake `process.env`. A
`dry-run` has no release id, so render checks outside a real draft run the
script locally with those mocks.

Idempotent, with one condition: release-drafter rewrites the body from scratch
on every run, so the line never stacks, but the draft itself is only kept if
the write carries `tag_name` (step 5). Without it, each run's PATCH orphans
the draft it just summarized. A single run can't show this: the first run
looks right, and the second one creates the duplicate. Consumers run with
`cancel-in-progress: true`, so a run cancelled between the two steps leaves
that draft without a summary until the next push; harmless.

The canonical script is `scripts/release-summary.js` in renovate-config,
covered by `test/release-summary.mjs`. It starts with the marker comment
`// owine/renovate-config scripts/release-summary.js v2` (v1 dropped the tag,
step 5); each repo's step carries an identical copy including that line, so
drift is one `grep -r 'release-summary.js v'` across the fleet. Bump the version on every
change. renovate-config never runs the script in a workflow.

Optional highlight: when publishing, the human may add a sentence above the
summary line. The step never writes to a published release, so it persists.

### 3. Per-repo footer (`.github/release-drafter.yml`)

Each repo sets `footer:`, which overrides nothing shared (the base has none).
release-drafter appends the footer directly after the template's trailing
newline, so every `footer: |` starts with an empty line (truly empty: no
spaces beyond the block's indentation, or the YAML won't parse). Every
footer opens with a `### Use this release` heading.

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
- delete `<details>`, `</details>` and `<summary>…</summary>` lines
  (release-drafter puts each on its own line);
- delete the `**Full changelog:**` line (each CHANGELOG heading already links
  the compare view);
- keep emoji headings and the summary line (shown in HA's changelog view).

Replace the existing `\(#N\)` link rule with this, and squeeze the blank
lines the deletions leave (`| cat -s`). Tested on both an old-format and a
new-format body; a `#12` inside a title is left alone:

```sh
sed -E -e 's/^(#+ )/#\1/' \
  -e '/^<\/?details>$/d' -e '/^<summary>.*<\/summary>$/d' \
  -e '/^\*\*Full changelog:\*\*/d' \
  -e '/^- .*\(#[0-9]+(, #[0-9]+)*\)$/{' -e ':a' \
  -e 's@([(]|, )#([0-9]+)((, #[0-9]+)*\))$@\1[#\2](https://github.com/'"$REPO"'/issues/\2)\3@' \
  -e 'ta' -e '}' | cat -s
```

The link rule uses `@` as its delimiter on purpose: `$REPO` is
`owner/name`, and its `/` would end a `s/…/…/` early. It is anchored to the
entry's trailing number list (`((, #N)*\))$`), so a `(#12)` inside a title is
left alone too; claude-terminal #477 tightened it to this during review, and
that merged `promote` is the canonical copy hetrixtools ports. The transform
runs inside `body=$(…)` there, so `$(…)` also trims the blank line left when
the compare line, the body's last, is deleted.

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
  singular vs plural. The mock `getRelease` returns a tag, and every
  `updateRelease` must carry that `tag_name`, for a `v…`, a prefixed and a
  bare tag.
- `promote`: run the script locally against an old-format and a new-format
  body (grouped numbers, `<details>`, compare line, summary), as #467 did.
- nut-cgi pilot: `workflow_dispatch`; because its draft is currently empty,
  also replay an old release range with `dry-run: true` and run the summary
  script locally (the test's mocks) on that would-be body to see a full
  render. A dry run has no release id, so the workflow step skips itself.
- Replay recipe (from the pilot). To render release `vB` (previous tag `vA`),
  push a scratch branch whose release-drafter step has:

  ```yaml
  with:
    commitish: refs/tags/vB
    from: vA
    filter-by-range: '<A+1'   # e.g. '<1.10.1' when vA is v1.10.0
    dry-run: true
  ```

  `from` only sets the comparison baseline. `filter-by-range` restricts which
  published releases count as "the last release", so `$PREVIOUS_TAG` (and the
  compare line) resolves to `vA` instead of the latest release. Give the
  scratch workflow its own `concurrency.group` (e.g. `release-drafter-replay`)
  so it can't cancel a run on `main`. Delete the branch unmerged.
- Any change to the summary step: a single run proves nothing, because the
  duplicate only appears on the next run. Dispatch release-drafter twice in a
  row; `gh release list` must then show exactly one draft, tagged with the
  repo's prefix (`v…`, `hetrixtools-agent-v…`, bare `X.Y.Z`).

## Out of scope

- Image digests in Docker footers (unknown until the retag at publish).
- Contributors / author lists (single-maintainer fleet plus bots).
- A shared reusable workflow (considered; per-repo workflows kept by choice).
