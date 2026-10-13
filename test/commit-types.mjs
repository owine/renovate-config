#!/usr/bin/env node
// Behavior tests for which branch each update lands on, and what commit type
// that branch gets.
//
// WHY THIS EXISTS: a groupName is a branch name, and a branch gets ONE commit
// message. Renovate types it with the highest-priority type among the
// branch's upgrades, from the fixed list [chore, ci, build, fix, feat]
// (generateBranchConfig). `deps` is not in that list, so a single `ci:`
// upgrade makes the whole branch `ci:`, and release-please treats `ci:` as
// hidden. owine/unifi-protect-mcp #284 shipped the production dependency
// `ws` 8.22.0 that way, with no CHANGELOG entry, because an Actions bump
// shared its `all non-major dependencies` branch.
//
// automerge.json now routes CI plumbing onto `all non-major ci dependencies`
// with matchers that mirror default.json's two `ci:` rules. Nothing links the
// two files, and `renovate-config-validator --strict` cannot see a drift, so
// this test checks both: that the matchers are identical, and that every
// group the presets produce carries a single commit type.
//
// Same approach as custom-managers.mjs: the real preset resolver and the real
// package-rule engine out of the Renovate dist the validate workflow's
// container already ships.
//
// Locally:  npm i renovate && RENOVATE_DIST=./node_modules/renovate/dist node test/commit-types.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = process.env.RENOVATE_DIST ?? '/usr/local/renovate/dist';
const HERE = dirname(fileURLToPath(import.meta.url));

const load = async (rel) => {
  const path = join(DIST, rel);
  try {
    return await import(pathToFileURL(path).href);
  } catch (err) {
    console.error(
      `\nCannot import Renovate's dist at ${path}\n` +
        `  ${err.message}\n\n` +
        `This is a LAYOUT problem, not a config problem: the Renovate release this\n` +
        `runs against has moved or renamed that module. If a Renovate image bump\n` +
        `brought you here, the presets are probably fine — repoint the import and\n` +
        `re-run. Set RENOVATE_DIST to test against a different install.\n`,
    );
    process.exit(2);
  }
};

const { resolveConfigPresets } = await load('config/presets/index.js');
const { applyPackageRules } = await load('util/package-rules/index.js');
const { init } = await load('logger/index.js');
await init();

const preset = (f) => JSON.parse(readFileSync(join(HERE, '..', f), 'utf8'));
const defaults = preset('default.json');
const automerge = preset('automerge.json');

const failures = [];
const fail = (name, msg) => failures.push(`${name}\n    ${msg.replace(/\n/g, '\n    ')}`);
let checks = 0;
const ok = (name) => console.log(`  ok  ${name}`);

const CI_GROUP = 'all non-major ci dependencies';
const BUNDLE = 'all non-major dependencies';

// ---------------------------------------------------------------------------
// Structural: the two definitions of "CI plumbing" must be identical
//
// default.json decides what is TYPED `ci:`; automerge.json decides what is
// GROUPED as CI. Compare every match* field except matchUpdateTypes (which
// only automerge.json sets), so adding a third `ci:` rule, or widening one,
// fails here until the other file follows.
// ---------------------------------------------------------------------------
const matchers = (rule) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(rule)
        .filter(([k]) => k.startsWith('match') && k !== 'matchUpdateTypes')
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );

{
  checks++;
  const name = "automerge.json's CI group mirrors default.json's `ci:` rules exactly";
  const typed = defaults.packageRules.filter((r) => r.semanticCommitType === 'ci').map(matchers).sort();
  const grouped = automerge.packageRules.filter((r) => r.groupName === CI_GROUP).map(matchers).sort();
  if (JSON.stringify(typed) !== JSON.stringify(grouped))
    fail(name, `default.json types as ci:\n  ${typed.join('\n  ')}\nautomerge.json groups as CI:\n  ${grouped.join('\n  ')}`);
  else ok(`${name} (${typed.length} rules)`);
}

{
  checks++;
  const name = 'the CI group takes the same update types as the bundle, and no pins';
  const bundle = automerge.packageRules.find((r) => r.groupName === BUNDLE);
  const want = JSON.stringify([...bundle.matchUpdateTypes].sort());
  const wrong = automerge.packageRules
    .filter((r) => r.groupName === CI_GROUP)
    .filter((r) => JSON.stringify([...(r.matchUpdateTypes ?? [])].sort()) !== want)
    .map((r) => matchers(r) + ' has ' + JSON.stringify(r.matchUpdateTypes));
  if (wrong.length) fail(name, `expected matchUpdateTypes ${want}\n${wrong.join('\n')}`);
  else ok(name);
}

{
  checks++;
  const name = 'the CI group comes AFTER the bundle (last match wins)';
  const idx = (g) => automerge.packageRules.findIndex((r) => r.groupName === g);
  if (!(idx(CI_GROUP) > idx(BUNDLE))) fail(name, `bundle at ${idx(BUNDLE)}, CI group at ${idx(CI_GROUP)}`);
  else ok(name);
}

// ---------------------------------------------------------------------------
// Behavioral: route real-shaped upgrades through the full rule chain
//
// Built-in rules first (config:best-practices pulls in
// :semanticPrefixFixDepsChoreOthers, the `* => chore` this fleet overrides),
// then the presets in the fleet's documented extends order.
// ---------------------------------------------------------------------------
const builtin = await resolveConfigPresets({ extends: defaults.extends });
const packageRules = [
  ...(builtin.packageRules ?? []),
  ...['default.json', 'automerge.json', 'node.json', 'python.json', 'docker.json', 'mcp.json'].flatMap(
    (f) => preset(f).packageRules ?? [],
  ),
];

const WF = '.github/workflows/ci.yml';
const cases = [
  // The #284 mix: these three were on one branch.
  { why: 'production npm dep (ws in #284)', u: { manager: 'npm', depName: 'ws', datasource: 'npm', depType: 'dependencies', packageFile: 'package.json', updateType: 'minor' }, group: BUNDLE, type: 'deps' },
  { why: 'npm dep (zod, pending at time of fix)', u: { manager: 'npm', depName: 'zod', datasource: 'npm', depType: 'dependencies', packageFile: 'package.json', updateType: 'patch' }, group: BUNDLE, type: 'deps' },
  { why: 'npm devDependency (lefthook)', u: { manager: 'npm', depName: 'lefthook', datasource: 'npm', depType: 'devDependencies', packageFile: 'package.json', updateType: 'patch' }, group: BUNDLE, type: 'deps' },
  { why: 'Action bump (create-github-app-token)', u: { manager: 'github-actions', depName: 'actions/create-github-app-token', datasource: 'github-tags', depType: 'action', packageFile: '.github/workflows/release.yml', updateType: 'minor' }, group: CI_GROUP, type: 'ci' },

  // Every way something becomes `ci:` must land on the CI branch.
  { why: 'Action digest refresh', u: { manager: 'github-actions', depName: 'actions/checkout', datasource: 'github-tags', depType: 'action', packageFile: WF, updateType: 'digest' }, group: 'github-actions-setup', type: 'ci' },
  { why: 'Action in a composite action.yml (manager rule, not path rule)', u: { manager: 'github-actions', depName: 'some/action', datasource: 'github-tags', depType: 'action', packageFile: '.github/actions/setup/action.yml', updateType: 'patch' }, group: CI_GROUP, type: 'ci' },
  { why: 'literal `runs-on:` runner (github-actions manager)', u: { manager: 'github-actions', depName: 'ubuntu', datasource: 'github-runners', depType: 'github-runner', packageFile: WF, updateType: 'minor' }, group: CI_GROUP, type: 'ci' },
  { why: 'matrix `runner:` label (custom.regex, path rule): same branch as runs-on', u: { manager: 'regex', depName: 'ubuntu', datasource: 'github-runners', packageFile: WF, updateType: 'minor' }, group: CI_GROUP, type: 'ci' },
  { why: 'annotated workflow literal (custom.regex trivy)', u: { manager: 'regex', depName: 'aquasecurity/trivy', datasource: 'github-releases', packageFile: WF, updateType: 'patch' }, group: CI_GROUP, type: 'ci' },
  { why: 'docker.json family group stays ci-only', u: { manager: 'github-actions', depName: 'pnpm/setup', datasource: 'github-tags', depType: 'action', packageFile: WF, updateType: 'minor' }, group: 'github-actions-setup', type: 'ci' },

  // The path rule must not reach outside .github/workflows.
  { why: 'custom.regex OUTSIDE workflows stays deps', u: { manager: 'regex', depName: 'some-tool', datasource: 'github-releases', packageFile: 'Dockerfile', updateType: 'patch' }, group: BUNDLE, type: 'deps' },
  { why: 'Dockerfile base stays deps', u: { manager: 'dockerfile', depName: 'debian', datasource: 'docker', packageFile: 'Dockerfile', updateType: 'patch' }, group: 'dockerfile bases', type: 'deps' },

  // Carve-outs that must survive the split.
  { why: 'Action pinDigest stays on `pins`', u: { manager: 'github-actions', depName: 'some/action', datasource: 'github-tags', depType: 'action', packageFile: WF, updateType: 'pinDigest' }, group: 'pins', type: 'ci' },
  { why: 'npm range pin stays on `pins`', u: { manager: 'npm', depName: 'zod', datasource: 'npm', depType: 'dependencies', packageFile: 'package.json', updateType: 'pin' }, group: 'pins', type: 'deps' },
  { why: 'Action major stays ungrouped', u: { manager: 'github-actions', depName: 'some/action', datasource: 'github-tags', depType: 'action', packageFile: WF, updateType: 'major' }, group: undefined, type: 'ci' },
  { why: 'lock file maintenance stays chore', u: { manager: 'npm', updateType: 'lockFileMaintenance', packageFile: 'package.json' }, group: undefined, type: 'chore' },

  // Runtime groups: fed by both shipping manifests and workflow inputs. See KNOWN_MIXED.
  { why: 'packageManager pnpm', u: { manager: 'npm', depName: 'pnpm', datasource: 'npm', depType: 'packageManager', packageFile: 'package.json', updateType: 'patch' }, group: 'toolchain-versions', type: 'deps' },
  { why: '.nvmrc node', u: { manager: 'nvm', depName: 'node', datasource: 'node-version', packageFile: '.nvmrc', updateType: 'patch' }, group: 'toolchain-versions', type: 'deps' },
  { why: 'setup-node `node-version:` literal (uses-with)', u: { manager: 'github-actions', depName: 'node', datasource: 'github-releases', depType: 'uses-with', packageFile: WF, updateType: 'patch' }, group: 'toolchain-versions', type: 'ci' },
  { why: 'FROM python', u: { manager: 'dockerfile', depName: 'python', datasource: 'docker', packageFile: 'Dockerfile', updateType: 'patch' }, group: 'python runtime', type: 'deps' },
  { why: 'setup-python `python-version:` literal (uses-with)', u: { manager: 'github-actions', depName: 'python', datasource: 'github-releases', depType: 'uses-with', packageFile: WF, updateType: 'patch' }, group: 'python runtime', type: 'ci' },
];

// Groups that CAN still carry two commit types, each with the reason it is
// accepted. A group listed here that stops mixing fails the run, so a later
// fix has to come and delete its entry.
const KNOWN_MIXED = {
  pins: 'pin/pinDigest change no resolved version, so it does not matter that a mixed branch comes out `ci:` and does not release. Kept as one branch by design (automerge.json `pins`).',
  'toolchain-versions':
    'LATENT: only when a repo pins node/pnpm as a setup-node/pnpm action INPUT while also shipping it via .nvmrc/packageManager/Dockerfile. No preset consumer has that shape as of 2026-10-13. Splitting the group re-opens the runtime co-bump deadlock, so it is left open on purpose.',
  'python runtime': 'LATENT: same shape as toolchain-versions, via setup-python `python-version:`. Same reason.',
};

const typesByGroup = new Map();
for (const c of cases) {
  checks++;
  const name = `${c.u.manager} ${c.u.depName ?? c.u.updateType} [${c.u.updateType}] — ${c.why}`;
  const res = await applyPackageRules({ ...c.u, packageName: c.u.depName, packageRules });
  const got = { group: res.groupName ?? undefined, type: res.semanticCommitType };
  if (got.group !== c.group || got.type !== c.type) {
    fail(name, `expected ${JSON.stringify({ group: c.group, type: c.type })}, got ${JSON.stringify(got)}`);
    continue;
  }
  if (got.group) {
    if (!typesByGroup.has(got.group)) typesByGroup.set(got.group, new Set());
    typesByGroup.get(got.group).add(got.type);
  }
  ok(`${name} -> ${got.group ?? '(ungrouped)'} / ${got.type}:`);
}

// ---------------------------------------------------------------------------
// The property itself: no branch carries two commit types
// ---------------------------------------------------------------------------
for (const [group, types] of typesByGroup) {
  checks++;
  const mixed = types.size > 1;
  const name = `group "${group}" carries one commit type`;
  if (mixed && !KNOWN_MIXED[group])
    fail(name, `carries ${[...types].join(' + ')}: the branch would be typed by priority and the losing updates would release wrongly`);
  else if (!mixed && KNOWN_MIXED[group])
    fail(name, `no longer mixes (only ${[...types].join()}); delete its KNOWN_MIXED entry`);
  else if (mixed) console.log(`  --  ${name}: KNOWN MIXED (${[...types].join(' + ')}). ${KNOWN_MIXED[group]}`);
  else ok(`${name} (${[...types].join()})`);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n`);
  for (const f of failures) console.error(`  FAIL ${f}\n`);
  console.error(
    'These are BEHAVIOR failures. `renovate-config-validator` will still pass on\n' +
      'this config. If the change was deliberate, update the expectation and say\n' +
      'why in the commit message.\n',
  );
  process.exit(1);
}
console.log(`\n${checks} checks passed against Renovate at ${DIST}`);
