#!/usr/bin/env node
// Behavior tests for python.json's `python runtime` group: the `requires-python`
// shapes, then every member's grouping, soak and review (the pin, the image,
// `.python-version`, and the `uv python install` workflow lines).
//
// WHY THIS EXISTS: python.json tracks an exact `requires-python = "==X.Y.Z"`
// through the NATIVE pep621 manager (so Renovate regenerates uv.lock itself)
// and disables every other `requires-python` shape with one negated
// `matchCurrentValue` regex. `renovate-config-validator --strict` only checks
// that the regex is a string. It cannot tell whether `>=3.14` is still left
// alone, or whether the exact pin still lands in the `python runtime` group
// next to the Dockerfile base image. A regression in either direction is
// silent: floor ranges start getting pinned fleet-wide, or the exact pin
// drops out of the group and the two halves deadlock (owine/trip-tracker
// #180/#182). It also runs the real release-age filter and branch builder,
// because the soak can split the group even when grouping is right
// (owine/trip-tracker #282/#316).
//
// Same approach as custom-managers.mjs: import the real extractor, the real
// package-rule engine and the real pep440 versioning out of the Renovate dist
// the validate workflow's container already ships. No toolchain, no lockfile.
//
// Locally:  npm i renovate && RENOVATE_DIST=./node_modules/renovate/dist node test/python-runtime.mjs

import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const { extractPackageFile } = await load('modules/manager/pep621/extract.js');
const { extractPackageFile: extractRegex } = await load('modules/manager/custom/regex/index.js');
const { api: npmVersioning } = await load('modules/versioning/npm/index.js');
const { normalizeDepNames } = await load('workers/repository/extract/manager-files.js');
const { applyPackageRules } = await load('util/package-rules/index.js');
const { api: pep440 } = await load('modules/versioning/pep440/index.js');
const { api: dockerVersioning } = await load('modules/versioning/docker/index.js');
const { filterInternalChecks } = await load('workers/repository/process/lookup/filter-checks.js');
const { generateBranchConfig } = await load('workers/repository/updates/generate.js');
const { checkMinimumReleaseAge } = await load('util/minimum-release-age.js');
const { GlobalConfig } = await load('config/global.js');
const { init } = await load('logger/index.js');
await init();

// The uv processor looks for a sibling uv.lock under localDir; an empty
// workspace makes that a clean "no lock file" instead of a filesystem error.
const workspace = mkdtempSync(join(tmpdir(), 'renovate-python-runtime-'));
GlobalConfig.set({ localDir: workspace });
process.on('exit', () => rmSync(workspace, { recursive: true, force: true }));

// Consumer order: every fleet repo extends :python BEFORE :docker. The
// dockerfile cases below only pass because docker.json's `dockerfile bases`
// rule negates the python image names, not because of this ordering.
const preset = (f) => JSON.parse(readFileSync(join(HERE, '..', f), 'utf8'));
const packageRules = [...preset('python.json').packageRules, ...preset('docker.json').packageRules];

// The python.json `requires-python` dep exactly as Renovate's extract phase
// hands it on: pep621 sets only packageName, and normalizeDepNames backfills
// depName from it before any packageRule sees the dep.
const extractRequiresPython = async (requiresPython) => {
  const content = `[project]\nname = "fixture"\nversion = "0.1.0"\nrequires-python = "${requiresPython}"\n`;
  const res = await extractPackageFile(content, 'pyproject.toml', {});
  const dep = res?.deps.find((d) => d.depType === 'requires-python');
  if (dep) normalizeDepNames(dep);
  return dep;
};

const failures = [];
const fail = (name, msg) => failures.push(`${name}\n    ${msg.replace(/\n/g, '\n    ')}`);
let checks = 0;

// ---------------------------------------------------------------------------
// pep621 must stay reachable
//
// The shape cases below call the extractor directly, so they would still pass
// with pep621 switched off. A preset that switched it off would stop every
// exact pin from opening a PR at all, so check the two ways a preset can do
// that: `pep621.enabled: false`, or an `enabledManagers` list without it.
// ---------------------------------------------------------------------------
{
  checks++;
  const name = 'pep621 is enabled by python.json and not excluded by any preset';
  const presets = readdirSync(join(HERE, '..')).filter((f) => f.endsWith('.json') && f !== 'renovate.json');
  const wrong = [];
  if (preset('python.json').pep621?.enabled !== true) wrong.push('python.json: pep621.enabled is not true');
  for (const f of presets) {
    const p = preset(f);
    if (p.pep621?.enabled === false) wrong.push(`${f}: sets pep621.enabled: false`);
    if (Array.isArray(p.enabledManagers) && !p.enabledManagers.includes('pep621'))
      wrong.push(`${f}: enabledManagers ${JSON.stringify(p.enabledManagers)} excludes pep621`);
  }
  if (wrong.length) fail(name, wrong.join('\n'));
  else console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// requires-python shapes
//
// `tracked` cases must stay enabled, join `python runtime`, and rewrite to the
// next exact triple under the fleet's `rangeStrategy: pin`. Every other shape
// is metadata and must be disabled.
// ---------------------------------------------------------------------------
const shapes = [
  { value: '==3.14.7', tracked: true, newValue: '==3.14.8', why: 'the exact pin is tracked and stays exact' },
  { value: '== 3.14.7', tracked: true, newValue: '==3.14.8', why: 'whitespace after `==` is tolerated, as the old regex manager did' },
  { value: '>=3.14', tracked: false, why: 'a floor range is metadata (youth-activity-scheduler)' },
  { value: '>=3.10', tracked: false, why: 'a floor range is metadata' },
  { value: '~=3.14', tracked: false, why: 'a compatible-release range is metadata' },
  { value: '==3.14.*', tracked: false, why: 'a wildcard pin is metadata' },
  { value: '==3.14', tracked: false, why: 'a two-part pin is not the exact triple' },
  { value: '===3.14.7', tracked: false, why: 'arbitrary equality is not the `==` triple' },
  { value: '==3.14.7,<4', tracked: false, why: 'a compound specifier is not a bare pin' },
];

for (const s of shapes) {
  checks++;
  const name = `requires-python = "${s.value}" — ${s.why}`;
  const dep = await extractRequiresPython(s.value);
  if (!dep) {
    fail(name, 'pep621 extracted no requires-python dep at all');
    continue;
  }
  if (dep.depName !== 'python' || dep.packageName !== 'python' || dep.datasource !== 'python-version') {
    fail(name, `unexpected dep identity: ${JSON.stringify({ depName: dep.depName, packageName: dep.packageName, datasource: dep.datasource })}`);
    continue;
  }

  const res = await applyPackageRules({ ...dep, manager: 'pep621', updateType: 'patch', packageRules });
  const disabled = res.enabled === false;

  if (!s.tracked) {
    if (!disabled) fail(name, `expected enabled: false, got enabled: ${res.enabled} (groupName: ${res.groupName})`);
    else console.log(`  ok  ${name}`);
    continue;
  }

  if (disabled) {
    fail(name, 'the exact pin was DISABLED — no python runtime PR would ever open');
    continue;
  }
  if (res.groupName !== 'python runtime') {
    fail(name, `expected groupName 'python runtime', got ${JSON.stringify(res.groupName)} — the pin would split from its base image`);
    continue;
  }
  const newValue = pep440.getNewValue({
    currentValue: s.value,
    rangeStrategy: 'pin', // default.json's top-level rangeStrategy
    currentVersion: '3.14.7',
    newVersion: '3.14.8',
  });
  if (newValue !== s.newValue) {
    fail(name, `pep440 rewrote it to ${JSON.stringify(newValue)}, expected ${JSON.stringify(s.newValue)}`);
    continue;
  }
  console.log(`  ok  ${name} (-> ${newValue}, python runtime)`);
}

// ---------------------------------------------------------------------------
// The other half of the group: the Dockerfile base image must land on the
// same branch, and look-alike images must not.
// ---------------------------------------------------------------------------
const images = [
  { depName: 'python', group: 'python runtime', why: '`FROM python:X` joins the runtime group' },
  { depName: 'docker.io/library/python', group: 'python runtime', why: 'the fully-qualified spelling joins it too' },
  { depName: 'python-slim', group: 'dockerfile bases', why: 'a look-alike name stays in dockerfile bases' },
];

for (const i of images) {
  checks++;
  const name = `dockerfile ${i.depName} — ${i.why}`;
  const res = await applyPackageRules({
    manager: 'dockerfile',
    depName: i.depName,
    packageName: i.depName,
    datasource: 'docker',
    updateType: 'patch',
    packageRules,
  });
  if (res.groupName !== i.group) fail(name, `expected groupName ${JSON.stringify(i.group)}, got ${JSON.stringify(res.groupName)}`);
  else console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// The release-age soak must not split the group
//
// The two halves are aged by different datasources, and Docker Hub re-dates
// an official image on every rebuild, so their soak clocks disagree. Under
// `internalChecksFilter: strict` that drops whichever half is still pending
// from the branch: owine/trip-tracker #282/#316 opened with only
// `requires-python`. Exempting the image alone just flips which half is
// dropped. So these cases run the real lookup filter and the real branch
// builder over all three upgrades of a trip-tracker-shaped repo (pyproject +
// builder + runtime stages) and require the branch to keep all three on one
// version, with the soak still holding `renovate/stability-days` pending.
//
// Uses the consumer's FULL extends order (base -> :automerge -> :python ->
// :docker): the soak tiers live in default.json, so testing python.json
// alone could not catch a precedence regression.
// ---------------------------------------------------------------------------
const def = preset('default.json');
const consumer = {
  internalChecksFilter: 'strict', // Renovate's global default
  minimumReleaseAge: def.minimumReleaseAge,
  minimumReleaseAgeBehaviour: def.minimumReleaseAgeBehaviour,
  packageRules: [
    ...def.packageRules,
    ...preset('automerge.json').packageRules,
    ...packageRules, // python.json, docker.json
  ],
};

// Each consumer's real extends order. automerge.json comes first everywhere,
// and :node/:alpine/:home-assistant come after :python in some.
const consumers = {
  'trip-tracker': ['automerge.json', 'python.json', 'docker.json'],
  'youth-activity-scheduler': ['automerge.json', 'node.json', 'python.json', 'docker.json'],
  'claude-terminal-home-assistant': ['automerge.json', 'python.json', 'docker.json', 'alpine.json', 'node.json', 'home-assistant.json'],
};
const consumerConfig = (files) => ({
  ...consumer,
  packageRules: [...def.packageRules, ...files.flatMap((f) => preset(f).packageRules)],
});
const pyprojectDep = { manager: 'pep621', depType: 'requires-python', depName: 'python', packageName: 'python', datasource: 'python-version' };
const imageDep = (depName) => ({ manager: 'dockerfile', depName, packageName: depName, datasource: 'docker' });
// pyenv looks `.python-version` up as a Docker Hub tag: datasource docker,
// the same as the image. Only `matchManagers` can tell them apart.
const pyenvDep = { manager: 'pyenv', depName: 'python', packageName: 'python', datasource: 'docker' };
// python.json's `uv python install` customManager, and Renovate's native
// extraction of setup-python's `python-version:` input.
const workflowDep = { manager: 'regex', depType: 'uv-python-install', depName: 'python', packageName: 'python', datasource: 'python-version', packageFile: '.github/workflows/ci.yml' };
const setupPythonDep = { manager: 'github-actions', depType: 'uses-with', depName: 'python', packageName: 'actions/python-versions', datasource: 'github-releases', packageFile: '.github/workflows/ci.yml' };

// Which soak each dep resolves to, in effective days (Renovate treats `null`
// and `0 days` alike). The image is exempt; the python-version half keeps 3
// days, and 7 for a major; any other image keeps the fleet soak.
const DAY = 86_400_000;
const soaks = [
  { dep: pyprojectDep, updateType: 'patch', days: 3, why: 'requires-python keeps the 3-day soak' },
  { dep: pyprojectDep, updateType: 'major', days: 7, why: 'requires-python keeps the 7-day major soak' },
  { dep: imageDep('python'), updateType: 'patch', days: 0, why: 'the python image is exempt' },
  { dep: imageDep('python'), updateType: 'major', days: 0, why: 'the python image is exempt for a major too (the pyproject half carries the 7 days)' },
  { dep: imageDep('docker.io/library/python'), updateType: 'patch', days: 0, why: 'the fully-qualified spelling is exempt too' },
  { dep: imageDep('python-slim'), updateType: 'patch', days: 3, why: 'a look-alike image keeps the soak' },
  { dep: pyenvDep, updateType: 'patch', days: 3, why: '.python-version keeps the soak: the exemption is Dockerfile-only, though pyenv is datasource docker too (youth-activity-scheduler)' },
  { dep: pyenvDep, updateType: 'major', days: 7, why: '.python-version keeps the 7-day major soak' },
  { dep: workflowDep, updateType: 'patch', days: 3, why: 'the `uv python install` line soaks on the python-version clock, like requires-python' },
  { dep: { ...imageDep('python'), manager: 'docker-compose' }, updateType: 'patch', days: 3, why: 'a python image outside a Dockerfile keeps the soak' },
  { dep: imageDep('postgres'), updateType: 'patch', days: 3, why: 'every other image keeps the soak' },
  { dep: imageDep('postgres'), updateType: 'major', days: 7, why: 'every other image keeps the 7-day major soak' },
];

for (const s of soaks) {
  checks++;
  const name = `soak: ${s.dep.manager} ${s.dep.depName} (${s.updateType}) — ${s.why}`;
  const res = await applyPackageRules({ ...consumer, ...s.dep, updateType: s.updateType });
  const days = checkMinimumReleaseAge(res, new Date().toISOString()).minimumReleaseAgeMs / DAY;
  if (days !== s.days) fail(name, `expected a ${s.days}-day soak, got ${days} (minimumReleaseAge: ${JSON.stringify(res.minimumReleaseAge)})`);
  else console.log(`  ok  ${name}`);
}

{
  checks++;
  const name = 'soak: internalChecksFilter is relaxed for the python runtime group only';
  const wrong = [];
  for (const dep of [pyprojectDep, imageDep('python'), imageDep('docker.io/library/python'), pyenvDep, workflowDep, setupPythonDep]) {
    const res = await applyPackageRules({ ...consumer, ...dep });
    if (res.internalChecksFilter !== 'none') wrong.push(`${dep.manager} ${dep.depName}: ${res.internalChecksFilter}`);
  }
  for (const dep of [imageDep('python-slim'), imageDep('postgres')]) {
    const res = await applyPackageRules({ ...consumer, ...dep });
    if (res.internalChecksFilter !== 'strict') wrong.push(`${dep.manager} ${dep.depName} should stay strict, got ${res.internalChecksFilter}`);
  }
  if (wrong.length) fail(name, wrong.join('\n'));
  else console.log(`  ok  ${name}`);
}

// Lookup one dep the way Renovate does: package rules, then the internal-checks
// filter over its candidate releases (`[version, ageInDays]`).
const lookup = async (dep, current, versioning, releases) => {
  const cfg = await applyPackageRules({ ...consumer, ...dep });
  const sorted = releases.map(([version, days]) => ({ version, releaseTimestamp: new Date(Date.now() - days * DAY).toISOString() }));
  const { release, pendingChecks } = await filterInternalChecks({ ...cfg, currentVersion: current }, versioning, 'non-major', sorted);
  return { ...cfg, branchName: 'renovate/python-runtime', newVersion: release.version, releaseTimestamp: release.releaseTimestamp, pendingChecks };
};

const timelines = [
  {
    why: 'image re-dated by a Debian rebuild (trip-tracker #316)',
    cpython: [['3.15.0', 10]],
    image: [['3.15.0-slim', 2]],
    stability: 'green',
  },
  {
    why: 'fresh CPython release, image already pushed (the inverse split)',
    cpython: [['3.15.0', 1]],
    image: [['3.15.0-slim', 1]],
    stability: 'yellow',
  },
  {
    why: 'older patch soaked, newer minor still soaking (version skew)',
    cpython: [['3.14.9', 10], ['3.15.0', 1]],
    image: [['3.14.9-slim', 1], ['3.15.0-slim', 1]],
    stability: 'yellow',
  },
];

for (const t of timelines) {
  checks++;
  const name = `soak: one branch, one version — ${t.why}`;
  const pyproject = await lookup(pyprojectDep, '3.14.8', pep440, t.cpython);
  const image = await lookup(imageDep('python'), '3.14.8-slim', dockerVersioning, t.image);
  const upgrades = [
    { ...pyproject, depName: 'python', packageFile: 'pyproject.toml' },
    { ...image, packageFile: 'Dockerfile (builder)' },
    { ...image, packageFile: 'Dockerfile (runtime)' },
  ];
  const wrong = [];
  if (upgrades.every((u) => u.pendingChecks)) wrong.push('every upgrade is pending, so no branch would open at all');
  const branch = generateBranchConfig(upgrades.map((u) => ({ ...u }))).upgrades;
  const kept = branch.map((u) => u.packageFile).sort();
  if (kept.length !== 3) wrong.push(`branch kept only ${JSON.stringify(kept)}; the rest were dropped as pending`);
  const versions = new Set(branch.map((u) => u.newVersion.replace(/-slim$/, '')));
  if (versions.size !== 1) wrong.push(`halves target different versions: ${JSON.stringify([...versions])}`);
  // The same check the branch worker uses to set renovate/stability-days.
  const pending = branch.filter((u) => checkMinimumReleaseAge(u, u.releaseTimestamp).isPending);
  const stability = pending.length ? 'yellow' : 'green';
  if (stability !== t.stability)
    wrong.push(`renovate/stability-days would be ${stability}, expected ${t.stability} (pending: ${JSON.stringify(pending.map((u) => u.packageFile))})`);
  if (wrong.length) fail(name, wrong.join('\n'));
  else console.log(`  ok  ${name} (-> ${[...versions][0]}, stability-days ${stability})`);
}

// The `.python-version` + Dockerfile shape (owine/youth-activity-scheduler,
// whose `requires-python` is a disabled floor). Both halves are datasource
// docker, so before the exemption was scoped to the dockerfile manager NEITHER
// carried a soak and stability-days went green on a day-old release.
// `.python-version` is now aged by Docker Hub's re-pushed tag, which can only
// make a release look younger: the soak can run long, never short.
const pyenvTimelines = [
  { why: 'tag pushed 10 days ago', pyenv: [['3.15.0', 10]], image: [['3.15.0-slim', 10]], stability: 'green' },
  { why: 'fresh release, or a re-pushed tag: .python-version still soaking', pyenv: [['3.15.0', 1]], image: [['3.15.0-slim', 1]], stability: 'yellow' },
  { why: 'image re-pushed, .python-version tag settled', pyenv: [['3.15.0', 10]], image: [['3.15.0-slim', 1]], stability: 'green' },
];

for (const t of pyenvTimelines) {
  checks++;
  const name = `soak: .python-version + Dockerfile — ${t.why}`;
  const pyenv = await lookup(pyenvDep, '3.14.8', dockerVersioning, t.pyenv);
  const image = await lookup(imageDep('python'), '3.14.8-slim', dockerVersioning, t.image);
  const branch = generateBranchConfig([
    { ...pyenv, packageFile: '.python-version' },
    { ...image, packageFile: 'Dockerfile' },
  ]).upgrades;
  const wrong = [];
  if (branch.length !== 2) wrong.push(`branch kept only ${JSON.stringify(branch.map((u) => u.packageFile))}`);
  const versions = new Set(branch.map((u) => u.newVersion.replace(/-slim$/, '')));
  if (versions.size !== 1) wrong.push(`halves target different versions: ${JSON.stringify([...versions])}`);
  const stability = branch.some((u) => checkMinimumReleaseAge(u, u.releaseTimestamp).isPending) ? 'yellow' : 'green';
  if (stability !== t.stability) wrong.push(`renovate/stability-days would be ${stability}, expected ${t.stability}`);
  if (wrong.length) fail(name, wrong.join('\n'));
  else console.log(`  ok  ${name} (-> ${[...versions][0]}, stability-days ${stability})`);
}

// ---------------------------------------------------------------------------
// `uv python install X.Y` in workflows
//
// python.json's customManager, extracted from owine/trip-tracker's real ci.yml
// shape (four stale `3.14` lines after #316) and run through each consumer's
// rule chain. It must land on `python runtime`, not automerge.json's CI
// group; it must be typed `deps:`, so a CI line cannot retype a runtime bump
// `ci:`; and it must keep its precision under the rangeStrategy the rules
// actually resolve. test/custom-managers.mjs covers the regex itself.
// ---------------------------------------------------------------------------
const uvManager = preset('python.json').customManagers.find((m) => m.depTypeTemplate === 'uv-python-install');
const tripTrackerCi = ['lint', 'typecheck', 'test', 'audit']
  .map((job) => `  ${job}:\n    runs-on: ubuntu-26.04\n    steps:\n      - uses: astral-sh/setup-uv@v10\n      - run: uv python install 3.14\n      - run: uv sync --frozen\n`)
  .join('');
const uvDeps = (extractRegex(`on: [push]\njobs:\n${tripTrackerCi}`, '.github/workflows/ci.yml', uvManager)?.deps ?? []).map((d) => {
  normalizeDepNames(d);
  return d;
});

{
  checks++;
  const name = 'uv python install: trip-tracker ci.yml yields its four `3.14` lines as python/python-version';
  const got = uvDeps.map((d) => `${d.depName}@${d.currentValue} ${d.datasource} ${d.versioning} ${d.depType}`);
  const want = Array(4).fill('python@3.14 python-version npm uv-python-install');
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(name, `got ${JSON.stringify(got)}`);
  else console.log(`  ok  ${name}`);
}

for (const [repo, files] of Object.entries(consumers)) {
  checks++;
  const name = `uv python install: joins python runtime as deps:, keeps X.Y precision (${repo})`;
  const cfg = consumerConfig(files);
  const wrong = [];
  for (const [updateType, currentValue, currentVersion, newVersion, want] of [
    ['minor', '3.14', '3.14.8', '3.15.0', '3.15'],
    ['patch', '3.14', '3.14.8', '3.14.9', null], // still satisfies the x-range: no update
    ['minor', '3.14.8', '3.14.8', '3.15.0', '3.15.0'],
    ['patch', '3.14.8', '3.14.8', '3.14.9', '3.14.9'],
  ]) {
    const label = `${currentValue} -> ${newVersion}`;
    const res = await applyPackageRules({ ...cfg, ...uvDeps[0], manager: 'regex', packageFile: '.github/workflows/ci.yml', currentValue, updateType });
    if (res.groupName !== 'python runtime') wrong.push(`${label}: groupName ${JSON.stringify(res.groupName)}`);
    if (res.semanticCommitType !== 'deps') wrong.push(`${label}: typed ${res.semanticCommitType}:`);
    // Renovate's lookup emits a `pin` update for any non-single-version value
    // under rangeStrategy pin, which would turn `3.14` into `3.14.8`.
    if (res.rangeStrategy !== 'replace') wrong.push(`${label}: rangeStrategy ${res.rangeStrategy}, expected replace (the pin trap)`);
    const satisfied = npmVersioning.matches(newVersion, currentValue);
    const newValue = satisfied ? null : npmVersioning.getNewValue({ currentValue, rangeStrategy: res.rangeStrategy, currentVersion, newVersion });
    if (newValue !== want) wrong.push(`${label}: rewrote to ${JSON.stringify(newValue)}, expected ${JSON.stringify(want)}`);
    if (updateType === 'minor' && res.automerge !== false) wrong.push(`${label}: minor automerge ${res.automerge}`);
  }
  if (wrong.length) fail(name, wrong.join('\n'));
  else console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// A CPython minor is reviewed, a patch automerges
//
// CPython never ships a major, so the X.Y release is the breaking one, but
// automerge.json's bundle rule treats it as an ordinary minor: owine/
// trip-tracker #316 (3.14.8 -> 3.15.0) automerged with no review. Run every
// half through EACH consumer's real extends order, because automerge.json is
// extended first and :node/:alpine/:home-assistant come after :python in some
// of them; a later preset re-enabling automerge would only show up here.
// ---------------------------------------------------------------------------
const halves = [
  { dep: pyprojectDep, minorSoak: 7 },
  { dep: imageDep('python'), minorSoak: 0 },
  { dep: imageDep('docker.io/library/python'), minorSoak: 0 },
  { dep: pyenvDep, minorSoak: 7 },
  { dep: workflowDep, minorSoak: 7 },
  { dep: setupPythonDep, minorSoak: 7 },
];

for (const [repo, files] of Object.entries(consumers)) {
  checks++;
  const name = `review: CPython minor is manual, patch automerges (${repo})`;
  const cfg = consumerConfig(files);
  const wrong = [];
  for (const h of halves) {
    const label = `${h.dep.manager} ${h.dep.depName}`;
    const minor = await applyPackageRules({ ...cfg, ...h.dep, updateType: 'minor' });
    const patch = await applyPackageRules({ ...cfg, ...h.dep, updateType: 'patch' });
    if (minor.groupName !== 'python runtime') wrong.push(`${label} minor: groupName ${JSON.stringify(minor.groupName)}`);
    if (minor.automerge !== false) wrong.push(`${label} minor: automerge ${minor.automerge}, expected false`);
    for (const l of ['breaking', 'needs-review'])
      if (!minor.addLabels?.includes(l)) wrong.push(`${label} minor: missing label ${l} (addLabels ${JSON.stringify(minor.addLabels)})`);
    if (h.minorSoak !== undefined) {
      const days = checkMinimumReleaseAge(minor, new Date().toISOString()).minimumReleaseAgeMs / DAY;
      if (days !== h.minorSoak) wrong.push(`${label} minor: ${days}-day soak, expected ${h.minorSoak}`);
    }
    if (patch.groupName !== 'python runtime') wrong.push(`${label} patch: groupName ${JSON.stringify(patch.groupName)}`);
    if (patch.automerge !== true) wrong.push(`${label} patch: automerge ${patch.automerge}, expected true`);
    if (patch.addLabels?.includes('breaking')) wrong.push(`${label} patch: labelled breaking`);
  }
  if (wrong.length) fail(name, wrong.join('\n'));
  else console.log(`  ok  ${name}`);
}

// Branch level: Renovate sets a branch's automerge to every(upgrade.automerge)
// and unions addLabels, so the assembled python-runtime branch is what decides.
for (const [updateType, automerge] of [['minor', false], ['patch', true]]) {
  checks++;
  const name = `review: the assembled python-runtime branch for a ${updateType} has automerge ${automerge}`;
  const cfg = consumerConfig(consumers['trip-tracker']);
  const upgrades = [];
  for (const [dep, packageFile] of [[pyprojectDep, 'pyproject.toml'], [imageDep('python'), 'Dockerfile']]) {
    const res = await applyPackageRules({ ...cfg, ...dep, updateType });
    upgrades.push({ ...res, packageFile, branchName: 'renovate/python-runtime', newVersion: '3.15.0' });
  }
  const branch = generateBranchConfig(upgrades);
  const wrong = [];
  if (branch.automerge !== automerge) wrong.push(`branch automerge ${branch.automerge}`);
  const hasBreaking = branch.addLabels.includes('breaking') && branch.addLabels.includes('needs-review');
  if (hasBreaking !== !automerge) wrong.push(`branch addLabels ${JSON.stringify(branch.addLabels)}`);
  if (wrong.length) fail(name, wrong.join('\n'));
  else console.log(`  ok  ${name}`);
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
