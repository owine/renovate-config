#!/usr/bin/env node
// Runs the step script of .github/workflows/apk-arch-rerun.yml, read out of
// the YAML, under bash with fake `gh` and `curl` on PATH, against fixture PRs,
// runs, logs, Dockerfiles and APKINDEX archives.
//
// WHY THIS EXISTS: the workflow is reusable, so its only runs happen in
// consumer repos, on a cron, against whatever Renovate has open. A wrong
// answer there is quiet in both directions: a rerun that should not happen
// burns CI and can loop, and one that should happen leaves an `alpine
// packages` PR red until a human notices. The contracts checked here:
//   - only a failed latest run whose log says `unable to select packages` is
//     considered, and only below max-attempts;
//   - the pins are read the way Docker reads the Dockerfile (comment lines
//     drop out of a `\` continuation; && ; | end the apk command), so the
//     pin set is exact;
//   - a pin missing from ANY architecture blocks the rerun and is named;
//   - indexes are fetched only when a PR needs them, and a caller problem (a
//     bad input, an unfetchable index) exits 1 while every PR outcome exits 0;
//   - the job keeps its three permissions and runs no third-party action.
//
// The APKINDEX fixtures are shaped like Alpine's: a gzipped signature tar
// with its end-of-archive blocks cut off, concatenated with the gzipped
// index tar. Needs bash, tar, gzip and awk, all in the CI container.
//
// Locally:  npm i renovate && RENOVATE_DIST=./node_modules/renovate/dist node test/apk-arch-rerun.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = process.env.RENOVATE_DIST ?? '/usr/local/renovate/dist';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = '.github/workflows/apk-arch-rerun.yml';

const layout = (msg) => {
  console.error(`\n${msg}\n\nThis is a LAYOUT problem, not a behavior one. Set RENOVATE_DIST to test against a different install.\n`);
  process.exit(2);
};
let parseSingleYaml;
try {
  ({ parseSingleYaml } = await import(pathToFileURL(join(DIST, 'util/yaml.js')).href));
} catch (err) {
  layout(`Cannot import Renovate's dist at ${join(DIST, 'util/yaml.js')}\n  ${err.message}`);
}
const wf = parseSingleYaml(readFileSync(join(ROOT, WORKFLOW), 'utf8'));
const job = wf?.jobs?.rerun;
const SCRIPT = job?.steps?.find((s) => typeof s.run === 'string')?.run;
if (!SCRIPT) layout(`${WORKFLOW}: no jobs.rerun step with a run: script (renamed job?)`);

const failures = [];
let checks = 0;
const check = (name, pass, msg = '') => {
  checks++;
  if (pass) console.log(`  ok  ${name}`);
  else failures.push(`${name}\n    ${String(msg).replace(/\n/g, '\n    ')}`);
};

// ---------------------------------------------------------------------------
// Workflow shape
// ---------------------------------------------------------------------------
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('on: workflow_call only', same(Object.keys(wf.on ?? {}), ['workflow_call']), JSON.stringify(wf.on));
check('top-level permissions are empty', same(wf.permissions, {}), JSON.stringify(wf.permissions));
check(
  'job permissions are exactly actions: write, pull-requests: read, contents: read',
  same(job.permissions, { actions: 'write', 'pull-requests': 'read', contents: 'read' }),
  JSON.stringify(job.permissions),
);
check('no step uses an action', job.steps.every((s) => !s.uses), JSON.stringify(job.steps.map((s) => s.uses)));
check('the script interpolates no ${{ }} (inputs go through env)', !SCRIPT.includes('${{'), 'found ${{ in run:');
const inputs = Object.keys(wf.on.workflow_call.inputs);
const envd = Object.values(job.steps[0].env ?? {}).join(' ');
check(
  'every input reaches the script through env',
  inputs.every((i) => envd.includes(`inputs.${i}`)),
  `inputs ${inputs.join(', ')}; env ${envd}`,
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), 'apk-arch-rerun-'));
const BIN = join(TMP, 'bin');
mkdirSync(BIN);
writeFileSync(join(TMP, 'step.sh'), SCRIPT);

// gh: answers what the script asks, already --jq'd, and logs every call.
writeFileSync(
  join(BIN, 'gh'),
  `#!/usr/bin/env bash
echo "gh $*" >>"$FIX/calls"
case "$1 $2" in
  "pr list") cat "$FIX/prs" ;;
  "run view") [[ -f $FIX/log-$3 ]] || exit 1; cat "$FIX/log-$3" ;;
  "run rerun") echo "$3 $4" >>"$FIX/reruns"; [[ ! -f $FIX/rerun-fails-$3 ]] ;;
  "api "*)
    case "$2" in
      */actions/workflows/*/runs\\?*)
        sha=\${2#*head_sha=}; sha=\${sha%%&*}
        [[ -f $FIX/run-$sha ]] && cat "$FIX/run-$sha"; exit 0 ;;
      */contents/*)
        ref=\${2##*ref=}; [[ -f $FIX/Dockerfile-$ref ]] || { echo 'HTTP 404' >&2; exit 1; }
        cat "$FIX/Dockerfile-$ref" ;;
      *) echo "unexpected gh api $2" >&2; exit 99 ;;
    esac ;;
  *) echo "unexpected gh $*" >&2; exit 99 ;;
esac
`,
);
// curl: -o OUT URL -> the fixture index for that URL, or fail like curl -f.
writeFileSync(
  join(BIN, 'curl'),
  `#!/usr/bin/env bash
echo "curl $*" >>"$FIX/calls"
out=; url=
while (($#)); do case $1 in -o) out=$2; shift 2 ;; -*) [[ $1 == --retry || $1 == --max-time ]] && shift; shift ;; *) url=$1; shift ;; esac; done
key=\${url#https://dl-cdn.alpinelinux.org/alpine/}; key=\${key%/APKINDEX.tar.gz}; key=\${key//\\//_}
[[ -f $FIX/idx/$key.tar.gz ]] || exit 22
cp "$FIX/idx/$key.tar.gz" "$out"
`,
);
chmodSync(join(BIN, 'gh'), 0o755);
chmodSync(join(BIN, 'curl'), 0o755);

// An Alpine-shaped APKINDEX.tar.gz: signature tar minus its end-of-archive
// blocks, gzipped, then the index tar gzipped, concatenated.
const index = (path, pkgs) => {
  const d = mkdtempSync(join(TMP, 'mk-'));
  const body = Object.entries(pkgs)
    .map(([p, v]) => `C:Q1abc=\nP:${p}\nV:${v}\nA:x\nt:1781823476\n`)
    .join('\n');
  writeFileSync(join(d, 'APKINDEX'), `${body}\n`);
  writeFileSync(join(d, 'DESCRIPTION'), 'v3.24.0-fixture\n');
  writeFileSync(join(d, '.SIGN.RSA.fixture.rsa.pub'), 'x'.repeat(512));
  execFileSync('tar', ['-cf', 'sig.tar', '.SIGN.RSA.fixture.rsa.pub'], { cwd: d });
  execFileSync('sh', ['-c', 'head -c 1024 sig.tar | gzip -n > sig.gz && tar -cf - APKINDEX DESCRIPTION | gzip -n > idx.gz && cat sig.gz idx.gz > out'], { cwd: d });
  writeFileSync(path, readFileSync(join(d, 'out')));
};

const DEFAULT_ENV = {
  GH_REPO: 'owine/fixture',
  WORKFLOW: 'test.yml',
  DOCKERFILE: 'Dockerfile',
  ARCHES: 'x86_64 aarch64',
  ALPINE_BRANCH: 'v3.24',
  COMPONENTS: 'main,community',
  MAX_ATTEMPTS: '3',
  DRY_RUN: 'false',
  ALPINE_MIRROR: 'https://dl-cdn.alpinelinux.org/alpine',
};

// fx: { prs: [[n, sha]], runs: {sha: 'id status conclusion attempt'}, logs: {id: text},
//       dockerfiles: {sha: text}, rerunFails: [id], indexes: {'v3.24_main_x86_64': {pkg: ver}} }
let n = 0;
const run = (fx, env = {}) => {
  const FIX = join(TMP, `fx${n++}`);
  mkdirSync(join(FIX, 'idx'), { recursive: true });
  writeFileSync(join(FIX, 'prs'), (fx.prs ?? []).map((p) => p.join(' ') + '\n').join(''));
  for (const [sha, r] of Object.entries(fx.runs ?? {})) writeFileSync(join(FIX, `run-${sha}`), `${r}\n`);
  for (const [id, l] of Object.entries(fx.logs ?? {})) writeFileSync(join(FIX, `log-${id}`), l);
  for (const [sha, d] of Object.entries(fx.dockerfiles ?? {})) writeFileSync(join(FIX, `Dockerfile-${sha}`), d);
  for (const id of fx.rerunFails ?? []) writeFileSync(join(FIX, `rerun-fails-${id}`), '');
  for (const [k, pkgs] of Object.entries(fx.indexes ?? {})) index(join(FIX, 'idx', `${k}.tar.gz`), pkgs);
  const summary = join(FIX, 'summary');
  const r = spawnSync('bash', [join(TMP, 'step.sh')], {
    cwd: FIX,
    encoding: 'utf8',
    env: { PATH: `${BIN}:${process.env.PATH}`, HOME: TMP, FIX, GITHUB_STEP_SUMMARY: summary, ...DEFAULT_ENV, ...env },
  });
  const read = (f) => (existsSync(join(FIX, f)) ? readFileSync(join(FIX, f), 'utf8') : '');
  return {
    code: r.status,
    out: `${r.stdout}${r.stderr}`,
    reruns: read('reruns').trim().split('\n').filter(Boolean),
    calls: read('calls'),
    summary: read('summary'),
  };
};
const show = (r) => `exit ${r.code}; reruns [${r.reruns}]\n${r.out}`;

const APK_FAIL = [
  '#8 0.853 ERROR: unable to select packages:',
  '#8 0.855   nodejs-24.22.2-r0:',
  '#8 0.855     breaks: world[nodejs=24.22.3-r0]',
  '',
].join('\n');
const OTHER_FAIL = 'npm ERR! Test failed.  See above for more details.\n';

// Main has every package; aarch64 is still on the previous nodejs.
const INDEXES = {
  'v3.24_main_x86_64': { curl: '8.23.0-r0', zlib: '1.4-r0', nodejs: '24.22.3-r0', 'build-base': '0.5-r4', tini: '0.19.0-r3', 'postgresql18-client': '18.6-r0' },
  'v3.24_main_aarch64': { curl: '8.23.0-r0', zlib: '1.4-r0', nodejs: '24.22.2-r0', 'build-base': '0.5-r4', tini: '0.19.0-r3', 'postgresql18-client': '18.6-r0' },
  'v3.24_community_x86_64': { 'yq-go': '4.53.3-r2', 'py3-img2pdf': '0.6.3-r1' },
  'v3.24_community_aarch64': { 'yq-go': '4.53.3-r2', 'py3-img2pdf': '0.6.3-r1' },
};

// Every shape the parser has to get right, in one file. Expected pins below.
const TORTURE = `# syntax=docker/dockerfile:1
FROM alpine:3.24.3 AS builder
# A comment that mentions apk add commented=1-r0 is not a pin.
RUN apk add --no-cache --virtual .build-deps \\
    build-base=0.5-r4 \\
    curl=8.23.0-r0 && \\
    # apk add ghost=9-r9 inside the continuation is dropped, as Docker does
    make all && echo not=apin && \\
    apk del .build-deps
ENV FOO=bar
RUN apk --no-cache --repository=https://example.invalid/edge add \\
    zlib=1.4-r0 \\
    "$EXTRA" fuzzy=~1.2 ranged>=3 tini=0.19.0-r3; apk info
FROM alpine:3.24.3
RUN apk add postgresql18-client=18.6-r0 \\
    yq-go=4.53.3-r2 | tee /dev/null
`;
const TORTURE_PINS = 'build-base=0.5-r4 curl=8.23.0-r0 postgresql18-client=18.6-r0 tini=0.19.0-r3 yq-go=4.53.3-r2 zlib=1.4-r0';

// ---------------------------------------------------------------------------
// One sweep: every per-PR outcome, in an order that proves the loop carries on
// ---------------------------------------------------------------------------
{
  const r = run({
    prs: [
      [110, 'a110'], [102, 'a102'], [103, 'a103'], [104, 'a104'], [105, 'a105'],
      [106, 'a106'], [107, 'a107'], [109, 'a109'], [111, 'a111'], [108, 'a108'], [101, 'a101'],
    ],
    runs: {
      a101: '9101 completed failure 1',
      a102: '9102 completed failure 1',
      a103: '9103 completed failure 1',
      a104: '9104 completed success 1',
      a105: '9105 completed failure 3',
      a106: '9106 in_progress null 1',
      a108: '9108 completed failure 2',
      a109: '9109 completed failure 1',
      a110: '9110 completed failure 1',
      a111: '9111 completed failure 1',
    },
    logs: { 9101: APK_FAIL, 9102: APK_FAIL, 9103: OTHER_FAIL, 9105: APK_FAIL, 9108: APK_FAIL, 9109: APK_FAIL, 9110: APK_FAIL },
    dockerfiles: {
      a101: 'FROM alpine\nRUN apk add --no-cache curl=8.23.0-r0 yq-go=4.53.3-r2\n',
      a102: 'FROM alpine\nRUN apk add --no-cache \\\n  curl=8.23.0-r0 \\\n  nodejs=24.22.3-r0\n',
      a105: 'FROM alpine\nRUN apk add curl=8.23.0-r0\n',
      a108: TORTURE,
      a109: 'FROM alpine\nRUN apk add --no-cache curl jq\n',
      a110: 'FROM alpine\nRUN apk add zlib=1.4-r0\n',
    },
    rerunFails: ['9110'],
    indexes: INDEXES,
  });
  check('a sweep exits 0', r.code === 0, show(r));
  check(
    'reruns exactly the PRs whose pins are on every architecture, with --failed',
    same(r.reruns, ['9110 --failed', '9108 --failed', '9101 --failed']),
    show(r),
  );
  check('names the missing pin and the architecture it is missing from', r.out.includes('#102: nodejs=24.22.3-r0 is not on aarch64'), show(r));
  check('does not report a pin missing where it is present', !/#102: \S+ is not on x86_64|#102: curl/.test(r.out), show(r));
  check('leaves a failure without the apk message alone', r.out.includes('#103: run 9103 failed for another reason'), show(r));
  check('leaves a passing run alone', r.out.includes('#104: test.yml run 9104 is completed/success'), show(r));
  check('stops at max-attempts', r.out.includes('#105: test.yml run 9105 has failed 3 attempts'), show(r));
  check('leaves an in-progress run alone', r.out.includes('#106: test.yml run 9106 is in_progress/null'), show(r));
  check('handles a PR with no run yet', r.out.includes('#107: no test.yml run for a107'), show(r));
  check('never reruns blind when the Dockerfile has no exact pins', r.out.includes('#109: no exact apk add pins'), show(r));
  check('carries on past a log it cannot read', r.out.includes('#111: could not read the failed-job log'), show(r));
  check('carries on past a rerun GitHub refuses', r.out.includes('#110: could not rerun run 9110'), show(r));
  check('reads the pins the way Docker does', r.out.includes(`#108: pins: ${TORTURE_PINS}`), show(r));
  check('reads the Dockerfile at the PR head', r.calls.includes('gh api repos/owine/fixture/contents/Dockerfile?ref=a101 '), r.calls);
  check(
    'asks only for pull_request runs of the given workflow at the PR head',
    r.calls.includes('repos/owine/fixture/actions/workflows/test.yml/runs?event=pull_request&head_sha=a101&per_page=1'),
    r.calls,
  );
  check('lists open Renovate PRs past one page', /gh pr list .*--limit 1000 /.test(r.calls), r.calls);
  check('fetches each architecture × component index once', (r.calls.match(/^curl /gm) ?? []).length === 4, r.calls);
  check('writes a job summary', r.summary.includes('- #101: reran the failed jobs of run 9101.'), r.summary);
}

// ---------------------------------------------------------------------------
// The rest of the contract
// ---------------------------------------------------------------------------
const ONE = {
  prs: [[101, 'a101']],
  runs: { a101: '9101 completed failure 1' },
  logs: { 9101: APK_FAIL },
  dockerfiles: { a101: 'FROM alpine\nRUN apk add --no-cache curl=8.23.0-r0 yq-go=4.53.3-r2\n' },
  indexes: INDEXES,
};
{
  const r = run(ONE, { DRY_RUN: 'true' });
  check('dry-run reruns nothing and says what it would rerun', r.code === 0 && !r.reruns.length && r.out.includes('would rerun run 9101 (dry-run)'), show(r));
}
{
  const r = run(ONE, { ARCHES: 'x86_64,aarch64', COMPONENTS: 'main community' });
  check('arches and components take commas or spaces', r.code === 0 && same(r.reruns, ['9101 --failed']), show(r));
}
{
  const r = run(ONE, { MAX_ATTEMPTS: '1' });
  check('max-attempts 1 means never rerun', r.code === 0 && !r.reruns.length, show(r));
}
{
  const r = run({ ...ONE, logs: { 9101: OTHER_FAIL } });
  check('no index is fetched when no PR needs one', r.code === 0 && !r.calls.includes('curl '), r.calls);
}
{
  const r = run({ prs: [] });
  check('no open Renovate PRs exits 0', r.code === 0 && r.out.includes('No open Renovate PRs'), show(r));
}
{
  const r = run(ONE, { ARCHES: 'x86_64 armv7' });
  check('an index that cannot be fetched exits 1 and reruns nothing', r.code === 1 && !r.reruns.length && r.out.includes('could not fetch'), show(r));
}
for (const [k, v] of [
  ['ALPINE_BRANCH', '3.24'],
  ['ALPINE_BRANCH', 'v3.24/../edge'],
  ['WORKFLOW', '../ci.yml'],
  ['WORKFLOW', 'ci'],
  ['DOCKERFILE', '../Dockerfile'],
  ['DOCKERFILE', '/etc/passwd'],
  ['DOCKERFILE', 'Dockerfile?ref=main'],
  ['ARCHES', 'x86_64 aarch64;id'],
  ['ARCHES', ''],
  ['COMPONENTS', 'main/../x'],
  ['MAX_ATTEMPTS', '0'],
]) {
  const r = run(ONE, { [k]: v });
  check(`rejects ${k}=${JSON.stringify(v)} before calling anything`, r.code === 1 && !r.calls, show(r));
}

rmSync(TMP, { recursive: true, force: true });
if (failures.length) {
  console.error(`\n${failures.length} of ${checks} checks FAILED:\n\n  ${failures.join('\n\n  ')}\n`);
  process.exit(1);
}
console.log(`\n${checks} checks passed.`);
