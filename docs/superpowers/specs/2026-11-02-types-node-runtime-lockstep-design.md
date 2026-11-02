# @types/node in step with the Node runtime

Date: 2026-11-02
Status: approved design, not yet implemented

## Problem

`@types/node` and the Node runtime major arrive on the same day but open as
two PRs. On 2026-11-02 youth-activity-scheduler got #620 (`@types/node`
24 → 26, ungrouped) and #622 (`toolchain-versions`, runtime 24 → 26). Either
could merge without the other.

Timing is already handled, by a Renovate built-in rather than by this repo.
`config:best-practices` → `config:recommended` → `workarounds:all` includes
`workarounds:typesNodeVersioning`
(`{ matchManagers: ["npm"], matchPackageNames: ["@types/node"], versioning: "node" }`),
so `@types/node` uses the same LTS-date stability as the runtime (default.json's
`versioning: node` rule for `node`). A major is offered only once its line's LTS
start date has passed. That is why #620 went 24 → 26 and never offered 25. Only
the branch split needs fixing.

Renovate cannot cap one dependency at another dependency's version, so a literal
"`@types/node` major ≤ runtime major" rule is not expressible. Same-day
availability (the built-in) plus a shared branch (this design) gets the same
effect.

## Fleet state (2026-11-02)

Every repo with `@types/node` is on `26.6.6`, and each one's runtime is on 26:
house-manager, MLB-Deferred-Contract-Calculator, youth-activity-scheduler
(`frontend/`), unifi-network-mcp, unifi-protect-mcp. Nothing is out of step
today; this is for the next LTS line.

## Design

### 1. Rule (node.json, immediately after the `toolchain-versions` rule)

```json
{
  "description": "…",
  "matchDatasources": ["npm"],
  "matchPackageNames": ["@types/node"],
  "matchUpdateTypes": ["major"],
  "groupName": "toolchain-versions"
}
```

- **Majors only.** Non-major `@types/node` updates keep their current branches:
  `all non-major dependencies` in apps (via automerge.json) and `all non-major
  dev dependencies` in MCP libraries (via mcp.json). They keep automerging.
  Putting them on `toolchain-versions` would make them review-gated in
  `:alpine` repos, where alpine.json gates the node image and one
  non-automergeable upgrade disables automerge for the whole branch.
- `matchDatasources: ["npm"]` keeps the rule off anything outside npm.
- The rule's description says it relies on the built-in
  `workarounds:typesNodeVersioning` for timing, and records the edge case in
  §3.
- The `toolchain-versions` rule's description gains one sentence pointing at
  this rule. alpine.json and docker.json name `node` in mirror lists for the
  Dockerfile image; `@types/node` is never a Dockerfile dep, so those lists do
  not change.
- Verified against 44.199.0: no preset extended after node.json overrides this
  groupName for a major. The automerge.json and mcp.json groups are
  patch/minor/digest only; docker.json's runtime major rule only adds labels
  and does not match `@types/node`; python.json, alpine.json and
  home-assistant.json are scoped by manager or datasource. Only the
  `vulnerabilityAlerts` force rule beats it, which is intended.

### 2. Behavior a consumer sees

- **Next LTS jump.** Node 27 reaches LTS on 2027-10-20. From that day both the
  runtime major and the `@types/node` 27 major are stable. `default.json` sets
  `separateMultipleMajor: true`, and Renovate's branch name for a grouped major
  is `major-${newMajor}-${groupSlug}`, so both get
  `renovate/major-27-toolchain-versions`: one PR, with default.json's major
  gate (7-day soak, `automerge: false`, `major-update` / `needs-review`).
- **Repo already on the new runtime** (as YAS was after its manual #625): the
  `@types/node` major opens alone on the same branch name. Nothing conflicts.
- **Commit type** is unchanged by this design; the group's existing typing
  applies. Apps: `@types/node` is `deps:`, and app `toolchain-versions` is
  already a known `deps` + `ci` mix. MCP libraries: `@types/node` is a
  devDependency, typed `chore:` by mcp.json; MCP `toolchain-versions` is
  already a known `chore` + `deps` + `ci` mix in `test/commit-types.mjs`. No new
  knownMixed entry.

### 3. Edge case: a repo on a pre-LTS line

If a repo is on an unstable line under `versioning: node` (for example
`@types/node` 27.x in June 2027), Renovate's `filterVersions` keeps unstable
releases of the current major, because node versioning sets
`allowUnstableMajorUpgrades: true`. Its patches keep flowing, and stable
releases of later majors are offered as usual. No freeze. Recorded in the
rule's description so nobody "fixes" it.

### 4. Test harness fix (`test/commit-types.mjs`)

Line 152 reads `(await resolveConfigPresets({ extends: defaults.extends })).packageRules`.
In 44.199.0 `resolveConfigPresets` returns `{ config, visitedPresets }`, so
that is `undefined` and `builtin` is `[]`: every built-in rule (~750), including the
`:semanticPrefixFixDepsChoreOthers` `* → chore` rule the comment above it says
it loads, have been silently missing.

- Read `.config.packageRules` instead.
- If the resolved built-in list is empty, exit `2` with a message saying the
  Renovate dist's `resolveConfigPresets` shape changed. This is the repo's
  existing "couldn't bind" convention (CLAUDE.md, Tests), and it stops a future
  shape change from silently dropping the built-ins again.
- This is its own step in the plan, before the new cases, so the diff shows the
  existing 73 checks still pass with the built-ins loaded.

## Testing

1. **Harness fix first** (§4). Run the test; all existing checks must pass with
   the built-ins loaded. Then mutate the access back to `.packageRules` and
   confirm exit 2.
2. **New cases in `test/commit-types.mjs`:**
   - app: `@types/node` devDependency **major** → `toolchain-versions`, `deps`.
   - app: `@types/node` devDependency **patch** → `all non-major dependencies`,
     `deps`.
   - MCP: `@types/node` devDependency **major** → `toolchain-versions`, `chore`.
   - MCP: the existing `@types/node` patch case still → `all non-major dev
     dependencies`, `chore`.
   - A structural check that the resolved built-ins still contain a rule giving
     npm `@types/node` `versioning: node`, so a Renovate release that drops
     `workarounds:typesNodeVersioning` fails loudly (this design depends on it).
   - Mutation check: remove the new node.json rule and confirm the two major
     cases fail; restore.
3. **Validator:** `renovate-config-validator --strict` over all nine presets.
4. **Dry-run fixture** (CLAUDE.md: prove before merge). A scratch repo
   extending the presets at `#feat/types-node-runtime-lockstep`, with
   `package.json` pinning `@types/node` 24.x and `engines.node` 24.x, `.nvmrc`
   24.x, plus one unrelated dependency. Expected: `node` and `@types/node` 26
   majors both map to `renovate/major-26-toolchain-versions`. Control run
   without the `#branch` suffix: `@types/node` lands on its own branch. Use
   `--platform=local` (lookup-level, which is enough: branch mapping is the
   assertion). Assert the branch name, not the exact `@types/node` version:
   the 7-day major soak may select an older 26.x.

## Not in scope

- A fleet copy of `workarounds:typesNodeVersioning`: the built-in already does
  it; the structural check in Testing §2 guards against its removal.
- A lane cap for `@types/node`: no repo annotates it.
- Making MCP libraries track their oldest supported Node (22) for types. Both
  typecheck against 26 and run tests on 22/24/26 in CI.
- Grouping other `@types/*` packages with their runtime packages; that is
  node.json's per-ecosystem groups' job.
