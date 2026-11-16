#!/usr/bin/env node
// Behavior tests for which BRANCH a coupled group's majors land on.
//
// WHY THIS EXISTS: a groupName does not by itself put a group's majors on one
// branch. default.json sets `separateMajorMinor` and `separateMultipleMajor`
// fleet-wide, and Renovate's branch-name.ts then slugs a grouped major as
// `major-<newMajor>-<group>`. A group whose members sit on DIFFERENT major
// numbers therefore gets one branch per number. owine/havethejetsmadetheplayoffsyet
// #303 (`renovate/major-18-stylelint`, stylelint 17 -> 18) and #304
// (`renovate/major-41-stylelint`, stylelint-config-standard 40 -> 41, which
// peers `stylelint ^18`) opened on 2026-11-16 as two PRs that could not land
// apart, from a rule whose whole purpose was to prevent exactly that split.
// `renovate-config-validator --strict` cannot see it: the group matched both
// packages; only the slug differs.
//
// The fix is a per-rule `separateMultipleMajor: false` on each group whose
// members are on different major lines AND cap each other to one major. This
// test feeds real-shaped major updates through Renovate's own flattenUpdates
// (both package-rule passes, then the real generateBranchName) and asserts the
// branch names. It also pins the opposite case: groups that NEED the number in
// the slug (toolchain-versions pairs @types/node with the runtime BY major
// number) must keep it, so nobody "fixes" this by flipping the fleet default.
//
// Same approach as commit-types.mjs: the real preset resolver and the real
// update pipeline out of the Renovate dist the validate workflow's container
// already ships.
//
// Locally:  npm i renovate && RENOVATE_DIST=./node_modules/renovate/dist node test/group-majors.mjs

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

const { getConfig } = await load('config/defaults.js');
const { resolveConfigPresets } = await load('config/presets/index.js');
const { mergeChildConfig } = await load('config/utils.js');
const { flattenUpdates } = await load('workers/repository/updates/flatten.js');
const { init } = await load('logger/index.js');
await init();

const preset = (f) => JSON.parse(readFileSync(join(HERE, '..', f), 'utf8'));

const failures = [];
const fail = (name, msg) => failures.push(`${name}\n    ${msg.replace(/\n/g, '\n    ')}`);
let checks = 0;
const ok = (name) => console.log(`  ok  ${name}`);

// ---------------------------------------------------------------------------
// The consumer config: Renovate's defaults, then each preset in a consumer's
// extends order, each with its own `extends` (default.json's built-ins,
// docker.json's docker:enableMajor) resolved the way Renovate resolves them.
// The widest app chain, so a later preset that resets the option would show.
// ---------------------------------------------------------------------------
const CHAIN = ['default.json', 'automerge.json', 'node.json', 'python.json', 'go.json', 'docker.json', 'alpine.json'];
let config = getConfig();
for (const f of CHAIN) {
  const resolved = await resolveConfigPresets(preset(f));
  const c = resolved?.config ?? resolved;
  if (!c || typeof c !== 'object' || (f === 'default.json' && !(c.packageRules ?? []).length)) {
    console.error(
      `\nresolveConfigPresets(${f}) returned no usable config (top-level keys:\n` +
        `${Object.keys(resolved ?? {}).join(', ') || 'none'}). This is a LAYOUT problem,\n` +
        `not a config problem: its return shape changed in the Renovate release at\n` +
        `${DIST}. Repoint the read above and re-run.\n`,
    );
    process.exit(2);
  }
  config = mergeChildConfig(config, c);
}
// The fleet default every case below is measured against. A CONFIG change,
// so a behavior failure (exit 1), not a binding one: flipping it fleet-wide
// would merge every single package's majors too, and toolchain-versions
// needs the number in its slug.
{
  checks++;
  const name = "the merged chain keeps default.json's fleet-wide separateMajorMinor + separateMultipleMajor";
  if (config.separateMajorMinor !== true || config.separateMultipleMajor !== true)
    fail(name, `got separateMajorMinor=${config.separateMajorMinor}, separateMultipleMajor=${config.separateMultipleMajor}; override per coupled group instead (see node.json's stylelint rule)`);
  else ok(name);
}

// One real-shaped major update, as lookup hands it to flattenUpdates.
const major = (manager, datasource, depName, from, to, extra = {}) => {
  const [M, m, p] = to.replace(/^v/, '').split('.').map(Number);
  return {
    manager,
    dep: {
      depName,
      packageName: extra.packageName ?? depName,
      datasource,
      depType: extra.depType ?? 'devDependencies',
      currentValue: from,
      currentVersion: from,
      updates: [{ updateType: 'major', newValue: to, newVersion: to, newMajor: M, newMinor: m ?? 0, newPatch: p ?? 0, releaseTimestamp: '2026-11-01T00:00:00.000Z' }],
    },
    packageFile: extra.packageFile ?? (manager === 'npm' ? 'package.json' : manager === 'pep621' ? 'pyproject.toml' : '.github/workflows/ci.yml'),
  };
};
const npm = (n, from, to, extra) => major('npm', 'npm', n, from, to, extra);

const branchesFor = async (ups) => {
  const packageFiles = {};
  for (const u of ups) {
    const files = (packageFiles[u.manager] ??= []);
    let pf = files.find((f) => f.packageFile === u.packageFile);
    if (!pf) files.push((pf = { packageFile: u.packageFile, deps: [] }));
    pf.deps.push(structuredClone(u.dep));
  }
  const flat = await flattenUpdates(structuredClone(config), packageFiles);
  const out = {};
  for (const u of ups) {
    const hit = flat.find((f) => f.depName === u.dep.depName && f.updateType === 'major');
    out[u.dep.depName] = hit ? hit.branchName : '(no major update produced)';
  }
  return out;
};

// ---------------------------------------------------------------------------
// Coupled groups: every member's major must share ONE branch.
// `branch` is the exact expected name, so a rule that groups them under the
// wrong name (or a slug change) is caught too.
// ---------------------------------------------------------------------------
const together = [
  {
    group: 'stylelint',
    why: 'havethejetsmadetheplayoffsyet #303/#304: config-standard 41 peers stylelint ^18',
    ups: [npm('stylelint', '17.16.0', '18.0.0'), npm('stylelint-config-standard', '40.0.0', '41.0.0')],
    branch: 'renovate/major-stylelint',
  },
  {
    group: 'testing-library',
    why: '@testing-library/react peers @testing-library/dom on one major (16 peers ^10)',
    ups: [npm('@testing-library/react', '16.3.3', '17.0.0'), npm('@testing-library/dom', '10.4.2', '11.0.0')],
    branch: 'renovate/major-testing-library',
  },
  {
    group: 'vite',
    why: '@vitejs/plugin-react peers vite on one major (6 peers ^8); fleet: mlb-contract-calculator, youth-activity-scheduler',
    ups: [npm('vite', '8.3.8', '9.0.0'), npm('@vitejs/plugin-react', '6.3.0', '7.0.0')],
    branch: 'renovate/major-vite',
  },
  {
    group: 'radix-ui',
    why: 'radix-ui exact-pins the primitives it re-exports (1.8.1 -> react-primitive 2.2.0)',
    ups: [npm('radix-ui', '1.8.1', '2.0.0', { depType: 'dependencies' }), npm('@radix-ui/react-primitive', '2.2.0', '3.0.0', { depType: 'dependencies' })],
    branch: 'renovate/major-radix-ui',
  },
  {
    group: 'react-hook-form',
    why: '@hookform/resolvers peers react-hook-form on one major; its own line diverges (was 5 under rhf 7)',
    ups: [npm('react-hook-form', '7.92.0', '8.0.0', { depType: 'dependencies' }), npm('@hookform/resolvers', '7.0.6', '9.0.0', { depType: 'dependencies' })],
    branch: 'renovate/major-react-hook-form',
  },
  {
    group: 'cloudflare-workers',
    why: '@cloudflare/vite-plugin peers wrangler ^4; cf rides the same group from a SECOND rule, which needs the override too',
    ups: [npm('wrangler', '4.163.0', '5.0.0'), npm('@cloudflare/vite-plugin', '1.69.1', '2.0.0'), npm('cf', '1.0.0', '2.0.0')],
    branch: 'renovate/major-cloudflare-workers',
  },
  {
    group: 'astro',
    why: '@astrojs/mdx 8 and @astrojs/node 11 each peer astro ^7',
    ups: [npm('astro', '7.4.12', '8.0.0'), npm('@astrojs/mdx', '8.1.6', '9.0.0'), npm('@astrojs/node', '11.1.13', '12.0.0')],
    branch: 'renovate/major-astro',
  },
  {
    group: 'sveltekit',
    why: 'kit 3 peers vite-plugin-svelte ^7; every adapter peers kit ^3',
    ups: [npm('@sveltejs/kit', '3.2.0', '4.0.0'), npm('@sveltejs/vite-plugin-svelte', '7.3.1', '8.0.0'), npm('@sveltejs/adapter-node', '6.0.2', '7.0.0')],
    branch: 'renovate/major-sveltekit',
  },
  {
    group: 'apollo',
    why: '@apollo/server 5 peers graphql ^16.11',
    ups: [npm('graphql', '16.11.0', '17.0.0', { depType: 'dependencies' }), npm('@apollo/server', '5.5.2', '6.0.0', { depType: 'dependencies' })],
    branch: 'renovate/major-apollo',
  },
  {
    group: 'huggingface',
    why: 'transformers 5 and datasets 5 cap huggingface-hub <3.0 while hub is on 2',
    ups: [major('pep621', 'pypi', 'transformers', '5.23.0', '6.0.0'), major('pep621', 'pypi', 'huggingface-hub', '2.4.0', '3.0.0')],
    branch: 'renovate/major-huggingface',
  },
  {
    group: 'langchain',
    why: 'langchain-core 1 caps langsmith <1.0 while langsmith is on 0.x (0 -> 1 IS a major)',
    ups: [major('pep621', 'pypi', 'langchain-core', '1.8.1', '2.0.0'), major('pep621', 'pypi', 'langsmith', '0.14.17', '1.0.0')],
    branch: 'renovate/major-langchain',
  },
  {
    group: 'github-actions-artifact',
    why: 'upload/download must stay paired across an artifact-backend break; they are on v7 and v8',
    ups: [
      major('github-actions', 'github-tags', 'actions/upload-artifact', 'v7.0.2', 'v8.0.0', { depType: 'action' }),
      major('github-actions', 'github-tags', 'actions/download-artifact', 'v8.0.2', 'v9.0.0', { depType: 'action' }),
    ],
    branch: 'renovate/major-github-actions-artifact',
  },
];

// ---------------------------------------------------------------------------
// Controls: groups whose majors MUST stay split by number. These keep the fix
// per-rule: flipping default.json's separateMultipleMajor would fail them.
// ---------------------------------------------------------------------------
const apart = [
  {
    group: 'toolchain-versions',
    why: '@types/node joins the runtime BY major number (node.json); a pnpm major is a different move',
    ups: [
      major('nvm', 'node-version', 'node', '24.11.0', '26.0.0', { packageFile: '.nvmrc' }),
      npm('@types/node', '24.10.1', '26.0.0'),
      npm('pnpm', '10.20.0', '11.0.0', { depType: 'packageManager' }),
    ],
    branches: {
      node: 'renovate/major-26-toolchain-versions',
      '@types/node': 'renovate/major-26-toolchain-versions',
      pnpm: 'renovate/major-11-toolchain-versions',
    },
  },
  {
    group: 'tanstack',
    why: 'query and router are independent trains (each devtools pair shares its number already)',
    ups: [npm('@tanstack/react-query', '5.107.1', '6.0.0', { depType: 'dependencies' }), npm('@tanstack/react-router', '1.170.46', '2.0.0', { depType: 'dependencies' })],
    branches: { '@tanstack/react-query': 'renovate/major-6-tanstack', '@tanstack/react-router': 'renovate/major-2-tanstack' },
  },
  {
    group: 'testing',
    why: 'vitest and testcontainers are independent trains in one group',
    ups: [npm('vitest', '5.1.0', '6.0.0'), npm('testcontainers', '12.2.1', '13.0.0')],
    branches: { vitest: 'renovate/major-6-testing', testcontainers: 'renovate/major-13-testing' },
  },
];

console.log(`\n[majors] ${CHAIN.join(' -> ')}`);
for (const c of together) {
  checks++;
  const name = `${c.group}: ${c.ups.map((u) => `${u.dep.depName} ${u.dep.currentVersion}->${u.dep.updates[0].newVersion}`).join(' + ')} share one branch — ${c.why}`;
  const got = await branchesFor(c.ups);
  const names = new Set(Object.values(got));
  if (names.size !== 1 || !names.has(c.branch))
    fail(name, `expected every member on ${c.branch}, got:\n${Object.entries(got).map(([d, b]) => `  ${d} -> ${b}`).join('\n')}`);
  else ok(`${name} -> ${c.branch}`);
}
for (const c of apart) {
  checks++;
  const name = `${c.group}: ${c.why}`;
  const got = await branchesFor(c.ups);
  const wrong = Object.entries(c.branches).filter(([d, b]) => got[d] !== b);
  if (wrong.length) fail(name, `expected:\n${Object.entries(c.branches).map(([d, b]) => `  ${d} -> ${b}`).join('\n')}\ngot:\n${Object.entries(got).map(([d, b]) => `  ${d} -> ${b}`).join('\n')}`);
  else ok(`${name} -> ${[...new Set(Object.values(got))].join(' | ')}`);
}

// ---------------------------------------------------------------------------
// Lookup side of the same option. separateMultipleMajor is read twice: by
// branch-name.ts (the slug, above) and, earlier, by lookup/bucket.ts, after
// fetch.ts's `pre-lookup` package-rule pass. With it off, every major
// candidate falls into ONE `major` bucket and only the newest survives, so a
// package two majors behind jumps straight to the latest instead of being
// offered each major in turn. That is the trade-off each fixed rule's
// description states; pin it here so a description cannot drift from it.
// ---------------------------------------------------------------------------
{
  const { getBucket } = await load('workers/repository/process/lookup/bucket.js');
  const { applyPackageRules } = await load('util/package-rules/index.js');
  const versioning = (await load('modules/versioning/index.js')).get('npm');
  const preLookup = (depName) =>
    applyPackageRules(
      { ...structuredClone(config), manager: 'npm', datasource: 'npm', depName, packageName: depName, depType: 'devDependencies', packageFile: 'package.json', currentValue: '17.0.0' },
      'pre-lookup',
    );
  for (const [depName, expected, why] of [
    ['stylelint', ['major', 'major'], 'a fixed group: 17 -> 18 and 17 -> 19 share one bucket, so only 19 is offered'],
    ['lefthook', ['v18', 'v19'], 'an ungrouped package keeps the fleet default: one bucket (and PR) per major'],
  ]) {
    checks++;
    const name = `bucket for ${depName} 17.0.0 -> 18.0.0 / 19.0.0 — ${why}`;
    const res = await preLookup(depName);
    const got = ['18.0.0', '19.0.0'].map((v) => getBucket(res, '17.0.0', v, versioning));
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(name, `expected buckets ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    else ok(`${name} -> ${got.join(', ')}`);
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
