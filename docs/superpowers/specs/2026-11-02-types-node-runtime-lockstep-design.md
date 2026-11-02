# @types/node in step with the Node runtime

Date: 2026-11-02
Status: approved design, not yet implemented

## Problem

`@types/node` and the Node runtime move on two unrelated tracks:

- **Timing.** The runtime (`node` on the docker / node-version datasources)
  uses `versioning: node` (default.json), which counts a major as stable only
  after its LTS start date. `@types/node` uses plain npm versioning, so a new
  major is offered the day DefinitelyTyped publishes it: `@types/node` 25 while
  runtimes sat on 24, and `@types/node` 27 will be offered from April 2027
  while the runtime waits for 2027-10-20.
- **Branches.** Even when both majors are available at once, they open as two
  PRs. On 2026-11-02 youth-activity-scheduler got #620 (`@types/node` 24 → 26,
  ungrouped) and #622 (`toolchain-versions` runtime 24 → 26). Either could merge
  without the other.

Renovate cannot cap one dependency at another dependency's version, so a literal
"`@types/node` major ≤ runtime major" rule is not expressible. The design gets
the same effect from release timing plus branch sharing.

## Fleet state (2026-11-02)

Every repo with `@types/node` is on `26.6.6`, and each one's runtime is on 26:
house-manager, MLB-Deferred-Contract-Calculator, youth-activity-scheduler
(`frontend/`), unifi-network-mcp, unifi-protect-mcp. Nothing is out of step
today; this is for the next LTS line.

## Design

### 1. Rules (node.json, immediately after the `toolchain-versions` rule)

```json
{
  "description": "…",
  "matchDatasources": ["npm"],
  "matchPackageNames": ["@types/node"],
  "versioning": "node"
},
{
  "description": "…",
  "matchDatasources": ["npm"],
  "matchPackageNames": ["@types/node"],
  "matchUpdateTypes": ["major"],
  "groupName": "toolchain-versions"
}
```

- **Rule A (versioning)** applies to every `@types/node` update. Renovate
  resolves versioning before it computes the update type, so this rule cannot
  carry `matchUpdateTypes`; that is why there are two rules.
- **Rule B (grouping)** applies to majors only. Non-major `@types/node` updates
  keep their current branches: `all non-major dependencies` in apps (via
  automerge.json) and `all non-major dev dependencies` in MCP libraries (via
  mcp.json). They keep automerging. Putting them on `toolchain-versions` would
  make them review-gated in `:alpine` repos, where alpine.json gates the node
  image and one non-automergeable upgrade disables automerge for the whole
  branch.
- Both rules set `matchDatasources: ["npm"]` so nothing outside npm can match
  them.
- The `toolchain-versions` rule's description gains a sentence pointing at
  these two rules. alpine.json and docker.json name `node` in mirror lists for
  the Dockerfile image; `@types/node` is never a Dockerfile dep, so those lists
  do not change.

### 2. Behavior a consumer sees

- **Next LTS jump.** Node 27 reaches LTS on 2027-10-20. From that day both the
  runtime major and the `@types/node` 27 major are stable. `default.json` sets
  `separateMultipleMajor: true`, so both get branch
  `renovate/major-27-toolchain-versions`: one PR, with default.json's major
  gate (7-day soak, `automerge: false`, `major-update` / `needs-review`).
- **Before LTS.** `@types/node` 27.x is not offered while v27 has no passed LTS
  date (`isStable('27.0.0')` is false in Renovate 44.199.0).
- **Repo already on the new runtime** (as YAS was after its manual #625): the
  `@types/node` major opens alone on the same branch name. Nothing conflicts.
- **Commit type** is unchanged by this design; the group's existing typing
  applies. Apps: `@types/node` is `deps:` and `toolchain-versions` is `deps:`.
  MCP libraries: `@types/node` is a devDependency, typed `chore:` by mcp.json;
  MCP `toolchain-versions` already mixes `ci:` (annotated lanes) with `chore:`
  (`.nvmrc`, `packageManager`) and is a known, allowed mix in
  `test/commit-types.mjs`. No new knownMixed entry.

### 3. Edge case: a repo on a pre-LTS line

If a repo is on an unstable line under `versioning: node` (for example
`@types/node` 27.x in June 2027), Renovate's `filterVersions` keeps unstable
releases of the current major, because node versioning sets
`allowUnstableMajorUpgrades: true`. Its patches keep flowing, and stable
releases of later majors are offered as usual. No freeze. Recorded in Rule A's
description so nobody "fixes" it.

## Testing

1. **`test/commit-types.mjs`**, which already runs an app and an MCP consumer
   through the real preset resolver and `applyPackageRules`:
   - app: `@types/node` devDependency **major** → `toolchain-versions`, `deps`.
   - app: `@types/node` devDependency **patch** → `all non-major dependencies`,
     `deps` (new case).
   - MCP: `@types/node` devDependency **major** → `toolchain-versions`, `chore`.
   - MCP: the existing `@types/node` patch case still → `all non-major dev
     dependencies`, `chore`.
   - each `@types/node` case also asserts the resolved `versioning` is `node`.
     This needs the case table to accept an expected `versioning`, which it
     does not today.
   - Mutation check: drop Rule A, then Rule B, and confirm the test fails each
     time; restore.
2. **Validator:** `renovate-config-validator --strict` over all nine presets.
3. **Dry-run fixture** (CLAUDE.md: prove before merge). A scratch repo
   extending the presets at `#feat/types-node-runtime-lockstep`, with
   `package.json` pinning `@types/node` 24.x and `engines.node` 24.x, `.nvmrc`
   24.x, plus one unrelated dependency. Expected: `node` and `@types/node`
   26 majors both map to `renovate/major-26-toolchain-versions`. Control run
   without the `#branch` suffix: `@types/node` lands on its own branch. Use
   `--platform=local` (lookup-level, which is enough: branch mapping is the
   assertion).

## Not in scope

- A lane cap for `@types/node`: no repo annotates it.
- Making MCP libraries track their oldest supported Node (22) for types. Both
  typecheck against 26 and run tests on 22/24/26 in CI.
- Grouping other `@types/*` packages with their runtime packages; that is
  node.json's per-ecosystem groups' job.
