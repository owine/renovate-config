#!/usr/bin/env node
// Runs scripts/release-summary.js the way actions/github-script does, over
// fixture release bodies, with a mock octokit that records its calls.
//
// WHY THIS EXISTS: renovate-config never runs the script in a workflow. Ten
// consumers each carry a copy as the inline `script:` of a step after
// release-drafter, so a bug here only shows up as a wrong (or overwritten)
// draft in every one of them. The script's two contracts are checked here:
// it counts only the change lines above the `**Full changelog:**` line (a
// footer's `- ` lines are not changes), and it writes only to a release that
// is still a draft with something to summarize.
//
// The bodies below are shaped like release-drafter v7.10.0's render of the
// shared release-drafter.yml: `## <category title>` headings, `- ` lines, a
// `<details>` block past `collapse-after`, the compare line, then the footer.
// The last section reads the category titles out of release-drafter.yml, so
// a renamed or added category fails here until the script knows it.
//
// Plain node, no dependencies:  node test/release-summary.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'scripts/release-summary.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const failures = [];
let checks = 0;
const check = (name, pass, msg) => {
  checks++;
  if (pass) console.log(`  ok  ${name}`);
  else failures.push(`${name}\n    ${msg.replace(/\n/g, '\n    ')}`);
};

// actions/github-script compiles `script:` into an async function with
// github, context and core (among others) as parameters; `process` is the
// real global there, and a parameter here so the env is the fixture's.
const run = async (body, { draft = true, releaseId = '42' } = {}) => {
  const calls = { getRelease: [], updateRelease: [] };
  const github = {
    rest: {
      repos: {
        getRelease: async (args) => {
          calls.getRelease.push(args);
          return { data: { id: Number(releaseId), draft, body } };
        },
        updateRelease: async (args) => {
          calls.updateRelease.push(args);
          return { data: {} };
        },
      },
    },
  };
  const context = { repo: { owner: 'owine', repo: 'nut-cgi' } };
  const core = { info() {}, notice() {}, warning() {}, debug() {} };
  const env = { BODY: body, RELEASE_ID: releaseId };
  await new AsyncFunction('github', 'context', 'core', 'process', SRC)(github, context, core, { env });
  return calls;
};

const COMPARE = '**Full changelog:** [v1.4.0...v1.4.1](https://github.com/owine/nut-cgi/compare/v1.4.0...v1.4.1)';
const FOOTER = ['', '### Use this release', '', '```sh', 'docker pull ghcr.io/owine/nut-cgi:v1.4.1', '```', ''].join('\n');
// The MCP footer is the one with list-like lines; none of them is a change.
const LIST_FOOTER = ['', '### Use this release', '', '- add the server to your MCP client', '- restart it', ''].join('\n');
const body = (...lines) => [...lines, '', COMPARE, ''].join('\n');

// Writes `<line>\n\n<body>` to release 42 of the context repo, exactly once.
const expectSummary = async (name, input, line) => {
  const calls = await run(input);
  const got = calls.updateRelease;
  const want = { owner: 'owine', repo: 'nut-cgi', release_id: 42, body: `${line}\n\n${input}` };
  check(
    `${name} -> ${line}`,
    got.length === 1 && JSON.stringify(got[0]) === JSON.stringify(want),
    `updateRelease calls: ${JSON.stringify(got, null, 2)}\nwanted one: ${JSON.stringify(want, null, 2)}`,
  );
};
// Neither reads nor writes the release.
const expectUntouched = async (name, input) => {
  const calls = await run(input);
  check(
    `${name} -> untouched`,
    !calls.getRelease.length && !calls.updateRelease.length,
    `getRelease: ${calls.getRelease.length}, updateRelease: ${calls.updateRelease.length}`,
  );
};

console.log('\n[the file]');
check(
  'starts with the fleet marker comment',
  SRC.startsWith('// owine/renovate-config scripts/release-summary.js v'),
  `first line: ${JSON.stringify(SRC.split('\n')[0])}\nEvery consumer's copy is found by grepping that line.`,
);
{
  const at = SRC.split('\n').findIndex((l) => l.includes('${{'));
  check(
    'contains no Actions expression opener, not even in a comment',
    at === -1,
    `line ${at + 1}: ${JSON.stringify(SRC.split('\n')[at])}\nActions evaluates expressions anywhere in a \`with:\` value, so this fails the\nconsumer's workflow at parse time ("An expression was expected").`,
  );
}

console.log('\n[nothing to summarize]');
await expectUntouched('no-changes body', body('_No user-facing changes._'));
await expectUntouched('no-changes body + a footer with `- ` lines', body('_No user-facing changes._') + LIST_FOOTER);
await expectUntouched('empty BODY (a run without release-drafter output)', '');

console.log('\n[counting]');
await expectSummary('single fix', body('## 🐛 Bug Fixes', '', '- handle an empty UPS list (#88)'), '**1 bug fix**');
await expectSummary(
  'mixed sections, in summary order',
  body(
    '## ✨ Features',
    '',
    '- **api:** add list_cameras (#40)',
    '- add a dark theme (#41)',
    '',
    '## 🐛 Bug Fixes',
    '',
    '- handle an empty body (#42)',
    '- update dependency happy-dom to v21.0.4 [security] (#43)',
    '- retry on 502 (#44)',
    '',
    '## 📦 Dependencies',
    '',
    '- update pnpm to v12.3.6 (#45, #47)',
  ),
  '**2 features · 3 bug fixes · 1 dependency update**',
);
await expectSummary(
  'collapsed Dependencies: lines inside <details> count, <summary> does not',
  body(
    '## 🐛 Bug Fixes',
    '',
    '- handle an empty body (#50)',
    '',
    '## 📦 Dependencies',
    '',
    '<details>',
    '<summary>6 changes</summary>',
    '',
    '- update dependency undici to v7.17.0 (#51, #55)',
    '- update dependency vite to v8.1.2 (#52)',
    '- update curl apk package to v8.23.0-r0 (#53)',
    '- update ghcr.io/home-assistant/base:3.24 docker digest to 992dc6a (#54, #58)',
    '- update all non-major dependencies (#56, #59)',
    '- update toolchain-versions (#57)',
    '</details>',
  ),
  '**1 bug fix · 6 dependency updates**',
);
await expectSummary(
  'uncategorized lines before the first heading count as other',
  body('- Bump something (#60)', '- Fix the thing (#61)', '', '## 📦 Dependencies', '', '- update dependency ws to v8.22.0 (#62)'),
  '**1 dependency update · 2 other changes**',
);
await expectSummary('only uncategorized', body('- Bump something (#63)'), '**1 other change**');
await expectSummary(
  'every kind, plural',
  body(
    '- Bump something (#1)',
    '- Bump something else (#2)',
    ...[
      ['💥 Breaking Changes', 3],
      ['✨ Features', 5],
      ['🐛 Bug Fixes', 7],
      ['⚡ Performance', 9],
      ['⏪ Reverts', 11],
      ['📦 Dependencies', 13],
    ].flatMap(([title, n]) => ['', `## ${title}`, '', `- one (#${n})`, `- two (#${n + 1})`]),
  ),
  '**2 breaking changes · 2 features · 2 bug fixes · 2 performance improvements · 2 reverts · 2 dependency updates · 2 other changes**',
);

console.log('\n[the footer is not counted]');
{
  const input = body('## 📦 Dependencies', '', '- update pnpm to v12.3.6 (#70)') + LIST_FOOTER;
  await expectSummary('a footer with `- ` lines after the compare line', input, '**1 dependency update**');
  await expectSummary('the docker footer', body('## 🐛 Bug Fixes', '', '- retry on 502 (#71)') + FOOTER, '**1 bug fix**');
}

console.log('\n[only drafts are written]');
{
  const input = body('## 🐛 Bug Fixes', '', '- retry on 502 (#80)');
  const calls = await run(input, { draft: false });
  check(
    'a release published between the two steps is read but not written',
    calls.getRelease.length === 1 && !calls.updateRelease.length,
    `getRelease: ${calls.getRelease.length}, updateRelease: ${JSON.stringify(calls.updateRelease)}`,
  );
  const [get] = calls.getRelease;
  check(
    'getRelease gets the context repo and a numeric release_id',
    JSON.stringify(get) === JSON.stringify({ owner: 'owine', repo: 'nut-cgi', release_id: 42 }),
    `got ${JSON.stringify(get)}; RELEASE_ID arrives as a string in env`,
  );
}

// ---------------------------------------------------------------------------
// The script knows every section release-drafter.yml can render
//
// Reads the titles with a regex rather than a YAML parser to stay
// dependency-free; test/release-drafter.mjs owns the parsed view.
// ---------------------------------------------------------------------------
console.log('\n[release-drafter.yml]');
{
  const yml = readFileSync(join(ROOT, 'release-drafter.yml'), 'utf8');
  // The script stops counting at this line, and both HA `promote` seds delete
  // it; a reworded compare line would silently break all three.
  const STOP = "line.startsWith('**Full changelog:**')";
  const template = /^template: \|\n((?:  .*\n|\n)+)/m.exec(yml)?.[1] ?? '';
  check(
    'the shared template has a `**Full changelog:**` line, and the script stops at that literal',
    template.split('\n').some((l) => l.startsWith('  **Full changelog:** ')) && SRC.includes(STOP),
    `template:\n${template}\nscript stop test present: ${SRC.includes(STOP)}\nChange the template, the script, test/release-summary.mjs COMPARE and both promote seds together.`,
  );
  const titles = [...yml.matchAll(/^\s*- title: '([^']+)'$/gm)].map((m) => m[1]);
  check(
    'found six category titles',
    titles.length === 6,
    `found ${JSON.stringify(titles)}; if the categories changed, update the script's KINDS and this count`,
  );
  await expectSummary(
    `one entry under each of ${titles.length} titles is never "other"`,
    body(...titles.flatMap((t, i) => [`## ${t}`, '', `- entry (#${i + 1})`, ''])),
    '**1 breaking change · 1 feature · 1 bug fix · 1 performance improvement · 1 revert · 1 dependency update**',
  );
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n`);
  for (const f of failures) console.error(`  FAIL ${f}\n`);
  console.error(
    'scripts/release-summary.js disagrees with the release body it summarizes.\n' +
      'Every consumer carries a copy: after fixing it, bump the marker version\n' +
      'and roll the new copy out (grep -r "release-summary.js v").\n',
  );
  process.exit(1);
}
console.log(`\n${checks} checks passed`);
