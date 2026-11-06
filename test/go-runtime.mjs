#!/usr/bin/env node
// Behavior tests for go.json: the `go toolchain` group (golang image, go.mod's
// `go`/`toolchain` directives, setup-go's input), the `go` directive's
// rangeStrategy, the soak, Go-minor review, indirect modules, `golang-x`, and
// the gomod postUpdateOptions.
//
// WHY THIS EXISTS: every rule in go.json fixes something that fails silently.
// `renovate-config-validator --strict` passes on all of these regressions:
//   - without `rangeStrategy: bump` the `go` directive never produces an
//     update (go-mod-directive versioning keeps the current value under the
//     fleet's `pin`), so the group quietly carries only the image;
//   - without `internalChecksFilter: none` + the image exemption the soak puts
//     two different Go versions on one branch, because Docker Hub re-dates the
//     golang image on every base rebuild (golang:1.27.3-alpine was dated
//     18 days after Go 1.27.3), and the `GOTOOLCHAIN=local` image then fails
//     `go.mod requires go >= 1.27.3`;
//   - without docker.json's negation the image lands on `dockerfile bases`.
//
// Same approach as python-runtime.mjs: the real gomod extractor, the real
// package-rule engine, versioning, lookup filter and branch builder out of the
// Renovate dist the validate workflow's container ships.
//
// Locally:  npm i renovate && RENOVATE_DIST=./node_modules/renovate/dist node test/go-runtime.mjs

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

const { extractPackageFile } = await load('modules/manager/gomod/extract.js');
const { applyPackageRules } = await load('util/package-rules/index.js');
const { api: goModDirective } = await load('modules/versioning/go-mod-directive/index.js');
const { api: semver } = await load('modules/versioning/semver/index.js');
const { api: npmVersioning } = await load('modules/versioning/npm/index.js');
const { api: dockerVersioning } = await load('modules/versioning/docker/index.js');
const { filterInternalChecks } = await load('workers/repository/process/lookup/filter-checks.js');
const { generateBranchConfig } = await load('workers/repository/updates/generate.js');
const { checkMinimumReleaseAge } = await load('util/minimum-release-age.js');
const { init } = await load('logger/index.js');
await init();

const preset = (f) => JSON.parse(readFileSync(join(HERE, '..', f), 'utf8'));
const def = preset('default.json');

const failures = [];
const fail = (name, msg) => failures.push(`${name}\n    ${msg.replace(/\n/g, '\n    ')}`);
let checks = 0;
const ok = (name) => console.log(`  ok  ${name}`);

// Each consumer's real extends order. labelprint is the only Go repo today;
// the second shape guards a later :node/:python consumer adding :go.
const consumers = {
  labelprint: ['automerge.json', 'go.json', 'docker.json', 'alpine.json'],
  'polyglot (node + python + go)': ['automerge.json', 'node.json', 'python.json', 'go.json', 'docker.json', 'alpine.json'],
};
const consumerConfig = (files) => ({
  internalChecksFilter: 'strict', // Renovate's global default
  rangeStrategy: def.rangeStrategy, // default.json's top-level `pin`
  minimumReleaseAge: def.minimumReleaseAge,
  minimumReleaseAgeBehaviour: def.minimumReleaseAgeBehaviour,
  // Top-level and mergeable: preset lists concatenate (mergeChildConfig).
  postUpdateOptions: [def, ...files.map(preset)].flatMap((p) => p.postUpdateOptions ?? []),
  packageRules: [...def.packageRules, ...files.flatMap((f) => preset(f).packageRules)],
});
const labelprint = consumerConfig(consumers.labelprint);

// ---------------------------------------------------------------------------
// Extraction: the dep identities every rule below keys on
//
// labelprint's real go.mod shape, plus a `toolchain` line. If Renovate renames
// a depType or datasource, every matcher in go.json misses at once.
// ---------------------------------------------------------------------------
const goMod = [
  'module github.com/owine/labelprint',
  '',
  'go 1.27.2',
  '',
  'toolchain go1.27.2',
  '',
  'require github.com/ingridhq/zebrash v1.38.0',
  '',
  'require (',
  '\tgithub.com/golang/freetype v0.0.0-20170609003504-e2365dfdc4a0 // indirect',
  '\tgolang.org/x/image v0.47.0 // indirect',
  '\tgolang.org/x/text v0.43.0 // indirect',
  ')',
  '',
].join('\n');
const extracted = (await extractPackageFile(goMod, 'go.mod', {}))?.deps ?? [];
const byName = (depName, depType) => extracted.find((d) => d.depName === depName && (!depType || d.depType === depType));
const gomod = (d) => ({ ...d, manager: 'gomod', packageName: d.packageName ?? d.depName, packageFile: 'go.mod' });

{
  checks++;
  const name = 'gomod extracts the directives and requires go.json matches on';
  const got = extracted.map((d) => `${d.depName} ${d.depType} ${d.datasource}${d.versioning ? ' ' + d.versioning : ''}${d.enabled === false ? ' disabled' : ''}`);
  const want = [
    'go golang golang-version go-mod-directive',
    'go toolchain golang-version',
    'github.com/ingridhq/zebrash require go',
    'github.com/golang/freetype indirect go loose disabled',
    'golang.org/x/image indirect go disabled',
    'golang.org/x/text indirect go disabled',
  ];
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(name, `got\n  ${got.join('\n  ')}\nwant\n  ${want.join('\n  ')}`);
  else ok(name);
}
if (extracted.length !== 6) {
  console.error(`\ngomod extraction returned ${extracted.length} deps; the checks below cannot bind. See the failure above.\n`);
  for (const f of failures) console.error(`  FAIL ${f}\n`);
  process.exit(2);
}

const goDirective = gomod(byName('go', 'golang'));
const toolchainDirective = gomod(byName('go', 'toolchain'));
const imageDep = (depName, manager = 'dockerfile') => ({ manager, depName, packageName: depName, datasource: 'docker', packageFile: manager === 'dockerfile' ? 'Dockerfile' : 'compose.yaml' });
const setupGoDep = { manager: 'github-actions', depType: 'uses-with', depName: 'go', packageName: 'actions/go-versions', datasource: 'github-releases', versioning: 'npm', packageFile: '.github/workflows/ci.yml' };

// ---------------------------------------------------------------------------
// The `go` directive must actually bump
// ---------------------------------------------------------------------------
{
  checks++;
  const name = '`go` directive: rangeStrategy resolves to bump (the pin trap)';
  const res = await applyPackageRules({ ...labelprint, ...goDirective, updateType: 'patch' });
  if (res.rangeStrategy !== 'bump') fail(name, `got rangeStrategy ${JSON.stringify(res.rangeStrategy)}`);
  else ok(name);
}
for (const [currentValue, newVersion, want, why] of [
  ['1.27.2', '1.27.3', '1.27.3', 'a patch'],
  ['1.27.3', '1.28.0', '1.28.0', 'a minor'],
  ['1.22', '1.27.3', '1.27.3', 'a two-part line becomes the full triple'],
]) {
  checks++;
  const name = `\`go\` directive: bump rewrites go ${currentValue} -> ${want} (${why})`;
  const res = await applyPackageRules({ ...labelprint, ...goDirective, currentValue, updateType: 'patch' });
  const got = goModDirective.getNewValue({ currentValue, rangeStrategy: res.rangeStrategy, currentVersion: currentValue, newVersion });
  if (got !== want) fail(name, `got ${JSON.stringify(got)} under rangeStrategy ${res.rangeStrategy}`);
  else ok(name);
}
{
  // Not a preset assertion: proof the trap the bump rule exists for is still
  // real. If Renovate ever starts rewriting under pin/replace, this fails and
  // the rule's description needs revisiting (the rule itself stays harmless).
  checks++;
  const name = "`go` directive: Renovate's go-mod-directive still keeps the value under pin and replace (why the bump rule exists)";
  const wrong = ['pin', 'replace']
    .map((rangeStrategy) => [rangeStrategy, goModDirective.getNewValue({ currentValue: '1.27.2', rangeStrategy, currentVersion: '1.27.2', newVersion: '1.28.0' })])
    .filter(([, v]) => v !== '1.27.2');
  if (wrong.length) fail(name, `now rewrites: ${JSON.stringify(wrong)}`);
  else ok(name);
}
{
  checks++;
  const name = '`toolchain` directive keeps the fleet rangeStrategy and still rewrites (semver)';
  const res = await applyPackageRules({ ...labelprint, ...toolchainDirective, updateType: 'patch' });
  const got = semver.getNewValue({ currentValue: '1.27.2', rangeStrategy: res.rangeStrategy, currentVersion: '1.27.2', newVersion: '1.27.3' });
  if (res.rangeStrategy !== 'pin' || got !== '1.27.3') fail(name, `rangeStrategy ${res.rangeStrategy}, rewrote to ${JSON.stringify(got)}`);
  else ok(name);
}

{
  // Deliberately NOT python.json's `replace`: the group exists so CI tests the
  // exact Go the image ships, so a floating `1.27` is pinned once and then
  // moves with the image.
  checks++;
  const name = "setup-go: a two-part `go-version: '1.27'` is pinned to the exact triple, on the go toolchain branch";
  const res = await applyPackageRules({ ...labelprint, ...setupGoDep, currentValue: '1.27', updateType: 'pin' });
  // lookup/index.ts emits a pin for a non-single-version value under `pin`,
  // with newValue = getPinnedValue(currentVersion) ?? currentVersion.
  const pins = res.rangeStrategy === 'pin' && !npmVersioning.isSingleVersion('1.27');
  const got = pins ? (npmVersioning.getPinnedValue?.('1.27.3') ?? '1.27.3') : null;
  if (got !== '1.27.3' || res.groupName !== 'go toolchain')
    fail(name, `rangeStrategy ${res.rangeStrategy}, pinned to ${JSON.stringify(got)}, groupName ${JSON.stringify(res.groupName)}`);
  else ok(name);
}

// ---------------------------------------------------------------------------
// Grouping, through each consumer's extends order
// ---------------------------------------------------------------------------
const grouping = [
  { dep: goDirective, group: 'go toolchain', why: 'go.mod `go` directive' },
  { dep: toolchainDirective, group: 'go toolchain', why: 'go.mod `toolchain` directive' },
  { dep: imageDep('golang'), group: 'go toolchain', why: '`FROM golang:X-alpine` (docker.json negates it out of dockerfile bases)' },
  { dep: imageDep('docker.io/library/golang'), group: 'go toolchain', why: 'the fully-qualified image spelling' },
  { dep: setupGoDep, group: 'go toolchain', why: "setup-go's `go-version:` input (pre-seeded)" },
  { dep: imageDep('golangci/golangci-lint'), group: 'dockerfile bases', why: 'a look-alike image stays in dockerfile bases' },
  { dep: imageDep('alpine'), group: 'dockerfile bases', why: 'the runtime stage stays in dockerfile bases' },
  { dep: { manager: 'dockerfile', depName: 'go', packageName: 'go', datasource: 'apk', depType: 'install', packageFile: 'Dockerfile' }, group: 'alpine packages', why: "an apk `go` package stays in alpine packages (datasource scope)", alpineOnly: true },
  { dep: gomod(byName('golang.org/x/text')), group: 'golang-x', why: 'indirect golang.org/x/text joins golang-x' },
  { dep: gomod(byName('golang.org/x/image')), group: 'golang-x', why: 'indirect golang.org/x/image joins golang-x' },
  { dep: gomod(byName('github.com/ingridhq/zebrash')), group: 'all non-major dependencies', why: 'an ordinary require rides the bundle' },
  { dep: gomod(byName('github.com/golang/freetype')), group: 'all non-major dependencies', why: '`github.com/golang/...` is not golang.org/x' },
];

for (const [repo, files] of Object.entries(consumers)) {
  checks++;
  const name = `grouping: every member and look-alike lands where expected (${repo})`;
  const cfg = consumerConfig(files);
  const wrong = [];
  for (const g of grouping) {
    if (g.alpineOnly && !files.includes('alpine.json')) continue;
    const res = await applyPackageRules({ ...cfg, ...g.dep, updateType: 'patch' });
    if (res.groupName !== g.group) wrong.push(`${g.dep.manager} ${g.dep.depName} (${g.why}): groupName ${JSON.stringify(res.groupName)}, expected ${JSON.stringify(g.group)}`);
    if (res.enabled === false) wrong.push(`${g.dep.manager} ${g.dep.depName}: disabled`);
    if (g.group === 'go toolchain' && res.semanticCommitType !== 'deps') wrong.push(`${g.dep.manager} ${g.dep.depName}: typed ${res.semanticCommitType}:, expected deps:`);
  }
  if (wrong.length) fail(name, wrong.join('\n'));
  else ok(name);
}

// ---------------------------------------------------------------------------
// Indirect modules and postUpdateOptions
// ---------------------------------------------------------------------------
{
  checks++;
  const name = 'indirect modules are re-enabled, and keep automerge + deps:';
  const wrong = [];
  for (const d of extracted.filter((x) => x.depType === 'indirect')) {
    const res = await applyPackageRules({ ...labelprint, ...gomod(d), updateType: 'minor' });
    if (res.enabled !== true) wrong.push(`${d.depName}: enabled ${res.enabled}`);
    if (res.automerge !== true) wrong.push(`${d.depName}: automerge ${res.automerge}`);
    if (res.semanticCommitType !== 'deps') wrong.push(`${d.depName}: typed ${res.semanticCommitType}:`);
  }
  if (wrong.length) fail(name, wrong.join('\n'));
  else ok(name);
}
// postUpdateOptions must reach the BRANCH config, which artifact steps read.
// generateBranchConfig spreads `upgrades[0]` (sorted by depName) over it, so
// a gomod-scoped packageRule only counted when a gomod upgrade sorted first.
// Both shapes below put a non-gomod upgrade first.
for (const [why, members] of [
  ['a go toolchain branch led by setup-go (depName `go` ties with go.mod; manager order keeps it first)', [[setupGoDep, '.github/workflows/ci.yml'], [goDirective, 'go.mod'], [imageDep('golang'), 'Dockerfile']]],
  ['an npm + go bundle led by an npm dep', [[{ manager: 'npm', depName: 'axios', packageName: 'axios', datasource: 'npm', depType: 'dependencies' }, 'package.json'], [gomod(byName('github.com/ingridhq/zebrash')), 'go.mod']]],
]) {
  checks++;
  const name = `gomodTidy + gomodUpdateImportPaths reach the branch config: ${why}`;
  const upgrades = [];
  for (const [dep, packageFile] of members) {
    const res = await applyPackageRules({ ...labelprint, ...dep, updateType: 'patch' });
    upgrades.push({ ...res, packageFile, branchName: 'renovate/x', newVersion: '1.0.0' });
  }
  const branch = generateBranchConfig(upgrades);
  const missing = ['gomodTidy', 'gomodUpdateImportPaths'].filter((o) => !branch.postUpdateOptions?.includes(o));
  if (missing.length) fail(name, `branch led by ${branch.upgrades[0].manager} ${branch.upgrades[0].depName} has postUpdateOptions ${JSON.stringify(branch.postUpdateOptions)}`);
  else ok(name);
}

// ---------------------------------------------------------------------------
// Soak per member, and internalChecksFilter
// ---------------------------------------------------------------------------
const DAY = 86_400_000;
const soakDays = (res) => checkMinimumReleaseAge(res, new Date().toISOString()).minimumReleaseAgeMs / DAY;
const soaks = [
  { dep: goDirective, updateType: 'patch', days: 3, why: 'the `go` directive keeps the 3-day soak (Go release day)' },
  { dep: goDirective, updateType: 'minor', days: 7, why: 'a Go minor soaks 7 days' },
  { dep: toolchainDirective, updateType: 'patch', days: 3, why: 'the `toolchain` directive keeps the soak' },
  { dep: setupGoDep, updateType: 'patch', days: 3, why: 'setup-go keeps the soak' },
  { dep: setupGoDep, updateType: 'minor', days: 7, why: 'setup-go soaks 7 days on a minor' },
  { dep: imageDep('golang'), updateType: 'patch', days: 0, why: 'the golang image in a Dockerfile is exempt (Docker Hub re-dates it)' },
  { dep: imageDep('golang'), updateType: 'minor', days: 0, why: 'exempt on a minor too: the go.mod half carries the 7 days' },
  { dep: imageDep('docker.io/library/golang'), updateType: 'patch', days: 0, why: 'the qualified spelling is exempt too' },
  { dep: imageDep('golang', 'docker-compose'), updateType: 'patch', days: 3, why: 'a golang image outside a Dockerfile keeps the soak' },
  { dep: imageDep('golangci/golangci-lint'), updateType: 'patch', days: 3, why: 'a look-alike image keeps the soak' },
  { dep: gomod(byName('golang.org/x/text')), updateType: 'minor', days: 3, why: 'modules keep the fleet soak' },
];
for (const s of soaks) {
  checks++;
  const name = `soak: ${s.dep.manager} ${s.dep.depName} (${s.updateType}) — ${s.why}`;
  const res = await applyPackageRules({ ...labelprint, ...s.dep, updateType: s.updateType });
  const days = soakDays(res);
  if (days !== s.days) fail(name, `expected ${s.days} days, got ${days} (minimumReleaseAge ${JSON.stringify(res.minimumReleaseAge)})`);
  else ok(name);
}
{
  checks++;
  const name = 'soak: internalChecksFilter is relaxed for the go toolchain group only';
  const wrong = [];
  for (const dep of [goDirective, toolchainDirective, imageDep('golang'), imageDep('docker.io/library/golang'), setupGoDep]) {
    const res = await applyPackageRules({ ...labelprint, ...dep });
    if (res.internalChecksFilter !== 'none') wrong.push(`${dep.manager} ${dep.depName}: ${res.internalChecksFilter}`);
  }
  const apkGo = { manager: 'dockerfile', depName: 'go', packageName: 'go', datasource: 'apk', depType: 'install', packageFile: 'Dockerfile' };
  for (const dep of [imageDep('golangci/golangci-lint'), imageDep('alpine'), gomod(byName('golang.org/x/text')), apkGo]) {
    const res = await applyPackageRules({ ...labelprint, ...dep });
    if (res.internalChecksFilter !== 'strict') wrong.push(`${dep.manager} ${dep.depName} should stay strict, got ${res.internalChecksFilter}`);
  }
  const apkMinor = await applyPackageRules({ ...labelprint, ...apkGo, updateType: 'minor' });
  if (apkMinor.addLabels?.includes('breaking')) wrong.push('apk go minor: picked up the Go minor gate labels');
  if (wrong.length) fail(name, wrong.join('\n'));
  else ok(name);
}

// ---------------------------------------------------------------------------
// The soak must not split the group
//
// labelprint's shape: go.mod's `go` line + the golang build stage. Runs the
// real lookup filter and branch builder over both upgrades and requires one
// branch, one Go version, and `renovate/stability-days` pending until the Go
// release has soaked.
// ---------------------------------------------------------------------------
const lookup = async (dep, current, versioning, releases, updateType) => {
  const cfg = await applyPackageRules({ ...labelprint, ...dep, updateType });
  const sorted = releases.map(([version, days]) => ({ version, releaseTimestamp: new Date(Date.now() - days * DAY).toISOString() }));
  const { release, pendingChecks } = await filterInternalChecks({ ...cfg, currentVersion: current }, versioning, 'non-major', sorted);
  return { ...cfg, branchName: 'renovate/go-toolchain', newVersion: release.version, releaseTimestamp: release.releaseTimestamp, pendingChecks };
};

const timelines = [
  {
    why: 'image re-dated by a base rebuild (measured: Go 1.27.3 on 2026-10-19, golang:1.27.3-alpine dated 2026-11-06)',
    go: [['1.27.3', 18]],
    image: [['1.27.3-alpine', 0]],
    updateType: 'patch',
    stability: 'green',
  },
  {
    why: 'fresh Go release, image already pushed',
    go: [['1.27.3', 1]],
    image: [['1.27.3-alpine', 1]],
    updateType: 'patch',
    stability: 'yellow',
  },
  {
    why: 'older patch soaked, newer one still soaking (version skew)',
    go: [['1.27.3', 10], ['1.27.4', 1]],
    image: [['1.27.3-alpine', 1], ['1.27.4-alpine', 1]],
    updateType: 'patch',
    stability: 'yellow',
  },
  {
    why: 'a Go minor 5 days old is still inside its 7-day soak',
    go: [['1.28.0', 5]],
    image: [['1.28.0-alpine', 0]],
    updateType: 'minor',
    stability: 'yellow',
  },
];
for (const t of timelines) {
  checks++;
  const name = `soak: one branch, one version — ${t.why}`;
  const go = await lookup(goDirective, '1.27.2', goModDirective, t.go, t.updateType);
  const image = await lookup(imageDep('golang'), '1.27.2-alpine', dockerVersioning, t.image, t.updateType);
  const upgrades = [
    { ...go, packageFile: 'go.mod' },
    { ...image, packageFile: 'Dockerfile' },
  ];
  const wrong = [];
  if (upgrades.every((u) => u.pendingChecks)) wrong.push('every upgrade is pending, so no branch would open at all');
  const branch = generateBranchConfig(upgrades.map((u) => ({ ...u }))).upgrades;
  if (branch.length !== 2) wrong.push(`branch kept only ${JSON.stringify(branch.map((u) => u.packageFile))}; the rest were dropped as pending`);
  const versions = new Set(branch.map((u) => u.newVersion.replace(/-alpine$/, '')));
  if (versions.size !== 1) wrong.push(`halves target different versions: ${JSON.stringify([...versions])} — GOTOOLCHAIN=local fails the build`);
  const stability = branch.some((u) => checkMinimumReleaseAge(u, u.releaseTimestamp).isPending) ? 'yellow' : 'green';
  if (stability !== t.stability) wrong.push(`renovate/stability-days would be ${stability}, expected ${t.stability}`);
  if (wrong.length) fail(name, wrong.join('\n'));
  else ok(`${name} (-> ${[...versions][0]}, stability-days ${stability})`);
}

// ---------------------------------------------------------------------------
// A Go minor is reviewed, a patch automerges
// ---------------------------------------------------------------------------
const members = [goDirective, toolchainDirective, imageDep('golang'), imageDep('docker.io/library/golang'), setupGoDep];
for (const [repo, files] of Object.entries(consumers)) {
  checks++;
  const name = `review: Go minor is manual, patch automerges (${repo})`;
  const cfg = consumerConfig(files);
  const wrong = [];
  for (const dep of members) {
    const label = `${dep.manager} ${dep.depName}${dep.depType ? ' ' + dep.depType : ''}`;
    const minor = await applyPackageRules({ ...cfg, ...dep, updateType: 'minor' });
    const patch = await applyPackageRules({ ...cfg, ...dep, updateType: 'patch' });
    if (minor.automerge !== false) wrong.push(`${label} minor: automerge ${minor.automerge}`);
    for (const l of ['breaking', 'needs-review'])
      if (!minor.addLabels?.includes(l)) wrong.push(`${label} minor: missing label ${l}`);
    if (patch.automerge !== true) wrong.push(`${label} patch: automerge ${patch.automerge}`);
    if (patch.addLabels?.includes('breaking')) wrong.push(`${label} patch: labelled breaking`);
  }
  if (wrong.length) fail(name, wrong.join('\n'));
  else ok(name);
}

// Branch level: automerge is every(upgrade.automerge), addLabels is a union.
for (const [updateType, automerge] of [['minor', false], ['patch', true]]) {
  checks++;
  const name = `review: the assembled go-toolchain branch for a ${updateType} has automerge ${automerge}`;
  const upgrades = [];
  for (const [dep, packageFile] of [[goDirective, 'go.mod'], [imageDep('golang'), 'Dockerfile']]) {
    const res = await applyPackageRules({ ...labelprint, ...dep, updateType });
    upgrades.push({ ...res, packageFile, branchName: 'renovate/go-toolchain', newVersion: '1.28.0' });
  }
  const branch = generateBranchConfig(upgrades);
  const wrong = [];
  if (branch.automerge !== automerge) wrong.push(`branch automerge ${branch.automerge}`);
  const labelled = branch.addLabels?.includes('breaking') && branch.addLabels?.includes('needs-review');
  if (!!labelled !== !automerge) wrong.push(`branch addLabels ${JSON.stringify(branch.addLabels)}`);
  if (wrong.length) fail(name, wrong.join('\n'));
  else ok(name);
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
