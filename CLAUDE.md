# CLAUDE.md

This repo is the fleet's shared config hub for two tools:

- **Renovate presets** (`*.json`), consumed as `github>owine/renovate-config` /
  `github>owine/renovate-config:<preset>`.
- **The release-drafter base config** (`release-drafter.yml`), consumed by ten
  repos as `_extends: owine/renovate-config:/release-drafter.yml`.

`README.md` is the human reference for both: Usage, Presets, Tests, Commit
types & release notes, Releases: release-drafter (with the per-shape canonical
workflows and the Onboarding a repo checklist). This file covers what an agent
needs before changing anything: what is live, and what else breaks.

## Tests

No `package.json`, by design. Tests import the Renovate dist inside the CI
container (`.github/workflows/validate.yml`). Locally:

```sh
npm i renovate && RENOVATE_DIST=./node_modules/renovate/dist node test/<name>.mjs
```

Exit `1` is a behavior regression. Exit `2` means the test couldn't bind to
what it checks, not a config bug: the Renovate dist moved (an image bump) or
`RENOVATE_DIST` points at the wrong install, or, in `custom-managers.mjs`,
the `customManagers` array was reordered. The message says which. Run every
`test/*.mjs` that touches what you changed, plus the validator over every
preset; with no arguments it checks only `renovate.json`:

```sh
renovate-config-validator --strict renovate.json default.json automerge.json \
  node.json python.json docker.json mcp.json alpine.json home-assistant.json
```

## Everything here is live on merge

Consumers resolve presets **and** `release-drafter.yml` from the default
branch, unpinned. A merge to `main` changes every consumer's next Renovate run
and every consumer's next draft. There is no staging. Prove a change first:
Renovate changes with a dry-run fixture, release-drafter changes with a
`dry-run: true` replay in one consumer (README, Onboarding a repo, Phase A
step c).

## Release-drafter: what couples to what

Changing `release-drafter.yml` (or a consumer's copy of the workflow) can break
four things outside this file. Check each.

1. **Renovate commit types ↔ categories.** Presets decide a Renovate PR's
   title type (`deps:`, `fix:`, `ci:`, `chore:`); categories key off that type.
   `test/release-drafter.mjs` asserts the mapping and `test/commit-types.mjs`
   that no branch mixes a hidden type with `deps:`. Adding a type to a preset
   fails the first test until a category decides where it goes.

2. **The HA add-ons parse the release body into `CHANGELOG.md`.**
   claude-terminal-home-assistant `publish.yml` and ha-hetrixtools-agent
   `build.yaml`, job `promote`. They read the body from `$GITHUB_EVENT_PATH`
   (not `env`: one env string caps at 128 KiB), demote every heading one level,
   and turn PR references into links. Any new markup in the body (headings,
   `<details>`, footers, a different PR-number format) reaches Home Assistant's
   changelog view. Update both `promote` jobs, backward compatible, **before**
   the shared config changes. claude-terminal is canonical; hetrixtools ports
   it.

3. **Consumer overrides are shallow.** `_extends` merges top-level keys; a key
   the consumer sets replaces the base's. Consumers set only `tag-prefix`,
   `tag-template`, `name-template` (hetrixtools: `hetrixtools-agent-v`; the two
   MCPs: bare `X.Y.Z`) and, per the template design, `footer`. Never override a
   list key (`categories`, `replacers`, `group-changes`) in a consumer: it
   replaces the whole shared list.

4. **The consumer workflow is ten copies.** Each repo's
   `.github/workflows/release-drafter.yml` pins
   `release-drafter/release-drafter@978bb0b30c5ee8cdd332ced253758157150d43f0 # v7.10.0`,
   runs with `GITHUB_TOKEN`, and must never set `publish: true`: a release
   published by `GITHUB_TOKEN` fires no `release: published` workflows, so
   nothing would ship. A human publishes drafts. A step added to the workflow
   (e.g. the summary step) is a change in ten repos; its canonical source lives
   here under `scripts/` with a test.

## Release shapes and their invariants

README, Releases: release-drafter, links one canonical workflow per shape.
The non-obvious rules each one carries:

- **npm libraries** (unifi-protect-mcp canonical, unifi-network-mcp): the
  committed `package.json` version is `0.0.0-development`; the build runs
  `npm version "$TAG" --no-git-tag-version`. Keep the workflow filename
  `release.yml`: npm trusted publishing is bound to it.
- **HA add-ons** (claude-terminal canonical, hetrixtools): `promote` commits
  `config.yaml` + `CHANGELOG.md` in one signed `createCommitOnBranch` commit,
  only after the multi-arch manifest exists, forward-only.
- **Docker, retagged** (doc-scanner canonical, house-manager, trip-tracker,
  youth-activity-scheduler): `release.yml` retags main's existing
  `sha-<long>` digest, never rebuilds; floating tags move forward-only;
  `ci-pass` must keep the publish job in its `needs`; nothing inside the image
  may claim a semver (it reports the commit SHA).
- **Docker, rebuilt** (MLB-Deferred-Contract-Calculator, nut-cgi): built from
  the tagged commit; nut-cgi's image tags keep the `v`. Kept on purpose:
  downstream pins them by version + digest, so their non-forward-only `latest`
  is harmless.

Downstream, owine/docker-piwine pins every first-party image as
`X.Y.Z@sha256:…` (nut-cgi `vX.Y.Z@…`).

## Verifying a release-drafter change in a consumer

```sh
gh release list -R owine/<repo> -L 3                     # one draft, newest
gh release view <draft-tag> -R owine/<repo> --json body -q .body
gh run view <id> -R owine/<repo> --log | grep -E 'Config fetched|Found .* merged|RESOLVED_VERSION:'
```

The run log must show `Config fetched from "owine/renovate-config/release-drafter.yml"`.
A draft reading `_No user-facing changes._` is correct when only hidden types
merged; don't publish it.

## Design history

- Migration from release-please and the image-repo release shapes:
  README, Releases: release-drafter.
- Template polish (emoji headings, grouping, summary line, install footers):
  `docs/superpowers/specs/2026-10-26-release-notes-template-design.md`.
