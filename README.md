# renovate-config

Shared [Renovate](https://docs.renovatebot.com/) presets for `owine/*` repositories. Supply-chain hardened defaults: pin everything, soak releases, fast-track CVE fixes.

## Usage

In any repo's `renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [
    "github>owine/renovate-config",
    "github>owine/renovate-config:automerge",
    "github>owine/renovate-config:node",
    "github>owine/renovate-config:python",
    "github>owine/renovate-config:docker",
    "github>owine/renovate-config:mcp",
    "github>owine/renovate-config:alpine"
  ]
}
```

Only extend the ecosystem presets a repo actually uses. Extend `:mcp` *after* `:node`, and `:alpine` / `:home-assistant` last — after `:automerge`, `:docker`, and every other ecosystem preset.

## Presets

| File | Purpose |
|------|---------|
| `default.json` | Baseline. Pinned ranges, 3-day soak, OSV alerts, GH Action digests, lockfile maintenance, pre-commit hook updates, weekly schedule (Mondays, `America/Chicago`). Majors separated into their own PRs and held for manual review. `rebaseWhen: auto` — Renovate rebases stale PRs only when safe (no manual edits, no conflicts); use the PR checkbox to force a rebase otherwise. Two `customManagers` for `.github/workflows/*.yml`: `# renovate: datasource=X depName=Y` annotations, and **non-literal runner labels** (`matrix.include[].runner`, `workflow_call` input defaults, JSON-in-`run:`) — see Consumer notes. |
| `automerge.json` | Group all non-major updates into one weekly PR, automerge once CI passes. `pin`/`pinDigest` are split onto a separate `pins` PR so they can run at any time — a `groupName` is a branch name and a branch gets one schedule, so bundling them would have pinned them to Monday. Skip if you want hand-review of every patch. |
| `node.json` | Node/TS ecosystem groupings (most are peer-dep/lockstep coupled; a few are explicitly churn reduction — each rule says which): React, TanStack, Radix (the unified `radix-ui` package **and** the legacy `@radix-ui/*` primitives, for migration coherence), Vite, Tailwind (`tailwindcss` + `@tailwindcss/*` only — **not** the third-party `tailwind-merge`/`tw-animate-css`), Vitest (the whole `@vitest/*` scope, incl. `@vitest/ui`) + testcontainers, Testing Library (the `@testing-library/react` + `@testing-library/dom` peer pair only), ESLint plugins, ESLint core (`eslint` + `@eslint/js`, deliberately a **separate** group from the plugins), Prisma, Auth.js, pg, Hono, Preact, Cloudflare Workers (wrangler/@cloudflare/miniflare), toolchain (node+pnpm). Plus Next.js (incl. `eslint-config-next`, which must stay ordered after `eslint plugins`), Playwright (**npm-scoped via `matchDatasources`** so it never reaches the PyPI package of the same name), react-hook-form, stylelint, tesseract.js, Sentry (the `getsentry/sentry-javascript` SDK monorepo **only**, matched by `matchSourceUrls` because the `@sentry/*` scope spans several release trains. The bundler plugins and `@sentry/cli` stay ungrouped). A trailing **pre-seeded** block covers ecosystems no repo uses yet (storybook, OpenTelemetry, AWS SDK, tRPC, drizzle, NestJS, Babel, SWC, jest, astro, nuxt, SvelteKit, expo, apollo, clerk, supabase) so the first adopter is grouped on day one. The AWS/OTel group names are ecosystem-suffixed (`aws-sdk-js`, `opentelemetry-js`) because a groupName is a branch name — sharing one with `python.json` would merge both ecosystems into a single cross-manager PR. |
| `python.json` | pep621 ecosystem groupings (mostly peer-dep/hard-pinned; `scientific-python` is churn reduction): FastAPI stack, Pydantic, SQLAlchemy stack, pytest, lint/types tooling, boto3+botocore (hard pin), PyTorch trio, LangChain, OpenTelemetry, Celery (`vine` is also an npm name — the `matchManagers` scope is load-bearing), plus pre-seeded Django, Hugging Face, and numpy/scipy/pandas. `sentry-sdk` is deliberately **not** grouped: it's a single package whose integration extras set only version floors (see the file's top-level description). Plus a `python runtime` group binding an exact-pinned `requires-python` (via customManager) to the `python` Docker base image — **needs a manual `uv lock` commit**, see Consumer notes. |
| `docker.json` | Dockerfile base bundling, GH Actions setup/artifact/docker families, runtime-major flags. The `dockerfile bases` group **excludes the language-runtime images** (`node`/`pnpm`/`python`, both bare and `docker.io/library/…` spellings) so they stay with their own runtime groups — see Consumer notes. |
| `mcp.json` | MCP server repos: isolate `@modelcontextprotocol/sdk` for manual review (no automerge), keep `engines.node` unpinned for library consumers. Extend after `node.json`. |
| `alpine.json` | Alpine updates. apk pins (**built-in `apk` datasource**, extracted from `RUN apk add` by the dockerfile manager since Renovate 44.96.0): one `alpine packages` group, 0-day soak, runs any time, **automerges every non-major bump (patch/pin/digest/minor) together**, and forces `rangeStrategy: replace` (without it every drifted pin goes silently dark). Gates **`node:*-alpine` image bumps** (minor/patch) to manual review. Also gates **alpine base-image (`docker`) minor bumps** to manual review (the base-image patch line automerges). Carved out of `automerge.json`'s bundle **and** of `docker.json`'s `dockerfile bases` group — extend after both. **Requires a consumer-side `registryUrls`** naming the Alpine release line (see Consumer notes). |
| `home-assistant.json` | Home Assistant add-on repos. Pins the HA base image (`ghcr.io/home-assistant/base`) to a versioned tag + digest and gates its **minor bumps** to manual review (the tag *is* the Alpine line, so a bump means hand-editing the `branch=vX.Y` in the consumer's apk `registryUrls`); digest rebuilds automerge. Adds CalVer versioning for the `home-assistant/builder` action. Extend after `:automerge`/`:docker` (and `:alpine` if used). |

## Tests

`test/custom-managers.mjs` is a behavior gate for `default.json`'s two
`customManagers`, run by CI before the validator. It matters because
`renovate-config-validator --strict` is a **schema** check: every regex bug this
repo has shipped — the phantom dep of #108, the cross-block bind of #4 — passed
validation cleanly.

It imports the real extractor and the real auto-replacer out of the Renovate
install already inside the CI container, so assertions run against the same
engine Mend-hosted does, and the repo needs no `package.json`, lockfile or
toolchain of its own. Fixtures under `test/fixtures/` are frozen copies of
shapes that exist in the fleet; each says which invariant it guards and, where
the rewrite is non-obvious, the test also drives `doAutoReplace` and asserts
that exactly one line changed.

Locally:

```sh
npm i renovate && RENOVATE_DIST=./node_modules/renovate/dist node test/custom-managers.mjs
```

Exit codes: `0` pass, `1` a behavior regression, `2` the Renovate dist moved
(a layout problem, not a config one — likely an image bump).

## Commit types & release-please

These presets are tuned for consumer repos running [release-please](https://github.com/googleapis/release-please), which parses the Conventional Commit **type** to decide releases: `feat` → minor, `fix`/`deps` → patch, `chore`/`ci` → **hidden, no release**.

**No dependency update is ever typed `feat:`.** A `feat:` commit — and therefore a minor version bump — means a feature someone here wrote. An upstream version number crossing a major line is not that, so majors ride the `deps:` patch baseline like everything else; what marks them out is their own PR, the 7-day soak, `automerge: false` and the `major-update`/`needs-review` labels.

Renovate ships built-in default `packageRules` that type every bump `chore:` (npm production deps `fix:`), and `packageRules` always beat top-level config — so a bare `semanticCommitType` is inert and Dockerfile/Actions/apk repos would get **no release-please releases at all**. `default.json` reclaims the types via `packageRules`:

| Update | Commit type | release-please effect |
|--------|-------------|-----------------------|
| patch / minor / pin / digest | `deps:` | patch → *Dependencies* section |
| major | `deps:` | patch → *Dependencies* section (plus `major-update`/`needs-review` labels) |
| GitHub Actions / workflow tooling | `ci:` | **no release** (hidden) |
| security (`vulnerabilityAlerts`) | `fix:` | patch → *Bug Fixes* section |
| lock file maintenance | `chore:` | **no release** (hidden) |

Rule precedence (last match wins) is: catch-all `*` → `deps` → lock file maintenance → `chore` → major (no type of its own; inherits `deps`) → github-actions + `.github/workflows/**` → `ci` → security `fix` (forced, so a CVE in an action still releases as a Bug Fix).

CI plumbing is hidden because it isn't observable to anyone consuming the published image, package or server — an `actions/checkout` bump shouldn't move a version number. That covers both the `github-actions` manager (`.github/workflows`, `.github/actions`, `workflow-templates/`, any `action.yml`) and the workflow version literals the custom regex manager extracts; the latter is matched by *path*, not by `matchManagers: ["custom.regex"]`, so a consumer repo's own custom managers aren't silenced along with it.

## Supply-chain posture

- **`rangeStrategy: pin`** — caret/tilde ranges become exact versions in `package.json`/`pyproject.toml`.
- **`minimumReleaseAge: 3 days`** baseline (majors: 7 days) — soak window so a yanked/compromised release is caught before it lands; majors additionally require manual review.
- **`minimumReleaseAgeBehaviour: timestamp-optional`** — a timestamp-less release is treated as stable rather than held by the soak above.
  - Renovate 42's default (`timestamp-required`) marks any release lacking a publish timestamp as *pending indefinitely*.
  - Combined with the soak, that permanently freezes Docker updates from registries that don't expose timestamps: GHCR, Quay, `mcr.microsoft.com`, most private/Artifactory registries.
  - Docker Hub (and npm/PyPI/crates.io/etc.) still get the real soak — they provide timestamps. Timestamp-less registries skip it (they can't be soaked either way, so the choice is *flow* vs *deadlock*).
- **`vulnerabilityAlerts`** override — CVE fixes skip the soak and automerge.
- **Pins run off-schedule** — `pin` and `pinDigest` carry `schedule: ["at any time"]`, so a new dependency is pinned as soon as Renovate sees it instead of floating until Monday. Neither type changes the resolved version or the resolved artifact — only how it is written down: `pin` rewrites a range to the version already resolving under it, `pinDigest` appends the digest the tag already points at. `digest` is **not** included — a digest *refresh* re-points an unchanged tag at different bytes, so it stays in the reviewed weekly bundle. With `automerge.json` these land on their own `pins` branch (see below).
- **`helpers:pinGitHubActionDigests`** — every `uses:` resolves to a 40-char commit SHA.
- **`pinDigests: true`** for Dockerfiles — base images pinned by `@sha256:` digest.
- **`osvVulnerabilityAlerts`** + **`security:openssf-scorecard`** — extra vuln signal beyond GitHub's native alerts.

## Consumer notes & caveats

- **Action `version:` inputs are never digest-pinned.** The `github-actions`
  manager extracts up to three deps from one annotated step — the `uses:` line
  (depType `action`), the action's `version:` **input** for actions it knows how to
  read (depType `uses-with`), and a third from the `# renovate:` annotation via
  `default.json`'s customManagers. Only the first has somewhere to put a digest. A
  manager-wide `pinDigests: true` therefore hard-errors the branch with
  `Error updating branch: update failure`, and the upgrade sits under **Errored** on
  the Dependency Dashboard. `default.json` negates `pinDigests` for `uses-with`.
  - Negating `pinDigests` here removes an impossible operation, not a control: a
    `version:` input has no digest slot to begin with. The version is still
    extracted, tracked and updated — only the unwritable digest is skipped.
  - If a repo carries both a `# renovate:` annotation **and** an action whose
    `version:` input Renovate reads natively, the same literal is tracked twice.
    The two deps resolve against **different release streams** (the annotation's
    datasource vs. the action's native one — e.g. `pypi:ruff` vs.
    `github-releases:astral-sh/ruff`), so the updates agree only as long as those
    streams agree. They did in the observed case (both `0.16.8`); when they drift,
    one branch carries two updates rewriting the same literal to different values.
    Drop the annotation — native `uses-with` extraction already covers it.

- **Pins can still slip to Monday inside an ecosystem group.** The groups in
  `node.json`/`python.json` and `docker.json`'s `github-actions-*` rules set no
  `matchUpdateTypes`, so they match `pin`/`pinDigest` too and, being extended later,
  win the group name over `automerge.json`'s `pins`. A pin swept into one of those
  branches still runs at any time when it is that branch's **only** pending upgrade;
  it waits for Monday only when a version bump in the same group is pending in the
  same run. Accepted rather than fixed: excluding pins from ~55 grouping rules would
  push a scheduling concern into every ecosystem rule in the fleet and rot on the next
  group added. `dockerfile bases` is the one exception — it named `pinDigest`
  explicitly, and `pinDigest` is the conversion that recurs, since every new `FROM`
  line produces one.

- **Runner labels reached indirectly are now tracked.** The built-in
  `github-actions` manager extracts runner images from literal `runs-on:`
  values only — the Renovate docs say so outright for env-var indirection. Any
  label reached another way was invisible, so merging Renovate's PR shipped a
  **split-brain build** (test jobs on the new image, container builds on the
  old) that stayed **green**, because both images work and nothing flags the
  mismatch. `default.json` adds a `github-runners` customManager covering the
  three shapes that exist in this fleet:

  ```yaml
  # a. matrix.include[] — doc-scanner, youth-activity-scheduler, nut-cgi,
  #    MLB-Deferred-Contract-Calculator, house-manager
  include:
    - { platform: linux/arm64, runner: ubuntu-26.04-arm }

  # b. workflow_call input default — compose-workflow (feeds runs-on: ${{ inputs.runner }})
  inputs:
    runner:
      type: string
      default: 'ubuntu-24.04'

  # c. JSON string inside a run: step — trip-tracker's dynamic matrix
  - run: echo 'matrix=[{"runner":"ubuntu-26.04"}]' >> "$GITHUB_OUTPUT"
  ```

  **The capture mirrors the built-in manager's own regex**
  (`^\s*(?<depName>[a-zA-Z]+)-(?<currentValue>[^\s]+)`): `currentValue` takes
  the whole remainder, **suffix included**. The `github-runners` datasource
  carries `26.04-arm`, `15-large` and `15-intel` as *distinct versions* —
  `24.04-arm` is not `24.04` with decoration. Capturing a bare `\d+\.\d+`
  and letting the suffix sit outside the match looks tidier and is wrong: it
  files the arm runner under the x64 runner's version. Matching byte-for-byte
  also makes these deps share a `branchName` with the literal `runs-on:` ones,
  so both edits land in **one** PR — which is the whole point. Verified by dry
  run: `ubuntu-22.04` (runs-on) and `ubuntu-22.04` (matrix) both resolve to
  `renovate/ubuntu-24.x`, and `22.04-arm` → `24.04-arm`.

  There is no `autoReplaceStringTemplate` on purpose — the default value-only
  replacement rewrites exactly the `currentValue` span. Nothing is required of
  the consumer; these deps commit as `ci:` via the existing
  `matchFileNames: ['.github/workflows/**']` rule.

- **`alpine.json` is packageRules-only, and apk extraction is now built in.**
  Since Renovate **44.96.0** the `dockerfile` manager extracts
  `RUN apk add pkg=version` pins by itself, as `datasource: apk` /
  `depType: install`
  ([#45691](https://github.com/renovatebot/renovate/pull/45691)). The
  consumer-side `customManager`, the preset's `customDatasources` block, the
  `alpine_X_Y/` `depNameTemplate` and the `extractVersionTemplate` are all
  **gone** — delete them. Verified across the fleet at 44.97.1 (the fleet's
  Mend-hosted runner picked it up on 44.96.3): the built-in
  extractor finds exactly the same 40 pins the regex did, in all five consumer
  repos, with no dep on either side only.

  One thing the consumer must still supply: the registry URL naming its Alpine
  release line. The datasource's default is
  `branch=latest-stable&components=main`, which does **not** follow your base
  image.

  ```json
  {
    "matchDatasources": ["apk"],
    "registryUrls": ["https://dl-cdn.alpinelinux.org/alpine?branch=v3.24&components=main,community&arch=x86_64"]
  }
  ```

  The branch must be a **literal**: Handlebars in `registryUrls` is
  custom-datasource-only (`datasource/custom/utils.js`), so the old
  derive-it-from-the-depName trick cannot work for a built-in datasource. Renovate
  builds `<base>/<branch>/<component>/<arch>/APKINDEX.tar.gz` from the query
  params and rejects any unknown param, so a typo fails loudly. Upstream
  [#45706](https://github.com/renovatebot/renovate/issues/45706) will auto-detect
  this from the base image; when it lands, this rule can be deleted outright.

- **`main` and `community` go in ONE url, and the silent-miss trap is gone.**
  The `apk` datasource uses `registryStrategy: "merge"` (the opposite of custom
  datasources' `"first"`), so `components=main,community` fetches both indexes
  and aggregates the releases. A community package no longer needs its own
  override, and can no longer be silently untracked by being pointed at `main`.
  Verified: all 19 pins in `claude-terminal-home-assistant` — including the six
  community ones (`npm`, `py3-aiohttp`, `py3-beautifulsoup4`, `ttyd`, `vim`,
  `yq-go`) — resolve from the single merged URL. A component that simply does
  not carry a package logs a harmless per-component
  `No matching packages found` at debug level.

- **`rangeStrategy` must be `replace` for apk — the preset forces it, do not
  undo it.** `default.json` sets a top-level `rangeStrategy: "pin"`. The
  `dockerfile` manager *supports* `pin` (it pins base-image digests), so apk
  deps inherit it; the old `custom.regex` manager does not support `pin` and
  silently fell back to `replace`, which is why this never surfaced before. It
  matters because an APKINDEX carries **only the newest build** of each package:
  a pin that has already drifted is absent from the release list, and
  `getCurrentVersion`'s `pin` branch then returns `null`, so Renovate logs
  `No currentVersion or lockedVersion found`, sets `skipReason: invalid-value`
  and proposes **nothing**. The pins that most need an update are exactly the
  ones that would go dark. Only the `replace` branch reaches the
  `isVersion(currentValue) → currentValue` fallback. Measured on 44.97.1 against
  `nut-cgi`: under `pin`, its stale `curl` and `openssl` pins produced no
  updates; under `replace`, they produce the same bumps the retired
  `custom.alpine` datasource did.

- **The Alpine release line now lives in `registryUrls`, and is still
  unmanaged.** When a repo bumps its Alpine base image (`3.24` → `3.25`) it must
  hand-edit `branch=v3.24` → `branch=v3.25`. That is one edit, in one place, per
  repo — and it is repo-specific, which is why it is not in the shared preset.
  To protect the coupling, `alpine.json` gates **base-image `minor` bumps**
  (`datasource: docker`, `packageName: alpine`) to manual review — they are the
  ones that cross release lines and demand the hand-edit. Base-image `patch`
  bumps stay within the line, leave the URL valid, and automerge normally. The
  same gate exists in `home-assistant.json` for `ghcr.io/home-assistant/base`,
  whose tag *is* the Alpine line.

- **Verify a new apk pin by its `currentVersion`, never by dep count.** A
  package that is absent from every listed component yields no releases and no
  update; the dep count is unchanged either way, because it comes from the
  Dockerfile, not from the lookup. Assert instead that every `apk` dep in
  `renovate --platform=local --dry-run=full` output carries a non-null
  `currentVersion`. To check membership directly:

  ```bash
  PKG=tini; LINE=v3.24
  for R in main community; do
    hit=$(curl -s "https://dl-cdn.alpinelinux.org/alpine/$LINE/$R/x86_64/APKINDEX.tar.gz" \
          | tar -xzO APKINDEX 2>/dev/null | grep -A1 "^P:$PKG$" | grep '^V:' | head -1)
    printf '%-10s %s\n' "$R" "${hit:--}"
  done
  ```

  Renovate also skips, with a logged reason, pins it cannot act on: an
  unversioned `apk add bash` (`unspecified-version`) and a version from a
  variable (`contains-variable`). A fuzzy constraint such as `curl=~8.12.1` is
  extracted since
  [#45693](https://github.com/renovatebot/renovate/pull/45693) (merged
  2026-09-18) — the constraint itself becomes the `currentValue` and is
  rewritten only when the version moves outside it (`~8.12.1` → `~8.13.0`).
  Every pin in this fleet is an **exact** `=` pin and should stay that way: the
  `alpine packages` group's automerge rests on a drifted pin failing the Docker
  build loudly, which a `~` constraint would mask by accepting any `-rN`. That
  PR does not change exact-pin handling — `isSingleVersion` is still true for
  them, so `currentValue` and the replace template are unchanged.

  Virtual packages (`--virtual .build-deps`), local `.apk` files and provider
  deps (`so:`, `cmd:`) are ignored outright.

- **`node:*-alpine` bumps are gated to manual review.** A repo whose Alpine line
  comes from the Node image (`node:24.19.0-alpine` is Alpine 3.24.1) has the
  same coupling with nothing else guarding it — Node moves its Alpine base at
  its own cadence, including on patch rebuilds. `alpine.json` therefore gates
  `node` / `docker.io/library/node` **minor and patch** bumps to
  `automerge: false` + `needs-review`. It sets no `groupName`, so `node.json`'s
  `toolchain-versions` group still co-bumps node and pnpm in one PR — but
  because one non-automergeable upgrade disables its whole branch, **node and
  pnpm bumps stop automerging** in any repo extending `:alpine`. The gate is
  unconditional for `:alpine` consumers, even ones whose Alpine line comes from
  an `alpine:` base instead. `digest`/`pinDigest` are excluded: a same-tag
  rebuild can still re-point the floating alias, an accepted gap — pinning
  `node:X-alpine3.24` was rejected because Renovate can't couple the Node
  version and the Alpine suffix, so the line would freeze with nothing ever
  signalling the move. This is the **third** place `node` is named across these
  presets (with `node.json`'s `toolchain-versions` and `docker.json`'s
  `dockerfile bases` negation list) — keep the three in sync.

- **Preset ordering is load-bearing.** Compose as: `default` → `automerge` →
  ecosystem presets → `mcp` (after `node`) → `alpine` / `home-assistant` (after
  `automerge` **and `docker`**). Renovate applies `packageRules` in order and the
  last match wins; each later preset peels its packages out of the prior
  catch-all group. Wrong order leaves packages mis-grouped (e.g. apk pins stuck
  in the generic non-major automerge bundle, or the alpine / HA base-image minor
  gate losing to `docker.json`'s "dockerfile bases" group / `automerge.json`'s
  bundle).

- **Language runtimes move as one PR, by exclusion — not by ordering.** Both
  `node.json`'s `toolchain-versions` and `python.json`'s `python runtime` group a
  runtime's Docker base image together with the manifest that pins the same
  version. `docker.json`'s `dockerfile bases` rule matches
  `matchManagers: ["dockerfile"]`, so it would otherwise re-group those base
  images out — last matching rule wins, and `:node`/`:python` are extended before
  `:docker`. It therefore **negates** `node`, `pnpm`, `python`, and their
  `docker.io/library/…` spellings. The negation is deliberate rather than a
  reliance on preset order: `extends` order lives in each consumer's
  `renovate.json`, and no consumer should have to know that grouping depends on
  it. The exclusion list and the two runtime rules must stay in sync — a name
  excluded in `docker.json` but missing from its runtime rule gets no group at
  all and splits exactly as before. Entries are plain strings, glob-matched with
  `.` and `/` literal, so `python-slim`, `my.registry/python`, `nodered/node-red`,
  and `docker.io/library/postgres` all still group as `dockerfile bases`.

- **A `python runtime` PR lands red and needs a manual `uv lock` commit.**
  `uv.lock` carries its own `requires-python`, and nothing in these presets can
  refresh it: the exact-pin tracker is a `customManager` (a text substitution
  that runs no lockfile update), and `postUpgradeTasks` isn't available on the
  Mend-hosted app. Push one hand-authored `uv lock` commit to the PR branch or
  every uv job fails `The current Python version … is not compatible with the
  locked Python requirement`. Lockfile maintenance reconciles `uv.lock`
  eventually, but on its own schedule and on a different branch — it will not
  unblock the open PR.

  What each split actually breaks:

  | Runtime | Split halves | Failure on *both* halves |
  |---------|--------------|--------------------------|
  | Node | `FROM node:X` vs `.nvmrc` + `engines.node` + `packageManager` | `ERR_PNPM_UNSUPPORTED_ENGINE` under `engineStrict`, mirrored expected/got |
  | Python | `FROM python:X` vs `requires-python = "==X.Y.Z"` | `No interpreter found for Python <old>` / `not compatible with the locked Python requirement` |

  Digest pinning is unaffected either way: `pinDigests` comes from
  `default.json`'s `matchManagers: ["dockerfile", "github-actions"]` rule, and
  the runtime images' `digest`/`pinDigest` updates just group under their runtime
  name. The `dockerfile bases` group no longer lists `pinDigest` at all: it is
  extended after `automerge.json`, so naming it there won the group and parked every
  tag-to-digest conversion back on the weekly branch. A base image's **first** digest
  pin now rides `pins` and lands immediately; every later digest **refresh** still rides
  `dockerfile bases`. In a repo that extends `:docker` but **not** the matching ecosystem
  preset, a runtime base-image bump becomes its own PR (or joins
  `automerge.json`'s non-major bundle) — self-consistent, since there is no
  manifest on the other side to disagree with it.

- **Runtime majors stay grouped.** Neither runtime rule sets
  `matchUpdateTypes`, so the group covers majors too — a runtime major has the
  same drift hazard as a patch, and both deps bump to the same version. This
  doesn't weaken the major policy: `separateMajorMinor`/`separateMultipleMajor`
  still isolate the major onto its own branch, and `default.json`'s major rule
  still applies the 7-day soak, `automerge: false`, and
  `major-update`/`needs-review`. Grouping decides who shares the branch, not how
  it's reviewed.

- **`home-assistant.json` is opt-in for HA add-on repos.** It pins
  `ghcr.io/home-assistant/base` (tag + digest) and gates its `minor` bumps to
  manual review for the same reason as the alpine base image: the HA base tag
  *is* the Alpine release line, so a bump forces the `branch=vX.Y` hand-edit in
  the consumer's apk `registryUrls`. It also gives the `home-assistant/builder` action
  CalVer (`YYYY.MM.PATCH`) versioning. Extend it late, after `:docker`.

- **Major apk bumps fall through to `default.json`.** `alpine.json`'s apk group
  matches only `patch`/`pin`/`digest`/`minor` (all automerged together), so a major
  bump is handled by the baseline major rule (7-day soak, `automerge: false`,
  `needs-review`). Rare in practice — `apk` versioning seldom classifies an apk
  bump as major.
