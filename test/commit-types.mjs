#!/usr/bin/env node
// Behavior tests for which branch each update lands on, and what commit type
// that branch gets.
//
// WHY THIS EXISTS: a groupName is a branch name, and a branch gets ONE commit
// message. Renovate types it with the highest-priority type among the
// branch's upgrades, from the fixed list [chore, ci, build, fix, feat]
// (generateBranchConfig). `deps` is not in that list, so a single `ci:` or
// `chore:` upgrade retypes the whole branch, and release-please treats both
// as hidden. owine/unifi-protect-mcp #284 shipped the production dependency
// `ws` 8.22.0 that way, with no CHANGELOG entry, because an Actions bump
// shared its `all non-major dependencies` branch.
//
// Two splits keep hidden types off the `deps:` bundle, each typed in one file
// and grouped in another:
//   - CI plumbing: typed `ci:` in default.json, grouped by automerge.json
//     onto `all non-major ci dependencies`.
//   - Dev-only deps of npm LIBRARIES: typed `chore:` in mcp.json, grouped by
//     mcp.json onto `all non-major dev dependencies`, with the update types
//     of automerge.json's bundle.
// Nothing links the copies, and `renovate-config-validator --strict` cannot
// see a drift, so this test checks both: that the matchers are identical,
// and that every group the presets produce carries a single commit type, for
// an app consumer and for an MCP-library consumer.
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
const mcp = preset('mcp.json');

const failures = [];
const fail = (name, msg) => failures.push(`${name}\n    ${msg.replace(/\n/g, '\n    ')}`);
let checks = 0;
const ok = (name) => console.log(`  ok  ${name}`);

const CI_GROUP = 'all non-major ci dependencies';
const DEV_GROUP = 'all non-major dev dependencies';
const BUNDLE = 'all non-major dependencies';
const SECURITY = defaults.vulnerabilityAlerts.groupName;

// ---------------------------------------------------------------------------
// Structural: each typing rule and its grouping twin must match identically
//
// Compare every match* field except matchUpdateTypes (only the group rules
// set it), so adding a typing rule, or widening one, fails here until the
// group side follows.
// ---------------------------------------------------------------------------
const matchers = (rule) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(rule)
        .filter(([k]) => k.startsWith('match') && k !== 'matchUpdateTypes')
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
const sameSet = (name, typedLabel, typed, groupedLabel, grouped) => {
  checks++;
  typed = typed.map(matchers).sort();
  grouped = grouped.map(matchers).sort();
  if (!typed.length || JSON.stringify(typed) !== JSON.stringify(grouped))
    fail(name, `${typedLabel}:\n  ${typed.join('\n  ')}\n${groupedLabel}:\n  ${grouped.join('\n  ')}`);
  else ok(`${name} (${typed.length} rule${typed.length > 1 ? 's' : ''})`);
};
const bundle = automerge.packageRules.find((r) => r.groupName === BUNDLE);
const bundleTypes = JSON.stringify([...bundle.matchUpdateTypes].sort());
const sameUpdateTypes = (name, rules) => {
  checks++;
  const wrong = rules
    .filter((r) => JSON.stringify([...(r.matchUpdateTypes ?? [])].sort()) !== bundleTypes)
    .map((r) => matchers(r) + ' has ' + JSON.stringify(r.matchUpdateTypes));
  if (wrong.length) fail(name, `expected matchUpdateTypes ${bundleTypes} (automerge.json's bundle)\n${wrong.join('\n')}`);
  else ok(name);
};

const ciGroupRules = automerge.packageRules.filter((r) => r.groupName === CI_GROUP);
sameSet(
  "automerge.json's CI group mirrors default.json's `ci:` rules exactly",
  'default.json types as ci:',
  defaults.packageRules.filter((r) => r.semanticCommitType === 'ci'),
  'automerge.json groups as CI:',
  ciGroupRules,
);
sameUpdateTypes('the CI group takes the same update types as the bundle, and no pins', ciGroupRules);
{
  checks++;
  const name = 'the CI group comes AFTER the bundle (last match wins)';
  const idx = (g) => automerge.packageRules.findIndex((r) => r.groupName === g);
  if (!(idx(CI_GROUP) > idx(BUNDLE))) fail(name, `bundle at ${idx(BUNDLE)}, CI group at ${idx(CI_GROUP)}`);
  else ok(name);
}

const devGroupRules = mcp.packageRules.filter((r) => r.groupName === DEV_GROUP);
sameSet(
  "mcp.json's dev group mirrors mcp.json's `chore:` devDependencies rules exactly",
  'mcp.json types devDependencies as chore:',
  mcp.packageRules.filter((r) => r.semanticCommitType === 'chore' && r.matchDepTypes?.includes('devDependencies')),
  'mcp.json groups as dev:',
  devGroupRules,
);
sameUpdateTypes("the dev group takes the same update types as automerge.json's bundle, and no pins", devGroupRules);
{
  checks++;
  const name = 'the dev group sets no automerge of its own (it inherits automerge.json)';
  const wrong = devGroupRules.filter((r) => 'automerge' in r || 'automergeType' in r);
  if (wrong.length) fail(name, `mcp.json would turn automerge on in a repo that never extended :automerge`);
  else ok(name);
}

// ---------------------------------------------------------------------------
// Behavioral: route real-shaped upgrades through the full rule chain
//
// Built-in rules first (config:best-practices pulls in
// :semanticPrefixFixDepsChoreOthers, the `* => chore` this fleet overrides),
// then the presets in each consumer's extends order.
// ---------------------------------------------------------------------------
const builtin = (await resolveConfigPresets({ extends: defaults.extends })).packageRules ?? [];
const rulesFor = (files) => [...builtin, ...files.flatMap((f) => preset(f).packageRules ?? [])];

// A vulnerable dep gets the rule Renovate builds in init/vulnerability.ts and
// process/vulnerabilities.ts: appended LAST, carrying vulnerabilityAlerts as
// `force`. Built here the same way, so a change to vulnerabilityAlerts is
// what this exercises.
const vulnRule = (u) => ({
  matchDatasources: [u.datasource],
  matchPackageNames: [u.depName],
  ...(u.depType ? { matchDepTypes: [u.depType] } : {}),
  matchCurrentVersion: u.currentVersion,
  allowedVersions: '>' + u.currentVersion,
  isVulnerabilityAlert: true,
  force: { ...defaults.vulnerabilityAlerts },
});

const WF = '.github/workflows/ci.yml';
const npmDep = (depName, depType, updateType, extra = {}) => ({ manager: 'npm', depName, datasource: 'npm', depType, packageFile: 'package.json', updateType, ...extra });
const action = (depName, updateType, packageFile = WF) => ({ manager: 'github-actions', depName, datasource: 'github-tags', depType: 'action', packageFile, updateType });

const consumers = [
  {
    name: 'app',
    files: ['default.json', 'automerge.json', 'node.json', 'python.json', 'docker.json'],
    cases: [
      // The #284 mix: these three were on one branch.
      { why: 'production npm dep (ws in #284)', u: npmDep('ws', 'dependencies', 'minor'), group: BUNDLE, type: 'deps' },
      { why: 'npm dep (zod)', u: npmDep('zod', 'dependencies', 'patch'), group: BUNDLE, type: 'deps' },
      { why: 'npm devDependency: apps release on it, no dev split without :mcp', u: npmDep('lefthook', 'devDependencies', 'patch'), group: BUNDLE, type: 'deps' },
      { why: 'Action bump (create-github-app-token)', u: action('actions/create-github-app-token', 'minor', '.github/workflows/release.yml'), group: CI_GROUP, type: 'ci' },

      // Every way something becomes `ci:` must land on the CI branch.
      { why: 'Action digest refresh', u: action('actions/checkout', 'digest'), group: 'github-actions-setup', type: 'ci' },
      { why: 'Action in a composite action.yml (manager rule, not path rule)', u: action('some/action', 'patch', '.github/actions/setup/action.yml'), group: CI_GROUP, type: 'ci' },
      { why: 'literal `runs-on:` runner (github-actions manager)', u: { manager: 'github-actions', depName: 'ubuntu', datasource: 'github-runners', depType: 'github-runner', packageFile: WF, updateType: 'minor' }, group: CI_GROUP, type: 'ci' },
      { why: 'matrix `runner:` label (custom.regex, path rule): same branch as runs-on', u: { manager: 'regex', depName: 'ubuntu', datasource: 'github-runners', packageFile: WF, updateType: 'minor' }, group: CI_GROUP, type: 'ci' },
      { why: 'annotated workflow literal (custom.regex trivy)', u: { manager: 'regex', depName: 'aquasecurity/trivy', datasource: 'github-releases', packageFile: WF, updateType: 'patch' }, group: CI_GROUP, type: 'ci' },
      { why: 'docker.json family group stays ci-only', u: action('pnpm/setup', 'minor'), group: 'github-actions-setup', type: 'ci' },

      // The path rule must not reach outside .github/workflows.
      { why: 'custom.regex OUTSIDE workflows stays deps', u: { manager: 'regex', depName: 'some-tool', datasource: 'github-releases', packageFile: 'Dockerfile', updateType: 'patch' }, group: BUNDLE, type: 'deps' },
      { why: 'Dockerfile base stays deps', u: { manager: 'dockerfile', depName: 'debian', datasource: 'docker', packageFile: 'Dockerfile', updateType: 'patch' }, group: 'dockerfile bases', type: 'deps' },

      // Carve-outs that must survive the split.
      { why: 'Action pinDigest stays on `pins`', u: action('some/action', 'pinDigest'), group: 'pins', type: 'ci' },
      { why: 'npm range pin stays on `pins`', u: npmDep('zod', 'dependencies', 'pin'), group: 'pins', type: 'deps' },
      { why: 'Action major stays ungrouped', u: action('some/action', 'major'), group: undefined, type: 'ci' },
      { why: 'lock file maintenance stays chore', u: { manager: 'npm', updateType: 'lockFileMaintenance', packageFile: 'package.json' }, group: undefined, type: 'chore' },

      // Runtime groups: fed by both shipping manifests and workflow inputs. See knownMixed.
      { why: 'packageManager pnpm', u: npmDep('pnpm', 'packageManager', 'patch'), group: 'toolchain-versions', type: 'deps' },
      { why: '.nvmrc node', u: { manager: 'nvm', depName: 'node', datasource: 'node-version', packageFile: '.nvmrc', updateType: 'patch' }, group: 'toolchain-versions', type: 'deps' },
      // Workflow Node literals are tracked by their `# renovate: … depName=node-lts-NN packageName=node`
      // annotation (path-typed ci:). setup-node's NATIVE input dep is a duplicate of
      // the same span with no lane cap, so node.json disables it (claude-terminal-home-assistant #432/#433).
      { why: 'annotated workflow Node lane (custom.regex node-lts-24)', u: { manager: 'regex', depName: 'node-lts-24', packageName: 'node', datasource: 'node-version', packageFile: WF, updateType: 'minor' }, group: 'toolchain-versions', type: 'ci' },
      { why: 'setup-node `node-version:` NATIVE dep (real packageName actions/node-versions): disabled duplicate', u: { manager: 'github-actions', depName: 'node', packageName: 'actions/node-versions', datasource: 'github-releases', depType: 'uses-with', packageFile: WF, updateType: 'patch' }, enabled: false },
      { why: 'setup-node NATIVE dep in a composite action stays ON: the annotation manager does not scan .github/actions, so it is the only tracker there', u: { manager: 'github-actions', depName: 'node', packageName: 'actions/node-versions', datasource: 'github-releases', depType: 'uses-with', packageFile: '.github/actions/setup/action.yml', updateType: 'patch' }, group: CI_GROUP, type: 'ci' },
      { why: 'FROM python', u: { manager: 'dockerfile', depName: 'python', datasource: 'docker', packageFile: 'Dockerfile', updateType: 'patch' }, group: 'python runtime', type: 'deps' },
      // python runtime is typed `deps:` by python.json, so its workflow members
      // cannot retype a CPython bump of the shipped image `ci:`.
      { why: '.python-version (pyenv)', u: { manager: 'pyenv', depName: 'python', datasource: 'docker', packageFile: '.python-version', updateType: 'patch' }, group: 'python runtime', type: 'deps' },
      { why: '`uv python install X.Y` in a workflow (python.json customManager, path-typed ci: by default.json)', u: { manager: 'regex', depName: 'python', datasource: 'python-version', depType: 'uv-python-install', packageFile: WF, updateType: 'minor' }, group: 'python runtime', type: 'deps' },
      { why: 'setup-python `python-version:` literal (uses-with; real packageName actions/python-versions)', u: { manager: 'github-actions', depName: 'python', packageName: 'actions/python-versions', datasource: 'github-releases', depType: 'uses-with', packageFile: WF, updateType: 'patch' }, group: 'python runtime', type: 'deps' },
    ],
    // Groups that CAN still carry two commit types, each with the reason it is
    // accepted. A group listed here that stops mixing fails the run, so a
    // later fix has to come and delete its entry.
    knownMixed: {
      pins: 'pin/pinDigest change no resolved version, so it does not matter that a mixed branch comes out `ci:` and does not release. Kept as one branch by design (automerge.json `pins`).',
      'toolchain-versions':
        'LATENT: only when an app annotates a workflow Node literal (`# renovate: … depName=node-lts-NN packageName=node`, path-typed ci:) while also shipping Node via .nvmrc/packageManager/Dockerfile; the ci: lane would hide the runtime release. No app has that shape (2026-10-19: the only annotated setup-node lines are in claude-terminal-home-assistant, which ships no Node manifest). NOT fixed by typing the group deps: the way python.json does, because an independent lane (node-lts-22 next to a 24 .nvmrc) bumps alone and would then release on CI churn. Splitting the group re-opens the runtime co-bump deadlock, so it is left open on purpose.',
    },
  },
  {
    // owine/unifi-protect-mcp and owine/unifi-network-mcp, in their extends order.
    name: 'mcp',
    files: ['default.json', 'automerge.json', 'node.json', 'mcp.json', 'docker.json'],
    cases: [
      // Runtime deps release; they ship to every consumer.
      { why: 'production dep (ws)', u: npmDep('ws', 'dependencies', 'minor'), group: BUNDLE, type: 'deps', week: 'runtime' },
      { why: 'production dep (zod)', u: npmDep('zod', 'dependencies', 'patch'), group: BUNDLE, type: 'deps' },
      { why: 'MCP SDK keeps its review group', u: npmDep('@modelcontextprotocol/sdk', 'dependencies', 'minor'), group: 'mcp-sdk', type: 'deps' },
      { why: 'production dep major stays deps', u: npmDep('ws', 'dependencies', 'major'), group: undefined, type: 'deps' },

      // Dev-only deps: hidden, and on their own branch (2.15.0's noise).
      { why: 'dev dep (lefthook)', u: npmDep('lefthook', 'devDependencies', 'patch'), group: DEV_GROUP, type: 'chore', week: 'dev' },
      { why: 'dev dep (@types/node)', u: npmDep('@types/node', 'devDependencies', 'patch'), group: DEV_GROUP, type: 'chore' },
      { why: 'dev dep in a node.json group (typescript-eslint) joins the dev branch', u: npmDep('typescript-eslint', 'devDependencies', 'patch'), group: DEV_GROUP, type: 'chore' },
      { why: 'coupled dev pair stays together (vitest)', u: npmDep('vitest', 'devDependencies', 'patch'), group: DEV_GROUP, type: 'chore' },
      { why: 'coupled dev pair stays together (@vitest/coverage-v8)', u: npmDep('@vitest/coverage-v8', 'devDependencies', 'patch'), group: DEV_GROUP, type: 'chore' },
      { why: 'dev digest is non-major too', u: npmDep('lefthook', 'devDependencies', 'digest'), group: DEV_GROUP, type: 'chore' },
      { why: 'dev major keeps its ecosystem group, hidden', u: npmDep('vitest', 'devDependencies', 'major'), group: 'testing', type: 'chore' },
      { why: 'ungrouped dev major, hidden', u: npmDep('lefthook', 'devDependencies', 'major'), group: undefined, type: 'chore' },
      { why: 'a type pair spanning dep kinds splits by kind (@types/pg)', u: npmDep('@types/pg', 'devDependencies', 'minor'), group: DEV_GROUP, type: 'chore' },
      { why: 'a type pair spanning dep kinds splits by kind (pg)', u: npmDep('pg', 'dependencies', 'minor'), group: 'pg', type: 'deps' },

      // Toolchain: dev-only members hidden, engines out of play.
      { why: 'packageManager pnpm is dev-only', u: npmDep('pnpm', 'packageManager', 'patch'), group: 'toolchain-versions', type: 'chore' },
      { why: '.nvmrc node is dev-only', u: { manager: 'nvm', depName: 'node', datasource: 'node-version', packageFile: '.nvmrc', updateType: 'patch' }, group: 'toolchain-versions', type: 'chore' },
      { why: 'engines.node is consumer-visible: disabled, never typed', u: npmDep('node', 'engines', 'minor', { datasource: 'node-version' }), enabled: false },
      { why: 'engines.pnpm is consumer-visible: disabled, never typed', u: npmDep('pnpm', 'engines', 'minor'), enabled: false },
      { why: 'LATENT: Dockerfile `FROM node` (no MCP repo has one)', u: { manager: 'dockerfile', depName: 'node', datasource: 'docker', packageFile: 'Dockerfile', updateType: 'patch' }, group: 'toolchain-versions', type: 'deps' },
      { why: 'annotated CI matrix Node lane (unifi-*-mcp ci.yml)', u: { manager: 'regex', depName: 'node-lts-22', packageName: 'node', datasource: 'node-version', packageFile: WF, updateType: 'minor' }, group: 'toolchain-versions', type: 'ci' },

      // Security still releases, dev or not.
      { why: 'vulnerable DEV dep still releases as fix', u: npmDep('lefthook', 'devDependencies', 'patch', { currentVersion: '2.2.1' }), vuln: true, group: SECURITY, type: 'fix' },
      { why: 'vulnerable runtime dep releases as fix', u: npmDep('ws', 'dependencies', 'patch', { currentVersion: '8.22.0' }), vuln: true, group: SECURITY, type: 'fix' },

      // Unchanged by mcp.json.
      { why: 'Action bump', u: action('actions/create-github-app-token', 'minor', '.github/workflows/release.yml'), group: CI_GROUP, type: 'ci' },
      { why: 'dev range pin stays on `pins`', u: npmDep('lefthook', 'devDependencies', 'pin'), group: 'pins', type: 'chore' },
      { why: 'runtime range pin stays on `pins`', u: npmDep('zod', 'dependencies', 'pin'), group: 'pins', type: 'deps' },
      { why: 'lock file maintenance stays chore', u: { manager: 'npm', updateType: 'lockFileMaintenance', packageFile: 'package.json' }, group: undefined, type: 'chore' },
    ],
    knownMixed: {
      pins: 'Same as for apps (pins change no resolved version); dev pins add `chore:` to the mix, which is equally harmless.',
      'toolchain-versions':
        'LIVE but harmless: the annotated CI matrix lanes (ci:) share the branch with .nvmrc/packageManager (chore:), so it comes out `ci: update toolchain-versions` (unifi-protect-mcp #323, unifi-network-mcp #303); both types are hidden and every member is dev-only in a library. LATENT and harmful: a Dockerfile `FROM node` would add a releasing `deps:` that ships hidden. Neither unifi-protect-mcp nor unifi-network-mcp has a Dockerfile (2026-10-13). Split the image out of the group before adding one.',
    },
  },
];

for (const consumer of consumers) {
  console.log(`\n[${consumer.name}] ${consumer.files.join(' -> ')}`);
  const base = rulesFor(consumer.files);
  const typesByGroup = new Map();
  const groupOf = {};

  for (const c of consumer.cases) {
    checks++;
    const name = `${c.u.manager} ${c.u.depName ?? c.u.updateType} [${c.u.updateType}${c.u.depType ? ' ' + c.u.depType : ''}${c.vuln ? ' VULNERABLE' : ''}] — ${c.why}`;
    const packageRules = c.vuln ? [...base, vulnRule(c.u)] : base;
    const res = await applyPackageRules({ ...c.u, currentValue: c.u.currentVersion, packageName: c.u.packageName ?? c.u.depName, versioning: 'npm', packageRules });

    if (c.enabled === false) {
      if (res.enabled !== false) fail(name, `expected enabled: false, got enabled: ${res.enabled} (type ${res.semanticCommitType}, group ${res.groupName})`);
      else ok(`${name} -> disabled`);
      continue;
    }
    const got = { group: res.groupName ?? undefined, type: res.semanticCommitType };
    if (res.enabled === false || got.group !== c.group || got.type !== c.type) {
      fail(name, `expected ${JSON.stringify({ group: c.group, type: c.type })}, got ${JSON.stringify({ ...got, enabled: res.enabled })}`);
      continue;
    }
    if (c.week) groupOf[c.week] = got.group;
    if (got.group && !c.vuln) {
      if (!typesByGroup.has(got.group)) typesByGroup.set(got.group, new Set());
      typesByGroup.get(got.group).add(got.type);
    }
    ok(`${name} -> ${got.group ?? '(ungrouped)'} / ${got.type}:`);
  }

  // The 2.15.0 week: a runtime bump and a dev bump pending together.
  if ('runtime' in groupOf || 'dev' in groupOf) {
    checks++;
    const name = 'a runtime and a dev bump pending in the same week land on different branches';
    if (!groupOf.runtime || !groupOf.dev || groupOf.runtime === groupOf.dev)
      fail(name, `runtime -> ${groupOf.runtime}, dev -> ${groupOf.dev}`);
    else ok(`${name} (${groupOf.runtime} | ${groupOf.dev})`);
  }

  // The property itself: no branch carries two commit types.
  for (const [group, types] of typesByGroup) {
    checks++;
    const mixed = types.size > 1;
    const name = `group "${group}" carries one commit type`;
    const known = consumer.knownMixed[group];
    if (mixed && !known)
      fail(name, `carries ${[...types].join(' + ')}: the branch would be typed by priority and the losing updates would release wrongly`);
    else if (!mixed && known) fail(name, `no longer mixes (only ${[...types].join()}); delete its knownMixed entry`);
    else if (mixed) console.log(`  --  ${name}: KNOWN MIXED (${[...types].join(' + ')}). ${known}`);
    else ok(`${name} (${[...types].join()})`);
  }
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
