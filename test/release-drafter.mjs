#!/usr/bin/env node
// Checks that release-drafter.yml sorts every commit type the presets assign
// into the section, and the release, those presets were tuned for.
//
// WHY THIS EXISTS: the presets decide whether a Renovate PR releases purely
// through its commit type (`deps:`/`fix:` release, `ci:`/`chore:` don't; see
// default.json and test/commit-types.mjs). Consumers on release-drafter read
// that type back out of the squash-merged PR title, via the shared
// release-drafter.yml in this repo. Neither side can see the other: a type
// added to a preset, or a category edited in the YAML, would silently start
// shipping CI churn as a release, or stop releasing runtime bumps, with
// `renovate-config-validator` green.
//
// release-drafter itself is not installed here (no package.json, by design),
// so classify() below mirrors its category matching
// (packages/core/src/category-matching.ts @ v7.10.0): the same conventional
// header pattern, pre-exclude before any changelog category, first match per
// category with `exclusive` stopping the scan. To keep the mirror honest it
// refuses any `when` key other than `conventional`. The YAML is parsed with
// the parser in the Renovate dist the other tests already import.
//
// Locally:  npm i renovate && RENOVATE_DIST=./node_modules/renovate/dist node test/release-drafter.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = process.env.RENOVATE_DIST ?? '/usr/local/renovate/dist';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

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

const { parseSingleYaml } = await load('util/yaml.js');
const config = parseSingleYaml(readFileSync(join(ROOT, 'release-drafter.yml'), 'utf8'));

const failures = [];
const fail = (name, msg) => failures.push(`${name}\n    ${msg.replace(/\n/g, '\n    ')}`);
let checks = 0;
const ok = (name) => console.log(`  ok  ${name}`);
const check = (name, pass, msg) => {
  checks++;
  if (pass) ok(name);
  else fail(name, msg);
};

// ---------------------------------------------------------------------------
// Mirror of release-drafter's category matching, `conventional` only
// ---------------------------------------------------------------------------
const HEADER = /^(\w*)(?:\((.*)\))?(!?): (.*)$/;
const parseTitle = (title) => {
  const m = HEADER.exec(title);
  return m && { type: m[1], scope: m[2], breaking: m[3] === '!' };
};
const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const conditions = (cat) => asList(cat.when);
const matches = (cat, parsed) =>
  conditions(cat).length === 0 ||
  conditions(cat).some(({ conventional: c }) => {
    if (!parsed || !c) return false; // !c: a non-conventional `when`, failed by the guard below
    if (c === true) return true;
    const types = [...asList(c.types), ...asList(c.type)];
    const scopes = [...asList(c.scopes), ...asList(c.scope)];
    return (
      (!types.length || types.includes(parsed.type)) &&
      (!scopes.length || scopes.includes(parsed.scope)) &&
      (c.breaking === undefined || c.breaking === parsed.breaking)
    );
  });
const categories = config.categories.map((c) => ({ type: 'changelog', ...c }));
const RANK = { patch: 1, minor: 2, major: 3 };
const classify = (title) => {
  const parsed = parseTitle(title);
  if (categories.some((c) => c.type === 'pre-exclude' && matches(c, parsed))) return { hidden: true };
  const pick = (type) => {
    const of = categories.filter((c) => c.type === type);
    const hit = [];
    for (const c of of.filter((c) => conditions(c).length)) {
      if (!matches(c, parsed)) continue;
      hit.push(c);
      if (c.exclusive) break;
    }
    return hit.length ? hit : of.filter((c) => !conditions(c).length);
  };
  const shown = pick('changelog');
  const bump = [...shown, ...pick('version-resolver')]
    .map((c) => c['semver-increment'] ?? 'patch')
    .reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'patch');
  return { hidden: false, section: shown.map((c) => c.title).join(' + ') || '(uncategorized)', bump };
};

// ---------------------------------------------------------------------------
// The mirror only models what the config uses
// ---------------------------------------------------------------------------
{
  const unknown = categories.flatMap((c) =>
    conditions(c).flatMap((w) => Object.keys(w).filter((k) => k !== 'conventional').map((k) => `${c.title ?? c.type}: when.${k}`)),
  );
  check(
    'every category matches on `conventional` only (the mirror above models nothing else)',
    !unknown.length,
    `${unknown.join('\n')}\nExtend classify() to model it, or the checks below stop meaning anything.`,
  );
  const types = [...new Set(categories.map((c) => c.type))];
  check(
    'category types are pre-exclude / changelog / version-resolver',
    types.every((t) => ['pre-exclude', 'changelog', 'version-resolver'].includes(t)),
    `got ${types.join(', ')}; a pre-include changes what the mirror must model`,
  );
}

// ---------------------------------------------------------------------------
// Every type a preset can assign has a decided section
//
// The fleet's release contract, from README "Commit types & release-please".
// A preset that starts assigning a type not listed here fails, so the
// release consequence is decided on purpose rather than by the fallback.
// ---------------------------------------------------------------------------
const PRESET_TYPES = {
  deps: { hidden: false, section: 'Dependencies', bump: 'patch' },
  fix: { hidden: false, section: 'Bug Fixes', bump: 'patch' }, // vulnerabilityAlerts
  ci: { hidden: true }, // Actions + workflow literals
  chore: { hidden: true }, // lock file maintenance, mcp.json dev-only
};
const assigned = new Set();
const walk = (node) => {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) {
      if (k === 'semanticCommitType' && typeof v === 'string') assigned.add(v);
      else walk(v);
    }
};
const presets = readdirSync(ROOT).filter((f) => f.endsWith('.json') && f !== 'renovate.json');
for (const f of presets) walk(JSON.parse(readFileSync(join(ROOT, f), 'utf8')));
// Renovate's built-in `* => chore` / `dependencies => fix` rules: overridden
// by default.json, but listed so they can never be the undecided case.
assigned.add('chore').add('fix');

check(
  `every semanticCommitType in ${presets.length} presets has an expectation`,
  [...assigned].every((t) => t in PRESET_TYPES),
  `assigned: ${[...assigned].sort().join(', ')}\nexpected: ${Object.keys(PRESET_TYPES).join(', ')}\nAdd the new type to PRESET_TYPES with the section it should release under (or hidden).`,
);

const show = (r) => (r.hidden ? 'hidden' : `${r.section} / ${r.bump}`);
const expectTitle = (title, want, why) => {
  const got = classify(title);
  const pass = got.hidden === want.hidden && (want.hidden || (got.section === want.section && got.bump === want.bump));
  check(`${JSON.stringify(title)} -> ${show(want)} — ${why}`, pass, `got ${show(got)}`);
};

console.log('\n[preset-assigned types, as Renovate titles them (semanticCommitScope: null)]');
for (const t of [...assigned].sort())
  if (PRESET_TYPES[t]) expectTitle(`${t}: update dependency foo to v1.2.3`, PRESET_TYPES[t], 'assigned by a preset');

// The rest of release-please's mapping, which human-written PR titles rely on.
console.log("\n[release-please's mapping, harmonized]");
expectTitle('feat: add list_cameras', { hidden: false, section: 'Features', bump: 'minor' }, 'feat is a minor');
expectTitle('feat(tools): add list_cameras', { hidden: false, section: 'Features', bump: 'minor' }, 'scope does not matter');
expectTitle('perf: cache lookups', { hidden: false, section: 'Performance', bump: 'patch' }, 'shown fleet-wide (harmonized)');
expectTitle('revert: "feat: add x"', { hidden: false, section: 'Reverts', bump: 'patch' }, 'shown fleet-wide (harmonized)');
for (const t of ['docs', 'test', 'refactor', 'build', 'style'])
  expectTitle(`${t}: tidy`, { hidden: true }, "release-please's other hidden types");
expectTitle('feat!: drop v1 API', { hidden: false, section: '⚠ Breaking Changes', bump: 'major' }, 'breaking is major, and only in Breaking');
expectTitle('fix(api)!: drop v1 endpoint', { hidden: false, section: '⚠ Breaking Changes', bump: 'major' }, 'scoped breaking fix');
expectTitle('chore!: drop Node 20', { hidden: false, section: '⚠ Breaking Changes', bump: 'major' }, 'a breaking hidden type still releases, as in release-please');
expectTitle('ci!: require ubuntu-26.04', { hidden: false, section: '⚠ Breaking Changes', bump: 'major' }, 'same for ci!');

// ---------------------------------------------------------------------------
// Replacers strip the type prefix the way release-please's changelog did
//
// release-drafter compiles `/re/flags` strings to a RegExp and uses VS Code's
// `$1` replacement syntax, which agrees with String.replace for plain `$n`.
// ---------------------------------------------------------------------------
console.log('\n[change-title replacers]');
const toRegex = (s) => {
  const m = /^\/(.+)\/([gimsuy]*)$/s.exec(s);
  return m ? new RegExp(m[1], m[2]) : new RegExp(s.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&'));
};
const titleRules = (config.replacers ?? []).filter((r) => r.target === 'change-title');
const render = (title) => titleRules.reduce((t, r) => t.replace(toRegex(r.search), r.replace), title);
for (const [title, want] of [
  ['deps: update dependency ws to v8.22.0', 'update dependency ws to v8.22.0'],
  ['fix(api): handle empty body', '**api:** handle empty body'],
  ['feat(api)!: drop v1 endpoint', '**api:** drop v1 endpoint'],
  ['feat!: drop v1 API', 'drop v1 API'],
  ['revert: "feat: add x"', '"feat: add x"'],
  ['Bump something', 'Bump something'],
]) {
  const got = render(title);
  check(`${JSON.stringify(title)} renders ${JSON.stringify(want)}`, got === want, `got ${JSON.stringify(got)}`);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n`);
  for (const f of failures) console.error(`  FAIL ${f}\n`);
  console.error(
    'release-drafter.yml and the presets disagree about what releases. If the\n' +
      'change was deliberate, update the expectation and say why in the commit\n' +
      'message; every consumer on release-drafter picks it up on its next push.\n',
  );
  process.exit(1);
}
console.log(`\n${checks} checks passed`);
