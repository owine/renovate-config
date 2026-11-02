# @types/node in step with the Node runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an `@types/node` major open on the same PR as the Node runtime major (`renovate/major-NN-toolchain-versions`), and fix `test/commit-types.mjs` so it actually loads Renovate's built-in rules.

**Architecture:** One new `packageRules` entry in `node.json` sends npm `@types/node` **majors** to the existing `toolchain-versions` group. Timing already matches the runtime through Renovate's built-in `workarounds:typesNodeVersioning` (`versioning: node`), so no versioning rule is added. The test harness currently drops every built-in rule (`resolveConfigPresets` returns `{ config, visitedPresets }`, the test reads `.packageRules`), so it is fixed first, then guarded, then extended.

**Tech Stack:** Renovate JSON presets; Node ESM tests importing the Renovate dist (`RENOVATE_DIST`); `renovate-config-validator`; `renovate --platform=local` dry run.

**Spec:** `docs/superpowers/specs/2026-11-02-types-node-runtime-lockstep-design.md`

**Branch:** `feat/types-node-runtime-lockstep` (already exists; the spec is committed on it).

---

## Conventions for every task

- Repo root: `/Users/owine/Git/renovate-config`. Run all commands from there.
- `RENOVATE_DIST` for local runs (Homebrew install, same major as CI's image):
  `export RENOVATE_DIST=/opt/homebrew/Cellar/renovate/44.199.0/libexec/lib/node_modules/renovate/dist`
- The shell prints an `fnm` warning and sometimes `error: Requested version v24.22.2 is not currently installed` before every command. It is noise from the repo's `.nvmrc`; ignore it. `node` itself still runs.
- Test exit codes (CLAUDE.md): `0` pass, `1` behavior regression, `2` the test could not bind to Renovate's dist.
- Validator command (all nine presets; ignore the `re2` stack trace it prints, it ends with `Config validated successfully`):
  ```sh
  renovate-config-validator --strict renovate.json default.json automerge.json \
    node.json python.json docker.json mcp.json alpine.json home-assistant.json
  ```
- Edit JSON with an exact-string editor, not `sed`. Keep 2-space indentation and one rule object per `{ … }` block, matching the file.

## File map

| File | Change | Responsibility |
|---|---|---|
| `test/commit-types.mjs:145-153` | Modify | Load built-in rules via `.config.packageRules`; exit 2 if empty |
| `test/commit-types.mjs` (after line 153) | Add | Guard: built-ins still give npm `@types/node` `versioning: node` |
| `test/commit-types.mjs` app + mcp `cases` | Add | Three `@types/node` routing cases |
| `node.json` (after the `toolchain-versions` rule, line 218-219) | Add | The `@types/node` majors → `toolchain-versions` rule |
| `node.json` `toolchain-versions` description (line ~216) | Modify | One sentence pointing at the new rule |
| `README.md:32`, `README.md:116` | Modify | Presets table mention; test description mentions built-ins |

---

### Task 1: Load the built-in rules in `test/commit-types.mjs`

**Files:**
- Modify: `test/commit-types.mjs:145-153`

- [ ] **Step 1: Record the baseline**

Run: `node test/commit-types.mjs | tail -1`
Expected: `73 checks passed against Renovate at …` (exit 0). Note the number; it is the count with built-ins silently missing.

- [ ] **Step 2: Prove the bug**

Run:
```sh
node --input-type=module -e "
const { resolveConfigPresets } = await import(process.env.RENOVATE_DIST + '/config/presets/index.js');
const { init } = await import(process.env.RENOVATE_DIST + '/logger/index.js'); await init();
const r = await resolveConfigPresets({ extends: ['config:best-practices'] });
console.log(Object.keys(r), r.packageRules, r.config.packageRules.length);
" 2>&1 | tail -1
```
Expected: `[ 'config', 'visitedPresets' ] undefined 7xx` (about 750 rules).

- [ ] **Step 3: Replace lines 145-153**

Replace this block:
```js
// ---------------------------------------------------------------------------
// Behavioral: route real-shaped upgrades through the full rule chain
//
// Built-in rules first (config:best-practices pulls in
// :semanticPrefixFixDepsChoreOthers, the `* => chore` this fleet overrides),
// then the presets in each consumer's extends order.
// ---------------------------------------------------------------------------
const builtin = (await resolveConfigPresets({ extends: defaults.extends })).packageRules ?? [];
const rulesFor = (files) => [...builtin, ...files.flatMap((f) => preset(f).packageRules ?? [])];
```
with:
```js
// ---------------------------------------------------------------------------
// Behavioral: route real-shaped upgrades through the full rule chain
//
// Built-in rules first (config:best-practices pulls in
// :semanticPrefixFixDepsChoreOthers, the `* => chore` this fleet overrides,
// and workarounds:typesNodeVersioning, which node.json's @types/node rule
// relies on), then the presets in each consumer's extends order.
//
// resolveConfigPresets returns { config, visitedPresets }. Reading
// `.packageRules` off the top level silently yielded [] and ran every case
// without the built-ins, so an empty result is a binding failure (exit 2),
// never a pass.
// ---------------------------------------------------------------------------
const resolved = await resolveConfigPresets({ extends: defaults.extends });
const builtin = resolved?.config?.packageRules ?? [];
if (!builtin.length) {
  console.error(
    `\nResolved default.json's extends (${defaults.extends.join(', ')}) but got no\n` +
      `built-in packageRules (top-level keys: ${Object.keys(resolved ?? {}).join(', ') || 'none'}).\n\n` +
      `This is a LAYOUT problem, not a config problem: resolveConfigPresets in the\n` +
      `Renovate release at ${DIST} changed its return shape. Repoint the read above\n` +
      `and re-run.\n`,
  );
  process.exit(2);
}
const rulesFor = (files) => [...builtin, ...files.flatMap((f) => preset(f).packageRules ?? [])];
```

- [ ] **Step 4: Run with the built-ins loaded**

Run: `node test/commit-types.mjs; echo "exit=$?"`
Expected: the same check count as Step 1, `exit=0`. If any case now fails, a built-in rule changes its result: STOP and report the failing case name and the `expected … got …` line. Do not edit the expectation to make it pass; that decision goes back to the human.

- [ ] **Step 5: Mutation: the guard fires**

Temporarily change `resolved?.config?.packageRules` to `resolved?.packageRules`, run `node test/commit-types.mjs; echo "exit=$?"`.
Expected: the `LAYOUT problem` message and `exit=2`. Revert the change and re-run; expect `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add test/commit-types.mjs
git commit -m "test: commit-types loads Renovate's built-in rules again

resolveConfigPresets returns { config, visitedPresets }; reading
.packageRules off the top level gave [] and every case ran without the
~750 built-in rules the comment said it loaded. Read .config.packageRules
and exit 2 when the list is empty, so a future shape change can't pass
silently again. All existing checks pass with the built-ins loaded."
```

---

### Task 2: Guard the built-in `@types/node` versioning

**Files:**
- Modify: `test/commit-types.mjs` (insert directly after the `rulesFor` line from Task 1)

- [ ] **Step 1: Add the check**

Insert after `const rulesFor = …;`:
```js

// node.json sends @types/node majors to toolchain-versions and relies on
// Renovate's built-in workarounds:typesNodeVersioning for TIMING: under
// `versioning: node` a types major is offered on its line's LTS date, the same
// day as the runtime. If a Renovate release drops that workaround, types
// majors would arrive months before the runtime again, alone on the group's
// major branch. Fail loudly instead.
{
  checks++;
  const name = "built-in rules give npm @types/node `versioning: node` (node.json's @types/node rule relies on it)";
  const res = await applyPackageRules({ manager: 'npm', datasource: 'npm', depName: '@types/node', packageName: '@types/node', depType: 'devDependencies', packageFile: 'package.json', updateType: 'major', versioning: 'npm', packageRules: builtin });
  if (res.versioning !== 'node')
    fail(name, `got versioning ${JSON.stringify(res.versioning)}: workarounds:typesNodeVersioning is gone or changed; node.json needs its own versioning rule for @types/node`);
  else ok(name);
}
```
This uses `applyPackageRules` before the consumer loop, so it must come after the line `const { applyPackageRules } = await load(...)` (line 58). It does, since it sits after line 153.

- [ ] **Step 2: Run**

Run: `node test/commit-types.mjs; echo "exit=$?"`
Expected: `ok  built-in rules give npm @types/node …` appears, check count is Task 1's plus 1, `exit=0`.

- [ ] **Step 3: Mutation: the guard fails without the built-in**

Temporarily change `packageRules: builtin` in the new check to
`packageRules: builtin.filter((r) => !(r.matchPackageNames ?? []).includes('@types/node'))`, run.
Expected: `FAIL built-in rules give npm @types/node …` with `got versioning "npm"`, `exit=1`. Revert; re-run, expect `exit=0`.

- [ ] **Step 4: Commit**

```bash
git add test/commit-types.mjs
git commit -m "test: fail if Renovate drops its built-in @types/node versioning"
```

---

### Task 3: `@types/node` majors join `toolchain-versions` (TDD)

**Files:**
- Modify: `test/commit-types.mjs` (app `cases`, mcp `cases`)
- Modify: `node.json` (after the `toolchain-versions` rule; that rule's description)

- [ ] **Step 1: Write the failing cases**

In the **app** consumer's `cases`, directly after the `'.nvmrc node'` case (line 204), add:
```js
      // @types/node majors ride the runtime's major-NN branch (node.json); patches stay in the automerged bundle.
      { why: '@types/node MAJOR rides the runtime major branch (YAS #620/#622 split)', u: npmDep('@types/node', 'devDependencies', 'major'), group: 'toolchain-versions', type: 'deps' },
      { why: '@types/node patch stays in the automerged bundle (toolchain-versions is review-gated in :alpine repos)', u: npmDep('@types/node', 'devDependencies', 'patch'), group: BUNDLE, type: 'deps' },
```
In the **mcp** consumer's `cases`, directly after the `'.nvmrc node is dev-only'` case (line 252), add:
```js
      { why: '@types/node MAJOR rides the runtime major branch, hidden like .nvmrc', u: npmDep('@types/node', 'devDependencies', 'major'), group: 'toolchain-versions', type: 'chore' },
```
(The mcp `@types/node` **patch** case already exists at line 240 and must keep passing unchanged.)

- [ ] **Step 2: Run to verify the majors fail**

Run: `node test/commit-types.mjs; echo "exit=$?"`
Expected: exactly 2 failures, both `@types/node [major devDependencies]`, each `expected {"group":"toolchain-versions",…}, got {"group":undefined,…}` (ungrouped today). The app patch case passes. `exit=1`.

- [ ] **Step 3: Add the rule to `node.json`**

Find the `toolchain-versions` rule's closing lines (around line 217-219):
```json
      "matchPackageNames": ["node", "pnpm", "docker.io/library/node"],
      "groupName": "toolchain-versions"
    },
```
and insert this object immediately after that `},`:
```json
    {
      "description": "@types/node MAJORS join `toolchain-versions`, so a types major and the runtime major open as ONE PR on `renovate/major-NN-toolchain-versions` (default.json sets separateMultipleMajor) instead of two that can merge apart (owine/youth-activity-scheduler #620 and #622, 2026-11-02). Timing needs no rule here: Renovate's built-in `workarounds:typesNodeVersioning` (via config:best-practices) already gives @types/node `versioning: node`, so a types major is offered on its line's LTS date, the same day as the runtime; test/commit-types.mjs fails if that built-in disappears. MAJORS ONLY: non-major types bumps stay on the automerged bundles (`all non-major dependencies`, or mcp.json's dev group), because this branch is review-gated in :alpine repos (alpine.json's node image gate). A repo already on a pre-LTS line keeps getting that line's patches: node versioning allows unstable releases within the current major.",
      "matchDatasources": ["npm"],
      "matchPackageNames": ["@types/node"],
      "matchUpdateTypes": ["major"],
      "groupName": "toolchain-versions"
    },
```

- [ ] **Step 4: Point the `toolchain-versions` description at it**

In the `toolchain-versions` rule's `description`, find the sentence ending
`…so it matches exactly and does not catch \`nodered/node-red\` or the like.`
and append, inside the same string, after that sentence:
` @types/node MAJORS join this group through the rule right below (majors only; its non-major bumps stay on the automerged bundles).`

- [ ] **Step 5: Run to verify all pass**

Run: `node test/commit-types.mjs; echo "exit=$?"`
Expected: all checks pass (Task 2's count plus 3), `exit=0`. The `group "toolchain-versions"` lines still print `KNOWN MIXED` for both consumers (app: `deps + ci`; mcp: `chore + deps + ci`, in any order). No new knownMixed entry is needed.

- [ ] **Step 6: Mutation: remove the rule**

Temporarily delete the new `node.json` object (or change its `groupName` to `"x"`), run.
Expected: the two `@types/node [major …]` cases fail, `exit=1`. Restore; re-run, `exit=0`.

- [ ] **Step 7: Validator and the other tests**

Run the validator command from Conventions. Expected: `Config validated successfully against 9 file(s)`.
Run: `for t in test/*.mjs; do node $t >/dev/null 2>&1; echo "$t exit=$?"; done`
Expected: every file `exit=0`.

- [ ] **Step 8: Commit**

```bash
git add node.json test/commit-types.mjs
git commit -m "feat: @types/node majors ride the Node runtime's toolchain-versions branch

A types major and the runtime major now share renovate/major-NN-toolchain-versions
instead of opening as two PRs that can merge apart (youth-activity-scheduler
#620/#622). Majors only; patches stay on the automerged bundles. Timing comes
from Renovate's built-in workarounds:typesNodeVersioning, guarded by the test."
```

---

### Task 4: README

**Files:**
- Modify: `README.md:32`, `README.md:116`

- [ ] **Step 1: Presets table**

In line 32, replace `toolchain (node+pnpm)` with
`toolchain (node+pnpm, plus \`@types/node\` majors so they share the runtime's major PR)`.

- [ ] **Step 2: Test description**

In line 116, replace the first sentence
`` `test/commit-types.mjs` runs an app consumer and an MCP consumer through the real rule chain. ``
with
`` `test/commit-types.mjs` runs an app consumer and an MCP consumer through the real rule chain, Renovate's built-in rules included (it exits 2 if it can't load them). ``

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README notes @types/node majors in toolchain-versions and the test's built-ins"
```

---

### Task 5: Prove it with a dry-run fixture (before any PR merge)

CLAUDE.md: everything here is live on merge, so prove the branch mapping against real Renovate first. `--platform=local` runs extraction, lookup and branch mapping; that is all this needs.

**Files:** none in the repo. Scratch dir: `/private/tmp/claude-501/-Users-owine-Git-renovate-config/ae7c2c86-1c5f-41fd-aeae-485b04c639ed/scratchpad/types-node-fixture`

- [ ] **Step 1: Push the branch**

Run: `git push -u origin feat/types-node-runtime-lockstep`

- [ ] **Step 2: Build the fixture**

```sh
F=/private/tmp/claude-501/-Users-owine-Git-renovate-config/ae7c2c86-1c5f-41fd-aeae-485b04c639ed/scratchpad/types-node-fixture
rm -rf "$F" && mkdir -p "$F" && cd "$F"
B=feat/types-node-runtime-lockstep
cat > renovate.json <<EOF
{ "extends": ["github>owine/renovate-config#$B", "github>owine/renovate-config:automerge#$B", "github>owine/renovate-config:node#$B"] }
EOF
cat > package.json <<'EOF'
{ "name": "fixture", "private": true, "packageManager": "pnpm@12.16.1",
  "engines": { "node": "24.22.2" },
  "devDependencies": { "@types/node": "24.10.0", "lefthook": "2.0.0" } }
EOF
echo 24.22.2 > .nvmrc
git init -q && git add -A && git -c user.email=f@x -c user.name=f commit -qm fixture
```

- [ ] **Step 3: Run with the branch presets**

```sh
cd "$F" && LOG_LEVEL=debug RENOVATE_TOKEN=$(gh auth token) GITHUB_COM_TOKEN=$(gh auth token) \
  RENOVATE_CACHE_DIR="$F/.cache" renovate --platform=local --dry-run=full > branch.log 2>&1
awk '/"depName":/{gsub(/[",]/,"");d=$2} /"updateType":/{gsub(/[",]/,"");u=$2} /"branchName":/{gsub(/[",]/,"");print d"  ["u"]  -> "$2}' branch.log | sort -u
```
Expected (assert branch names, not exact versions; the 7-day major soak may pick an older 26.x):
- `node [major] -> renovate/major-26-toolchain-versions` (from `.nvmrc` and `engines`)
- `@types/node [major] -> renovate/major-26-toolchain-versions`
- `@types/node [minor|patch]` (if a newer 24.x exists) `-> renovate/all-non-major-dependencies`
- `lefthook` on `renovate/all-non-major-dependencies` or its own major branch, NOT on a toolchain branch.

If the awk output is empty, check `branch.log` for `Config fetched` / preset errors (a typo in the `#branch` suffix fails preset resolution).

- [ ] **Step 4: Control run against `main`**

```sh
cd "$F" && sed -i '' "s|#$B||g" renovate.json && git commit -qam control && rm -rf .cache
LOG_LEVEL=debug RENOVATE_TOKEN=$(gh auth token) GITHUB_COM_TOKEN=$(gh auth token) \
  RENOVATE_CACHE_DIR="$F/.cache" renovate --platform=local --dry-run=full > control.log 2>&1
awk '/"depName":/{gsub(/[",]/,"");d=$2} /"updateType":/{gsub(/[",]/,"");u=$2} /"branchName":/{gsub(/[",]/,"");print d"  ["u"]  -> "$2}' control.log | sort -u
```
Expected: `@types/node [major]` on its OWN branch (e.g. `renovate/node-26.x`), while `node [major]` stays on `renovate/major-26-toolchain-versions`. This reproduces the YAS split and shows Task 3 is what fixes it.

- [ ] **Step 5: Record the evidence**

Keep both awk outputs; they go in the PR body.

---

### Task 6: PR

- [ ] **Step 1: Open the PR**

```bash
gh pr create --title "feat: @types/node majors ride the Node runtime's toolchain-versions branch" --body "$(cat <<'EOF'
Keeps an @types/node major on the same PR as the Node runtime major. Spec: docs/superpowers/specs/2026-11-02-types-node-runtime-lockstep-design.md

- node.json: npm @types/node MAJORS join `toolchain-versions`, so both land on `renovate/major-NN-toolchain-versions` (youth-activity-scheduler #620/#622 opened as two PRs). Patches stay on the automerged bundles.
- Timing needs no rule: Renovate's built-in `workarounds:typesNodeVersioning` already gives @types/node `versioning: node`. A new check fails if Renovate drops it.
- test/commit-types.mjs was running without any built-in rules (`resolveConfigPresets` returns `{ config, visitedPresets }`). It now loads them and exits 2 if it can't; all existing checks pass with them loaded.

Dry run (`--platform=local`), branch presets:
<paste Task 5 Step 3 output>

Control against main:
<paste Task 5 Step 4 output>
EOF
)"
```
Replace both `<paste …>` lines with the recorded outputs before running.

- [ ] **Step 2: Before merging**

Wait for `renovate-config-validator` (CI also runs every `test/*.mjs`), GitGuardian, and Sourcery. Read Sourcery's review body, not just its check status. Merge with `gh pr merge <n> --squash --delete-branch` only after it has actually reviewed.
