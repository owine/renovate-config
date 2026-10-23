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
| `automerge.json` | Group all non-major updates into one weekly PR, automerge once CI passes. CI plumbing (Actions + `.github/workflows` literals) gets a **second** weekly PR, `all non-major ci dependencies`, so a `ci:` bump can't take a runtime bump's release with it (see Commit types). `pin`/`pinDigest` are split onto a separate `pins` PR so they can run at any time — a `groupName` is a branch name and a branch gets one schedule, so bundling them would have pinned them to Monday. Skip if you want hand-review of every patch. |
| `node.json` | Node/TS ecosystem groupings (most are peer-dep/lockstep coupled; a few are explicitly churn reduction — each rule says which): React, TanStack, Radix (the unified `radix-ui` package **and** the legacy `@radix-ui/*` primitives, for migration coherence), Vite, Tailwind (`tailwindcss` + `@tailwindcss/*` only — **not** the third-party `tailwind-merge`/`tw-animate-css`), Vitest (the whole `@vitest/*` scope, incl. `@vitest/ui`) + testcontainers, Testing Library (the `@testing-library/react` + `@testing-library/dom` peer pair only), ESLint plugins, ESLint core (`eslint` + `@eslint/js`, deliberately a **separate** group from the plugins), Prisma, Auth.js, pg, Hono, Preact, Cloudflare Workers (wrangler/@cloudflare/miniflare, plus the npm `cf` CLI, which is coupled to wrangler via its generated `wrangler.config.ts` and scoped to npm because PyPI and mise also use the name `cf`), toolchain (node+pnpm). Plus Next.js (incl. `eslint-config-next`, which must stay ordered after `eslint plugins`), Playwright (**npm-scoped via `matchDatasources`** so it never reaches the PyPI package of the same name), react-hook-form, stylelint, tesseract.js, Sentry (the `getsentry/sentry-javascript` SDK monorepo **only**, matched by `matchSourceUrls` because the `@sentry/*` scope spans several release trains. The bundler plugins and `@sentry/cli` stay ungrouped). A trailing **pre-seeded** block covers ecosystems no repo uses yet (storybook, OpenTelemetry, AWS SDK, tRPC, drizzle, NestJS, Babel, SWC, jest, astro, nuxt, SvelteKit, expo, apollo, clerk, supabase) so the first adopter is grouped on day one. The AWS/OTel group names are ecosystem-suffixed (`aws-sdk-js`, `opentelemetry-js`) because a groupName is a branch name — sharing one with `python.json` would merge both ecosystems into a single cross-manager PR. |
| `python.json` | pep621 ecosystem groupings (mostly peer-dep/hard-pinned; `scientific-python` is churn reduction): FastAPI stack, Pydantic, SQLAlchemy stack, pytest, lint/types tooling, boto3+botocore (hard pin), PyTorch trio, LangChain, OpenTelemetry, Celery (`vine` is also an npm name — the `matchManagers` scope is load-bearing), plus pre-seeded Django, Hugging Face, and numpy/scipy/pandas. `sentry-sdk` is deliberately **not** grouped: it's a single package whose integration extras set only version floors (see the file's top-level description). Plus a `python runtime` group binding an exact-pinned `requires-python` (native pep621 manager, so Renovate regenerates `uv.lock` itself) to the `python` Docker base image, `.python-version`, and the CPython version a workflow passes to `uv python install` or `actions/setup-python`. CPython **minors** (`3.14` → `3.15`) are reviewed like majors; patches automerge. Every other `requires-python` shape (`>=3.10`, `~=3.14`, `==3.14.*`) is metadata and stays untracked. See Consumer notes. |
| `docker.json` | Dockerfile base bundling, GH Actions setup/artifact/docker families, runtime-major flags. The `dockerfile bases` group **excludes the language-runtime images** (`node`/`pnpm`/`python`, both bare and `docker.io/library/…` spellings) so they stay with their own runtime groups — see Consumer notes. |
| `mcp.json` | MCP server repos, i.e. **npm-published libraries**: isolate `@modelcontextprotocol/sdk` for manual review (no automerge); leave every `engines` range alone so library consumers keep a broad one; and commit **dev-only** updates (`devDependencies`, `packageManager`, `.nvmrc`) as `chore:`, so they stop cutting no-op patch releases. Non-major `devDependencies` get their own `all non-major dev dependencies` PR (automerge inherited from `automerge.json`), keeping `chore:` off the `deps:` bundle. Runtime `dependencies` and security fixes still release. See Commit types. Extend after `node.json`. |
| `alpine.json` | Alpine updates. apk pins (**built-in `apk` datasource**, extracted from `RUN apk add` by the dockerfile manager since Renovate 44.96.0): one `alpine packages` group, 0-day soak, runs any time, **automerges every non-major bump (patch/pin/digest/minor) together**, and forces `rangeStrategy: replace` (without it every drifted pin goes silently dark). Gates **`node:*-alpine` image bumps** (minor/patch) to manual review. Also gates **alpine base-image (`docker`) minor bumps** to manual review (the base-image patch line automerges). Carved out of `automerge.json`'s bundle **and** of `docker.json`'s `dockerfile bases` group — extend after both. **Requires a consumer-side `registryUrls`** naming the Alpine release line (see Consumer notes). |
| `home-assistant.json` | Home Assistant add-on repos. Pins the HA base image (`ghcr.io/home-assistant/base`) to a versioned tag + digest and gates its **minor bumps** to manual review (the tag *is* the Alpine line, so a bump means hand-editing the `branch=vX.Y` in the consumer's apk `registryUrls`); digest rebuilds automerge. Adds CalVer versioning for the `home-assistant/builder` action. Extend after `:automerge`/`:docker` (and `:alpine` if used). |

## Tests

`test/custom-managers.mjs` is a behavior gate for `default.json`'s two
`customManagers` and `python.json`'s `uv python install` manager, run by CI
before the validator. It matters because
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

`test/python-runtime.mjs` and `test/commit-types.mjs` use the same engine on
the package-rule side: the first checks `python runtime` tracking, grouping,
soak and review for every member (pin, image, `.python-version`, workflow
lines) through each consumer's real extends order,
the second checks that no group mixes a hidden type (`ci:`, `chore:`) with `deps:` (see Commit types below).

`test/release-drafter.mjs` closes the loop on the consumer side: it checks that
the shared `release-drafter.yml` shows every commit type the presets release
on and pre-excludes the hidden ones, and that a preset assigning a new type
fails until someone decides where it goes (see Releases: release-drafter
below). It parses the YAML with the Renovate dist's own parser, and mirrors
release-drafter's category matching rather than installing release-drafter.

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
| dev-only, **`mcp.json` only**: `devDependencies`, `packageManager`, `.nvmrc` | `chore:` | **no release** (hidden) |

Rule precedence (last match wins) is: catch-all `*` → `deps` → lock file maintenance → `chore` → major (no type of its own; inherits `deps`) → github-actions + `.github/workflows/**` → `ci` → (`mcp.json`) dev-only → `chore` → security `fix` (forced, so a CVE in an action or a dev dep still releases as a Bug Fix).

**Dev-only updates in libraries (`mcp.json`).** A library's consumers install its `dependencies`, never its `devDependencies`. Under the `deps:` baseline, though, every lefthook or `@types/node` bump cut a patch release anyway: 8 of the 9 Dependencies entries in owine/unifi-protect-mcp 2.15.0 were dev-only or toolchain, and each one was a no-op release for every `@latest` consumer. `mcp.json` types them `chore:`. It is scoped to that preset on purpose. An app's dev tooling still produces a deployable artifact, so apps keep the `deps:` baseline and their single bundle. The toolchain group is split by what consumers can see:
- `packageManager` and `.nvmrc` are `chore:`. Corepack honors `packageManager` only in this repo's own root, never in a consumer's install.
- `engines` is consumer-visible, so it is never typed `chore:`. `mcp.json` disables every `engines` entry (the fleet's `pin` would otherwise narrow the range to one version). That also keeps an engines bump from ever sharing the `chore:` toolchain branch.
- A Dockerfile `FROM node` would be consumer-visible too. No MCP repo builds an image today; if one starts, split the image out of `toolchain-versions` first.

CI plumbing is hidden because it isn't observable to anyone consuming the published image, package or server — an `actions/checkout` bump shouldn't move a version number. That covers both the `github-actions` manager (`.github/workflows`, `.github/actions`, `workflow-templates/`, any `action.yml`) and the workflow version literals the custom regex manager extracts; the latter is matched by *path*, not by `matchManagers: ["custom.regex"]`, so a consumer repo's own custom managers aren't silenced along with it.

**A branch gets one commit type, and any hidden type beats `deps`.** Renovate types a grouped branch by the highest-priority type among its upgrades, from the fixed list `chore` < `ci` < `build` < `fix` < `feat`. `deps` isn't on that list, so one `ci:` **or `chore:`** upgrade retypes the whole branch, and every runtime bump on it ships without a release. That is how owine/unifi-protect-mcp #284 released `ws` 8.22.0 with no changelog entry. Every hidden type therefore gets its own branch, grouped with exactly the matchers that assign the type:
- `automerge.json` puts CI plumbing on `all non-major ci dependencies`, mirroring `default.json`'s `ci:` rules.
- `mcp.json` puts non-major `devDependencies` on `all non-major dev dependencies`, mirroring its own `chore:` rule and taking `automerge.json`'s bundle update types.

`test/commit-types.mjs` runs an app consumer and an MCP consumer through the real rule chain. It fails if either pair drifts, if a runtime and a dev bump in the same week share a branch, if a vulnerable dev dep stops releasing as `fix:`, or if any group carries two types. Known exceptions it allows: `pins` (a pin changes no resolved version, so the type doesn't matter), and `toolchain-versions`. In the MCP libraries it already mixes `ci:` (annotated CI matrix lanes) with `chore:` (`.nvmrc`/`packageManager`), which is harmless because both are hidden. In an app it would only mix if a workflow Node literal is annotated (`# renovate: … depName=node-lts-NN packageName=node`) while the app also ships Node via `.nvmrc`/`packageManager`/Dockerfile. Use `node-version-file` there instead. `python runtime` is **not** an exception: it has workflow members (`uv python install X.Y`, setup-python's `python-version:`), so `python.json` types the whole group `deps:`, or one CI line would ship a CPython bump of the image as a hidden `ci:`. The price is that a branch of *only* workflow lines (a one-time catch-up of stale lines) also releases.

## Releases: release-drafter

The fleet is moving from release-please to [release-drafter](https://github.com/release-drafter/release-drafter) v7, to drop the release-PR noise. Instead of a release PR, every push to `main` refreshes one **draft** GitHub Release, and a human publishes it when they want to release.

[`release-drafter.yml`](release-drafter.yml) at this repo's root is the shared base config, so the six repos can't drift. It sorts merged PRs by the Conventional Commit type of the **PR title**. The fleet squash-merges only, so the PR title is the commit subject, and for a Renovate PR that subject is whatever `default.json`'s `semanticCommitType` rules produced. The mapping is release-please's:

| PR title type | Section | Version bump |
|---|---|---|
| any type with `!` (`feat!:`, `fix(api)!:`, `chore!:`) | ⚠ Breaking Changes | major |
| `feat` | Features | minor |
| `fix` | Bug Fixes | patch |
| `perf` | Performance | patch |
| `revert` | Reverts | patch |
| `deps` | Dependencies (collapsed past 10 entries) | patch |
| `chore`, `ci`, `docs`, `test`, `refactor`, `build`, `style` | hidden | none |
| anything else (unknown type, non-conventional title) | listed unsectioned at the top | patch |

`perf` and `revert` are shown in every repo, even where release-please used to hide `perf`. That is a deliberate harmonization. The type prefix is stripped from each line the way release-please did it: `fix(api): x` renders as `**api:** x`. `test/release-drafter.mjs` asserts this table against the types the presets assign.

**Differences from release-please to expect:**
- **A draft always exists.** If only hidden types merged since the last release, the draft reads `_No user-facing changes._` with a patch version, where release-please opened no PR. Don't publish that draft.
- **Lines link PRs (`#123`), not commit SHAs.**
- **Non-conventional titles show up.** release-please ignored them; release-drafter lists them unsectioned and bumps patch.
- **No `bump-minor-pre-major`.** In a `0.x` repo, a breaking change drafts `1.0.0`, where release-please may have drafted `0.(x+1).0`.

### Per-repo migration checklist

Do one repo at a time. Phase A is additive and safe to merge any time. Do Phase B only after Phase A's check passes.

**Phase A: additive (release-please stays live)**

a. Add `.github/release-drafter.yml`:

   ```yaml
   _extends: owine/renovate-config:/release-drafter.yml
   ```

   The base assumes tags are `vX.Y.Z`. Check the repo's existing tags (`gh release list`). If they're shaped differently, override **all three** tag settings. `tag-prefix` decides which existing releases count as "the last release", so a wrong prefix makes the draft start from scratch. For bare `X.Y.Z` tags:

   ```yaml
   _extends: owine/renovate-config:/release-drafter.yml
   tag-prefix: ''
   tag-template: '$RESOLVED_VERSION'
   name-template: '$RESOLVED_VERSION'
   ```

   Override nothing else; categories and replacers stay shared. The `_extends` is read with the workflow's `GITHUB_TOKEN`, which only works because this repo is public.

b. Add `.github/workflows/release-drafter.yml`:

   ```yaml
   name: release-drafter

   on:
     push:
       branches: [main]
     workflow_dispatch:

   permissions: {}

   concurrency:
     group: release-drafter
     cancel-in-progress: true

   jobs:
     update-draft:
       runs-on: ubuntu-26.04
       timeout-minutes: 10
       permissions:
         contents: write
         pull-requests: read
       steps:
         - uses: release-drafter/release-drafter@978bb0b30c5ee8cdd332ced253758157150d43f0 # v7.10.0
           with:
             commitish: main
   ```

   It uses the default `GITHUB_TOKEN`, with no App token. Writing a draft triggers nothing downstream. When a human publishes the draft in the UI, `release: published` fires as that human, so downstream workflows run. (A release *published* by `GITHUB_TOKEN` would not trigger them, so never set `publish: true` here.)

c. After it merges, compare the draft release with the open release-please PR. They must agree on the **version** and on **which entries appear in which section**. Expected differences: heading text, PR links instead of SHAs, and `perf`/`revert` entries now shown. **If the version or the set of entries differs, stop and report. Don't start Phase B.**

**Phase B: cutover**

a. Delete the release-please workflow (or its job), `release-please-config.json`, `.release-please-manifest.json`, and every `x-release-please-*` marker (`grep -rn x-release-please`).

b. Make every publish/build trigger that keyed off release-please's output run on:

   ```yaml
   on:
     release:
       types: [published]
   ```

   In that run, `GITHUB_REF` is `refs/tags/<tag>` and `GITHUB_SHA` is the tagged commit. Replace any `needs: release-please` / `if: steps.release.outputs.release_created` plumbing with that trigger.

c. `CHANGELOG.md`:
   - **Home Assistant add-ons keep it.** The promote job prepends the published release's body.
   - **Every other repo freezes it.** Leave the history, and add a note at the top: `Releases after vX.Y.Z are documented in [GitHub Releases](https://github.com/owine/<repo>/releases).`

d. Update CLAUDE.md, README and CONTRIBUTING wherever they describe release-please or release PRs. Drop release-please paths (`release-please-config.json`, `.release-please-manifest.json`, `CHANGELOG.md` where frozen) from workflow `paths:`/`paths-ignore:` filters and any similar path lists.

e. Close the open release-please PR and delete its branch (`release-please--branches--main…`). **Ask before deleting the `autorelease: pending` / `autorelease: tagged` labels.**

f. List any `RELEASE_APP_*` secrets, `release` environment and GitHub App that no remaining job uses. Report the list for the human to remove by hand; don't remove them.

g. The human publishes the first draft. Watch the downstream `release: published` run through to the end, and check the tag and the artifacts it produced.

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

- **A `python runtime` PR regenerates `uv.lock` itself. Don't push to it.**
  `uv.lock` carries its own `requires-python`, so an exact `requires-python =
  "==X.Y.Z"` pin is tracked by the **native** pep621 manager. Its uv artifact
  step runs `uv lock --upgrade-package python` against the bumped pin and
  commits the result (a one-line `requires-python` change in `uv.lock`). Only
  the exact `==X.Y.Z` triple is tracked. Floor ranges, `~=`, `==3.14.*`, and
  compound specifiers are min-version metadata and are disabled. Keep
  `UV_PYTHON_DOWNLOADS=never` in the image so a pin the system Python can't
  satisfy fails the build instead of quietly falling back to a uv-managed
  interpreter.

  **The soak gates the merge, not the PR.** `minimumReleaseAge` is checked
  per dependency against its own datasource. `python-version` dates a release
  by CPython's release date. The Docker side uses Docker Hub's
  `tag_last_pushed`, and that is the *latest* push: official images are
  re-pushed under the same tag on every Debian rebuild, which restarts the
  clock (`3.15.0-slim` was dated 8 days after CPython 3.15.0). Under the default
  `internalChecksFilter: strict`, Renovate drops whichever half is still
  pending from the shared branch, so `renovate/python-runtime` opened with
  pyproject only and failed docker-build (owine/trip-tracker #282, #316). The
  group therefore sets `internalChecksFilter: none` and exempts the `python`
  image from the soak. Both halves always land on one branch at one version, and
  `renovate/stability-days` stays pending, blocking automerge, until the
  CPython release is 3 days old (7 for a major). Exempting the image alone
  would only flip the split: a fresh release would open a Dockerfile-only PR.
  `test/python-runtime.mjs` runs both timelines through Renovate's real filter
  and branch builder.

  One gap remains, and it closes itself. If a run lands after one registry
  lists the release but before the other does, the PR opens with one half and
  stays red until the other half joins on a later run, usually within hours.
  **Don't push a fix to it**: a human commit makes Renovate treat the branch
  as edited and stop updating it, which strands the missing half.

  If the artifact step itself fails, the PR still opens with the pyproject bump
  and an unchanged `uv.lock`. You'll see it: Renovate posts an *Artifact update
  problem* comment with uv's stderr and fails the `renovate/artifacts` check. Use
  the PR's retry checkbox once the cause is fixed. A failed install of the
  exact CPython is unlikely, because `python-version` only offers versions that
  already have a containerbase prebuild.

  What each split actually breaks:

  | Runtime | Split halves | Failure on *both* halves |
  |---------|--------------|--------------------------|
  | Node | `FROM node:X` vs `.nvmrc` + `engines.node` + `packageManager` | `ERR_PNPM_UNSUPPORTED_ENGINE` under `engineStrict`, mirrored expected/got |
  | Python | `FROM python:X` vs `requires-python = "==X.Y.Z"` + `uv.lock` | `No interpreter found for Python <old>` / the old base image can't satisfy the new pin |

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
  it's reviewed. (For Python, the 7 days rides the `python-version` half; the
  image is exempt, as described above.)

  **For Python the minor is the major.** CPython never ships 3 → 4, so the
  X.Y release is the one that removes deprecations and changes the ABI tag
  (`cp314` → `cp315`). `python.json` gives a `python runtime` minor the major
  treatment: `automerge: false`, a 7-day soak, and `breaking`/`needs-review`.
  Patches keep automerging. Before this, owine/trip-tracker #316 (3.14.8 →
  3.15.0) automerged with nobody looking.

- **setup-node version literals: annotate them, or use `node-version-file`.**
  Renovate's github-actions manager natively extracts `actions/setup-node`'s
  `node-version:` input (packageName `actions/node-versions`), and `node.json`
  **disables** that dep. Every setup-node literal in the fleet is annotated
  (`'24.22.0' # renovate: datasource=node-version depName=node-lts-24
  packageName=node`), so the native dep was a lane-blind duplicate of the same
  span. It went to a different branch: claude-terminal-home-assistant #432 and
  #433 bumped the same three lines. On the next LTS line it would also have
  ignored `node-lts-24`'s `<25` cap. The rule only applies under
  `.github/workflows/`, where the annotation manager runs: in a composite
  `action.yml` the native dep is the only tracker and stays on. An
  **unannotated** workflow literal is now untracked, so annotate it.

- **`python runtime` consumer checklist.** What the preset can't enforce:

  - **Dockerfile:** set `UV_PYTHON_DOWNLOADS=never` (and
    `UV_PYTHON_PREFERENCE=only-system`) in every stage that runs uv. Without it,
    a pin the base image can't satisfy silently downloads a uv-managed
    interpreter, which a non-root runtime user can't reach, instead of failing
    the build. youth-activity-scheduler sets neither (2026-10-19).
  - **mypy:** in an exact-pin repo, don't set `[tool.mypy] python_version`.
    mypy infers it from the interpreter it runs under, which is the pinned one,
    and a hard-coded value is a second pin Renovate doesn't bump
    (owine/trip-tracker #319). In a floor-only repo (`requires-python =
    ">=3.14"`), pinning it to the floor is correct: it checks that you don't
    use syntax newer than the floor.
  - **CI:** prefer not passing a version at all. `uv sync` provisions from an
    exact `requires-python`, and a bare `uv python install` reads
    `.python-version`. If a workflow does pass one, `uv python install 3.14` /
    `"3.14.8"` (one bare version) and setup-python's `python-version:` are
    tracked and ride the group, keeping their precision (`3.14` → `3.15`).
    Lists (`install 3.13 3.14`), `3.14t`, `cpython@…`, matrix expressions, and
    setup-uv's `python-version:` input are not.
  - **`.python-version` repos:** pyenv's manager looks the version up as a
    Docker Hub tag, so it soaks on the re-pushed `tag_last_pushed` clock. A
    re-push only makes a release look younger, so a patch can wait longer than
    3 days to automerge, never shorter.
  - **Never push to `renovate/python-runtime`.** Renovate then treats the
    branch as edited and stops updating it, which strands any half that hasn't
    landed yet. Use the dashboard's or the PR's retry checkbox instead.

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

- **pnpm repos that publish: set a trust policy in `pnpm-workspace.yaml`.**

  ```yaml
  trustPolicy: no-downgrade
  trustPolicyIgnoreAfter: 525600   # minutes = 365 days
  ```

  Lock file maintenance automerges (4x/week, `minimumReleaseAge: 0 days`), and
  what it moves is **transitive** versions. Renovate's soak covers only the
  direct deps it proposes, so for transitive versions nothing on the Renovate
  side checks provenance. With `no-downgrade`, `pnpm install` fails when a
  package's trust evidence drops below what its earlier releases had (e.g. a
  trusted-publisher package suddenly published from a plain token), which is
  the signature of a hijacked maintainer account. CI then fails and the lock
  file PR stops automerging until a human looks. `trustPolicyIgnoreAfter`
  exempts releases older than a year, which mostly predate provenance; without
  it, old transitive versions fail the check for having no evidence at all.
  Needs pnpm ≥ 10.27 (`trustPolicy` itself is 10.21). If one known-good
  release trips it, add it to `trustPolicyExclude` instead of loosening the
  policy. Leave `lockFileMaintenance`'s automerge and schedule as they are;
  the trust policy is the check, not a slower cadence. And don't add a pnpm-side
  `minimumReleaseAge` for the same purpose: the soak lives in Renovate, and a
  second one in pnpm strands lockfiles.
