# go.json: shared Go preset

Date: 2026-11-06. First consumer: owine/labelprint (Go 1.27, `golang:*-alpine`
build stage, `alpine` runtime stage, CI `setup-go` with `go-version-file: go.mod`).

## Problem

labelprint carries three repo-local rules (`gomodTidy`, a `go toolchain` group,
indirect modules enabled). Measured on Renovate 44.201.0 they hide three
defects, and two of those would also bite the next Go repo:

1. **The `go` directive never moves.** gomod extracts it with
   `go-mod-directive` versioning, whose `getNewValue` returns a new value only
   under `rangeStrategy: bump`. `replace` keeps the current value while the new
   version satisfies `^current`, and anything else (the fleet's top-level `pin`)
   always keeps it. A fixture with `go 1.26.1` produced no update under fleet
   defaults and `1.26.1 -> 1.27.3` under `bump`. The `go toolchain` group could
   only ever carry the image.
2. **The soak splits image from directive.** golang-version dates Go 1.27.3 by
   its release day (2026-10-19). Docker Hub dates `golang:1.27.3-alpine` by
   `tag_last_pushed`, which was 2026-11-06T01:23Z because official images are
   re-pushed whenever their base is rebuilt. Under `internalChecksFilter:
   strict` the image fell back to `1.27.2-alpine` while the directive took
   `1.27.3`, on one branch. The golang image sets `GOTOOLCHAIN=local`, so the
   build fails with `go.mod requires go >= 1.27.3`. This is python.json's
   trip-tracker #282/#316 mechanism.
3. **Moved into a preset, the group loses the image.** Consumers extend
   ecosystem presets before `:docker`, and `dockerfile bases` matches
   `matchManagers: [dockerfile]`. labelprint's rule only won because repo-local
   rules sort last.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Go minors (1.27 -> 1.28) | Review-gated: `automerge: false`, 7-day soak, `breaking` + `needs-review`. Patches automerge. | The `go` line flips GODEBUG defaults; x.y.0 is usually followed by x.y.1 within weeks. Twice a year, so the review cost is small. |
| Indirect modules | Fully enabled | Trivy flagged CVEs in zebrash-pinned `golang.org/x/{image,text}` before OSV did. The automerged bundle absorbs the churn. |
| `golang.org/x/*` | One `golang-x` group | The modules require each other (`x/net` -> `x/text`, `x/crypto` -> `x/sys`), so `go mod tidy` on one moves another. Coherence plus churn reduction. |
| Group name | `go toolchain` | Go's own term; keeps labelprint's branch `renovate/go-toolchain`. |

## go.json

Extend after `:automerge`, before `:docker` (python.json's slot). Rules, in order:

1. **gomod artifacts.** `matchManagers: [gomod]`, `postUpdateOptions:
   [gomodTidy, gomodUpdateImportPaths]`. In a packageRule because
   `postUpdateOptions` is not mergeable: a top-level value would be replaced
   by any consumer setting its own.
2. **Indirect modules.** `matchManagers: [gomod]`, `matchDepTypes: [indirect]`,
   `enabled: true`.
3. **`go` directive.** `matchManagers: [gomod]`, `matchDepTypes: [golang]`,
   `rangeStrategy: bump`. Not the `toolchain` directive: it uses semver
   versioning and already updates under `pin`.
4. **`golang-x` group.** `matchDatasources: [go]`, `/^golang\.org\/x\//`.
5. **`go toolchain` group.** `go` (both directives), `golang`,
   `docker.io/library/golang`, `actions/go-versions` (setup-go's and
   setup-go-faster's `go-version:` input; pre-seeded, labelprint reads
   `go-version-file`). `internalChecksFilter: none`, `semanticCommitType: deps`.
6. **Go minor gate.** Same names, `matchUpdateTypes: [minor]`.
7. **Image soak exemption.** `matchManagers: [dockerfile]`,
   `matchDatasources: [docker]`, the two image spellings, `minimumReleaseAge:
   0 days`. After rule 6, so the image is exempt for minors too.

docker.json: add `!golang`, `!docker.io/library/golang` to `dockerfile bases`.

## Known gaps (documented, not fixed)

- **Stdlib CVEs move only the `toolchain` line.** Renovate maps OSV `stdlib`
  onto `depType: toolchain` only (`process/vulnerabilities.js`), and
  `vulnerabilityAlerts` forces `groupName: security updates`. A repo with a
  `toolchain` line gets a security PR that leaves the image behind, so the
  shipped binary keeps the vulnerable stdlib. labelprint has no `toolchain`
  line, so its image moves on the normal schedule (and Trivy fails main until
  then).
- **Libraries.** Bumping the `go` directive raises every downstream module's
  floor. No fleet repo is a Go library. A library would disable
  `matchDepTypes: [golang]`.
- **One-registry gap**, as python: a run between the Go release and the image
  push opens one half; it joins on a later run. Don't push to the branch.

## Tests

- `test/go-runtime.mjs`: real gomod extractor; effective `rangeStrategy` and
  `go-mod-directive` rewrite; grouping (including look-alikes); soak per member;
  `internalChecksFilter`; three soak timelines through the real
  `filterInternalChecks` + `generateBranchConfig` (the measured labelprint
  re-date, a fresh release, version skew); minor review/patch automerge per
  consumer order; `postUpdateOptions`. Mutation-checked: each preset rule
  removed must fail a check.
- `test/commit-types.mjs`: the app consumer extends `:go`; cases for the
  image, both directives, setup-go, a gomod require, an indirect x/ module.
- CI: run the new test; validate `go.json`.

## Rollout

Merge here first (live on merge). Then labelprint switches to `:go` and drops
its three local rules (prompt handed over 2026-11-06).
