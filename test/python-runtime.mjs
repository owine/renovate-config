#!/usr/bin/env node
// Behavior tests for python.json's `requires-python` handling.
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
// #180/#182).
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
const { normalizeDepNames } = await load('workers/repository/extract/manager-files.js');
const { applyPackageRules } = await load('util/package-rules/index.js');
const { api: pep440 } = await load('modules/versioning/pep440/index.js');
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
