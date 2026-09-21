#!/usr/bin/env node
// Behavior tests for default.json's two customManagers.
//
// WHY THIS EXISTS: CI's other gate, `renovate-config-validator --strict`, is a
// SCHEMA check. It cannot tell a working regex from a broken one — every
// regression these fixtures cover passes validation cleanly. owine/renovate-config#108
// fixed a phantom-dep bug that had been shipping to every consumer, and nothing
// in CI could have caught it.
//
// HOW IT RUNS WITHOUT A TOOLCHAIN: the validate workflow already runs inside
// ghcr.io/renovatebot/renovate, which ships Renovate's compiled dist. This
// imports the real extractor and the real auto-replacer from it, so the
// assertions are against the same engine Mend-hosted runs — not a
// reimplementation of the regex semantics. No package.json, no lockfile, no
// dependency for Renovate to track.
//
// Locally:  npm i renovate && RENOVATE_DIST=./node_modules/renovate/dist node test/custom-managers.mjs

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIST = process.env.RENOVATE_DIST ?? '/usr/local/renovate/dist';
const HERE = dirname(new URL(import.meta.url).pathname);

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

const { extractPackageFile } = await load('modules/manager/custom/regex/index.js');
const { doAutoReplace } = await load('workers/repository/update/branch/auto-replace.js');
const { GlobalConfig } = await load('config/global.js');
const { matchRegexOrGlobList } = await load('util/string-match.js');
const { init } = await load('logger/index.js');
await init(); // otherwise every Renovate log line is swallowed with a warning

const workspace = mkdtempSync(join(tmpdir(), 'renovate-fixtures-'));
GlobalConfig.set({ localDir: workspace });

// ---------------------------------------------------------------------------
// Manager selection
//
// Picked by index, then ASSERTED by a distinguishing substring. Reordering the
// customManagers array is a legitimate edit, but it must not silently retarget
// these tests at the wrong manager.
// ---------------------------------------------------------------------------
const { customManagers } = JSON.parse(readFileSync(join(HERE, '..', 'default.json'), 'utf8'));

const managers = {
  annotation: { index: 0, marker: 'Bump version literals in GitHub Actions workflows' },
  runners: { index: 1, marker: 'Make runner labels visible where they are NOT a literal' },
};

for (const [name, m] of Object.entries(managers)) {
  const cm = customManagers[m.index];
  if (!cm?.description?.includes(m.marker)) {
    console.error(
      `\ncustomManagers[${m.index}] is not the '${name}' manager any more.\n` +
        `  expected its description to contain: ${m.marker}\n` +
        `  got: ${cm?.description?.slice(0, 80) ?? '(missing)'}…\n\n` +
        `If you reordered the array on purpose, update the index in this file.\n`,
    );
    process.exit(2);
  }
  m.config = cm;
}

// ---------------------------------------------------------------------------
// Cases
//
// `expect` is the FULL extracted dep list, in order. Exactness is the point: a
// phantom dep is an EXTRA entry, so a test that only checked "the lanes are
// present" would have passed throughout the #108 bug.
// ---------------------------------------------------------------------------
const NODE = (depName, currentValue) => ({
  depName,
  packageName: 'node',
  currentValue,
  datasource: 'node-version',
});
const RUNNER = (depName, currentValue) => ({ depName, currentValue, datasource: 'github-runners' });

const cases = [
  {
    manager: 'annotation',
    fixture: 'annotation-trailing-matrix.yml',
    why: 'trailing-comment lanes extract once each — no phantom from the next line',
    expect: [NODE('node-lts-22', '22.23.2'), NODE('node-lts-24', '24.21.0')],
    replace: { depName: 'node-lts-22', newValue: '22.24.0', from: "- '22.23.2' #", to: "- '22.24.0' #" },
  },
  {
    manager: 'annotation',
    fixture: 'annotation-trailing-matrix-reversed.yml',
    why: 'the phantom is absent even when lane order would let it resolve',
    expect: [NODE('node-lts-24', '24.21.0'), NODE('node-lts-22', '22.23.2')],
  },
  {
    manager: 'annotation',
    fixture: 'annotation-leading-env.yml',
    why: 'leading-comment style still extracts, and still rewrites',
    expect: [{ depName: 'node', currentValue: '24.21.0', datasource: 'node-version', versioning: 'node' }],
    replace: { depName: 'node', newValue: '26.0.0', from: 'NODE_VERSION: "24.21.0"', to: 'NODE_VERSION: "26.0.0"' },
  },
  {
    manager: 'annotation',
    fixture: 'annotation-leading-trivy.yml',
    why: 'the anchor consumes a newline into replaceString; auto-replace must still touch only the value line',
    expect: [{ depName: 'aquasecurity/trivy', currentValue: '0.74.0', datasource: 'github-releases' }],
    replace: { depName: 'aquasecurity/trivy', newValue: '0.75.0', from: 'version: v0.74.0', to: 'version: v0.75.0' },
  },
  {
    manager: 'annotation',
    fixture: 'annotation-value-above-leading-comment.yml',
    why: "PR #4's guard: an unannotated literal above an annotation must not bind to it (`[ \\t]`, never `\\s`)",
    expect: [{ depName: 'node', currentValue: '24.21.0', datasource: 'node-version', versioning: 'node' }],
  },
  {
    manager: 'annotation',
    fixture: 'annotation-leading-line-1.yml',
    why: 'the `^` alternative reaches an annotation on line 1, which `\\n` cannot',
    expect: [{ depName: 'node', currentValue: '24.21.0', datasource: 'node-version', versioning: 'node' }],
  },
  {
    manager: 'runners',
    fixture: 'runner-matrix-include.yml',
    why: 'matrix.include[] runners are visible, arm lane included',
    expect: [RUNNER('ubuntu', '26.04'), RUNNER('ubuntu', '26.04-arm')],
  },
  {
    manager: 'runners',
    fixture: 'runner-workflow-call-default.yml',
    why: 'a workflow_call input default is reached, and neither the description: sample nor the sibling input leaks',
    expect: [RUNNER('ubuntu', '26.04')],
  },
  {
    manager: 'runners',
    fixture: 'runner-input-without-default.yml',
    why: 'a runner input with no default must not steal the sibling input\'s default (the bare-key stop)',
    expect: [],
  },
  {
    manager: 'runners',
    fixture: 'runner-json-in-run.yml',
    why: 'JSON-in-run: runners are reached and the closing quote terminates the value',
    expect: [RUNNER('ubuntu', '26.04'), RUNNER('ubuntu', '26.04-arm')],
  },
  {
    manager: 'runners',
    fixture: 'runner-suffixed.yml',
    why: 'currentValue keeps the whole remainder — -arm/-large/-intel are distinct versions, not decoration',
    expect: [
      RUNNER('ubuntu', '26.04-arm'),
      RUNNER('macos', '15-large'),
      RUNNER('macos', '15-intel'),
      RUNNER('windows', '2025'),
    ],
    replace: { depName: 'macos', newValue: '16-large', from: 'runner: macos-15-large', to: 'runner: macos-16-large' },
  },
];

// ---------------------------------------------------------------------------
const FIELDS = ['depName', 'packageName', 'currentValue', 'datasource', 'versioning'];
const normalise = (dep) =>
  Object.fromEntries(FIELDS.filter((f) => dep[f] !== undefined).map((f) => [f, dep[f]]));

const failures = [];
const fail = (name, msg) => failures.push(`${name}\n    ${msg.replace(/\n/g, '\n    ')}`);

// packageFile is synthetic: the fixtures live outside .github/workflows so that
// GitHub does not try to run them and this repo's own Renovate does not extract
// them. managerFilePatterns is therefore asserted separately, below.
const PACKAGE_FILE = '.github/workflows/ci.yml';

for (const c of cases) {
  const name = `${c.fixture} — ${c.why}`;
  const config = managers[c.manager].config;
  const content = readFileSync(join(HERE, 'fixtures', c.fixture), 'utf8');

  const deps = extractPackageFile(content, PACKAGE_FILE, config)?.deps ?? [];
  const got = deps.map(normalise);
  if (JSON.stringify(got) !== JSON.stringify(c.expect)) {
    fail(name, `extracted ${got.length} dep(s), expected ${c.expect.length}\n` +
      `expected: ${JSON.stringify(c.expect, null, 2)}\n` +
      `got:      ${JSON.stringify(got, null, 2)}`);
    continue;
  }

  if (!c.replace) {
    console.log(`  ok  ${name}`);
    continue;
  }

  const depIndex = deps.findIndex((d) => d.depName === c.replace.depName);
  const target = join(workspace, PACKAGE_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);

  const upgrade = {
    ...config,
    ...deps[depIndex],
    manager: 'regex', // the custom api is keyed WITHOUT the `custom.` prefix
    packageFile: PACKAGE_FILE,
    depIndex,
    baseDeps: deps,
    newValue: c.replace.newValue,
  };

  let after;
  try {
    after = await doAutoReplace(upgrade, content, false, true);
  } catch (err) {
    fail(name, `auto-replace threw: ${err.message}`);
    continue;
  }

  const before = content.split('\n');
  const changed = after
    .split('\n')
    .map((line, i) => [before[i], line])
    .filter(([b, a]) => b !== a);

  if (changed.length !== 1) {
    fail(name, `auto-replace changed ${changed.length} line(s), expected exactly 1\n` +
      changed.map(([b, a]) => `- ${b}\n+ ${a}`).join('\n'));
  } else if (!changed[0][0].includes(c.replace.from) || !changed[0][1].includes(c.replace.to)) {
    fail(name, `auto-replace rewrote the wrong line\n` +
      `expected: ${c.replace.from} -> ${c.replace.to}\n` +
      `got:      ${changed[0][0].trim()} -> ${changed[0][1].trim()}`);
  } else {
    console.log(`  ok  ${name} (+ auto-replace)`);
  }
}

// managerFilePatterns — the one thing the synthetic packageFile above bypasses.
for (const [name, m] of Object.entries(managers)) {
  const label = `${name} managerFilePatterns`;
  const matches = (f) => matchRegexOrGlobList(f, m.config.managerFilePatterns);
  const shouldMatch = ['.github/workflows/ci.yml', '.github/workflows/release.yaml'];
  const shouldNot = ['.github/actions/setup/action.yml', '.github/workflows/nested/ci.yml', 'docs/ci.yml'];
  const wrong = [
    ...shouldMatch.filter((f) => !matches(f)).map((f) => `should match but does not: ${f}`),
    ...shouldNot.filter((f) => matches(f)).map((f) => `should NOT match but does: ${f}`),
  ];
  if (wrong.length) fail(label, wrong.join('\n'));
  else console.log(`  ok  ${label}`);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n`);
  for (const f of failures) console.error(`  FAIL ${f}\n`);
  console.error(
    'These are BEHAVIOR failures. `renovate-config-validator` will still pass on\n' +
      'this config — that is exactly why these fixtures exist. If the change was\n' +
      'deliberate, update the expectation and say why in the commit message.\n',
  );
  process.exit(1);
}
console.log(`\n${cases.length + 2} checks passed against Renovate at ${DIST}`);
