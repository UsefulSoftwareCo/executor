# Working on Executor

Before changing code, read:

1. [Coding style and engineering direction](notes/coding-style.md).
   This is Rhys's guidance for Effect, typed contracts, package layout, public
   SDK imports, sharing between products, UI, testing and collaboration.
2. [Project orientation](notes/project-orientation.md).
   This explains the goal, accepted model, product boundaries and current state.
3. [Deferred work](notes/deferred.md) when choosing what to build next.
   Parked ideas and historical experiments are not implementation instructions.

Apply that guidance across the whole change, including contracts and consumers.
New instructions from Rhys take precedence. Update these notes when a decision
changes instead of leaving conflicting instructions.

The key boundaries are Effect v4 inside the framework, Promise APIs for app
authors, and product-owned authorization. Share capabilities and typed views
without forcing hosted organizations into local. Use public SDK surfaces and
the existing shared UI. See the coding note for details and the pinned Effect
reference.

## Migrations must keep the app online

Cloud migrations run before the replacement server deploys. Every migration
must leave the currently deployed server able to serve requests. A later deploy
failure does not undo committed SQL; the old server must still work afterward.

Add schema first, deploy code that uses it, then remove obsolete fields in a
later release after no running code needs them. Never drop or rename a required
column before deploying its replacement. Do not install a maintenance Worker,
change production routes, or stop traffic to make a migration work. If an online
path is not available, stop and explain the blocker before changing production.

Only our own installs currently need upgrades. Use the supported current baseline
and preserve their data; do not keep obsolete upgrade paths for hypothetical
installs. Never reset data or relabel a schema version to bypass an upgrade.
Record completed steps, keep them immutable, and make repeat runs safe. Do not
replay backfills or rebuild constraints and triggers on every deploy. Bound lock
waits and review write blocking, including index builds.

Verify fresh setup, retained data, repeat runs, rollback/retry, and compatibility
with the running server before release. Use the real database adapter for each
affected product. See [storage migrations](notes/storage.md#current-baseline-and-migrations).

## Tests are E2E only

The only tests in this repository live in `e2e/`. Every test is an E2E scenario
that drives a real server through HTTP, MCP, the CLI or the browser. Unit tests
are banned: do not add `*.test.*`, `*.spec.*`, type tests, `test/` or
`__tests__/` directories anywhere else, including packages, scripts and helpers,
and do not import application implementations into tests. `bun run check` fails
on any test outside `e2e/`.

There are two exceptions. The first is the Go host in
`apps/hosted/self-host/native`. Its `go test` suite covers timing races between
the host's proxy and workerd, and response compression cases such as streamed
chunks, that a real image cannot hit reliably. CI runs it in the `self-host-native` job.

The second is the telemetry collector crate in `packages/telemetry/collector`.
Its `cargo test` suite in `tests/` is limited to four files:

- `otlp_mapping.rs`: the OTLP/JSON field mapping, through the crate's library.
- `store.rs`: the store's handling of resent and changed spans, trace summaries
  and resource references, that an export is all or nothing, and which files it
  refuses, through the crate's library. A failure part way through a transaction
  cannot be caused from outside the process.
- `lifecycle.rs`: that the shutdown drain ends however the stop and the drain
  are ordered, through the crate's library. The order cannot be forced from
  outside the process.
- `process.rs`: the built binary as a process, over HTTP and its socket. It
  covers stop signals and the shutdown deadline, a socket path that already
  exists, not acknowledging an export it did not store, gzip bodies, a first
  start cut off while creating the store, and resident memory returned after a
  burst. These would be E2E scenarios, but nothing in `e2e/` builds the binary
  yet.

CI runs it in the `collector-native` job when the crate changes.

Tests are not sacred. Delete a scenario when it no longer proves behavior a user
or public API caller depends on, or when other scenarios already cover it. Say
what it covered and why that coverage is not needed. Deletion is not a fix for
a flaky scenario that still guards real behavior: find the race in the product
or the scenario instead.

## Checks

For application features, fixes, and behavior-preserving refactors, use the
[executor-e2e skill](.agents/skills/executor-e2e/SKILL.md).

Run only named scenarios that exercise the code you changed. Never run a full
suite (`e2e:self-host`, `e2e:local`, `e2e:cloud` or `e2e:deployed` without
`--test-name`); the PR's CI runs the full local suites, and post-merge Cloud
tests run the deployed suite. When a change is cross-cutting, pick one or two
scenarios per changed path and name them in the handoff. Investigate a failure
CI reports instead of re-running suites to look for one.

For authenticated testing and bug reproduction, use
[test accounts](notes/test-accounts.md). The fixture command provisions
synthetic users, organization roles and short-lived sessions for self-host,
cloud dev and running test stages. On production, agents sign in through real
email codes to `@agents.executor.engineering` inboxes. Keep session files
private and out of tool output.

Run `bun run format` before committing. `bun run check` runs the format check,
`oxlint`, and the typecheck; CI-style verification should use it.

`packages/apps/protocols/*.json` are generated records of the app host
protocols. Never read, grep or edit them; run `bun run apps:protocols` and read
its output, and `--write` to record a boundary change. See
[host protocols](notes/apps-publishing.md#host-protocols). Lint rules
live in `.oxlintrc.jsonc`, formatter settings in `.oxfmtrc.json`.

`bun run check` first runs `patches:check` (`scripts/check-patches.ts`): every
`patchedDependencies` selector must name an installed version, and every
installed copy must hold the whole patch: `git apply --reverse --check` at the
exact lines, the file modes the patch names, and no forward apply. Bun skips a stale selector and still exits 0,
so move a patch with its dependency's version, or remove both. Git is stricter
than Bun: after `bun patch --commit`, drop `.bun-tag-*` sections and sections
whose `b/` path is outside the package, and keep `\ No newline at end of file`
markers. Its fixtures are in `scripts/check-patches-fixtures.ts`.

Pin every dependency to one exact version; `versions:check`
(`scripts/check-exact-versions.ts`) fails on anything else, including in
`overrides`, `resolutions` and `patchedDependencies` selectors. The only ranges
are the peers `apps` publishes, listed in that script, and they must be plain
npm comparator ranges such as `^16.11.0`. Its fixtures are in
`scripts/check-exact-versions-fixtures.ts`. `bunfig.toml` makes `bun install`
and `bun add` skip versions published less than a day ago.

`bun install --frozen-lockfile` accepts a lock that records an old version of a
workspace package, so after changing any `package.json`, including a version
bump, run `bun install` and commit bun.lock. The `apps-version` job runs
`scripts/check-lockfile.ts --base` on pull requests, against where the pull
request meets `main` (the merge base for an upper stack layer), and fails one
whose own changes leave bun.lock different from what `bun install` writes; a
lock already stale on `main` fails no pull request. On `main`, the Beta workflow refreshes a
stale lock with `scripts/releases/lock-repair.sh` and pushes it as
`Refresh bun.lock [skip ci]`, but only when every changed line is a workspace
package's own `version` set to what its `package.json` says
(`scripts/releases/lock-repair-scope.ts`). It pushes no other change, such as a
dependency resolved differently: it warns in the Beta run's summary and keeps an
issue labelled `lock-repair-refused` open instead, and that change needs a pull
request. `bun run lockfile:check` checks a checkout by
hand.

The typecheck runs `tsc-rs`, a Rust port of the TypeScript 7 compiler that is
about twice as fast as Go's `tsc` here and has the Effect language service
diagnostics built in. It reports the Effect diagnostics configured in
`tsconfig.json`; it warns that `unstableApiUsage` and `experimentalApiUsage` are
unknown rules because its Effect rules predate them. Effect errors fail the
typecheck; warnings mark rules with too many existing sites to fix at once.
`bun run typecheck` prints errors in full and counts the warnings: the last lines
give each rule's count and the files with the most. `--all-warnings` or
`TYPECHECK_WARNINGS=all` (which also works through `bun run check`) prints each
warning.
Editors still use TypeScript 7 (`tsc` is the native Go compiler), which
`bun install` patches with `@effect/tsgo` in `prepare` for the same diagnostics.
TypeScript 7 has no JavaScript compiler API. The `packages/apps` build scripts
and `e2e/check-boundary.ts` import TypeScript 5.9 as `typescript-5` for it;
do not use that package to typecheck.

## CI

`.github/workflows/ci.yml` runs on pull requests, pushes to `main` and manual
dispatch. Its local checks use no secrets and include the emulated Cloud target.
A PR run on an earlier head is cancelled by the new head's run; two runs on the
same head both run, one after the other. Each push to `main` has its own
concurrency group, so every push finishes a run and gives each merge a baseline,
even when merges come in a burst. A stack that lands in one push gets one run, at
its top commit. Overlapping `main` runs share no deployed stage, database or
secret. They do read the npm registry and create hosted emulators.dev instances,
each named with a random UUID, so they do not interfere. The jobs live in `.github/workflows/checks.yml`,
a `workflow_call` workflow, so another repository can call the same jobs.

### Choosing a PR's E2E scenarios

A pull request runs only the E2E scenarios it selects. Pushes to `main` run the
full suite. The static checks (`check` and the jobs it gates, `apps-version`,
`self-host-native`) always run, except in a skipped stack layer. Put exactly one
fenced `e2e` block in the PR description, listing spec files from `e2e/tests/`:

````md
```e2e
groups.spec.ts
invitation-roles.spec.ts
```
````

Spec files the PR adds or changes are always included, as are the scenarios that
guard a dependency patch when the PR's tree pins that dependency or its patch
differently from main (`patchGuards` in `e2e/ci-selection.ts`): Bun skips a stale
patch without an error. So are the scenarios that assert a contract one file states in
full when the tree's copy differs from main's (`fileGuards`): a new host protocol in
`app-protocols.ts` runs `app-package.spec.ts`, which reads back the supported list.
A changed spec file's Cloud scenarios that otherwise first run in Cloud tests on main, after
merge, run in the `cloud-product` job when managed local Cloud can run them. The ones that need a
deployed stage (`runtime: "attached"`) get a warning with the `e2e:deployed` command that runs
them; run it before merging. A scenario new to the deployed suite (one main's `e2e/test-plan.ts`
does not name) first runs on a deployed stage after merge even when managed local Cloud runs it
here, so the `select` job fails until the description has a line `Verified on a deployed stage:`
saying what ran and its result, for example the `bun run e2e:deployed --database planetscale
--test-name '…'` command the failure prints. Write `none` for a change no scenario exercises, such as documentation. Write each name as it appears in
`e2e/tests/`, optionally prefixed with `e2e/tests/`. The `select` job fails when the
description has no block, a name is not a spec file there, or a named file is one these
jobs never run: the release, desktop, billing and PGlite suites have their own
`e2e/*.config.ts`, and the failure names the workflow or command that runs each one.
A new spec file must have its scenarios in `e2e/test-plan.ts` or be included by such a config.
Every scenario the plan schedules on a target must run in CI: in one of these jobs, or, for a
Cloud scenario without `runtime: "managed"` or `"rate-limited"`, in Cloud tests on main. The
`select` job fails on a scenario nothing runs, because it goes stale unnoticed. Add it to a job
pattern, mark the target `not-run` with its reason, or add it to `notRunInCi` in
`e2e/ci-selection.ts` with why CI cannot run it. That check reads only the job table. After a
full run, on pushes to main and manual runs, `e2e-coverage` in CI and `deployed-coverage` in
Cloud tests on main check from the jobs' saved reports that each of those scenarios executed,
passed or failed, so a job or step the workflow skipped fails there. `e2e-coverage` also fails a
push to main that did not start Cloud tests on main.

Select specific files by default. A selection finishes in about five minutes; the full
suite takes about eight and holds the runners other PRs wait for. Reserve `all` for
changes that every scenario runs through: the e2e harness (`e2e/sdk`, `e2e/support`,
`e2e/setup.ts`), the toolchain, the lockfile or the workflows. Write the reason after
it, such as `all: changes the lockfile`; `all` without a reason fails the `select` job.
A lockfile change that only updates a workspace package's own `version`, as `bun install`
writes after a version bump, installs nothing different: write `none` for it.
A change to shared code such as the runtime, storage, auth or the MCP server is not
by itself a reason: list the spec files for the features whose behavior it changes. [`e2e/ci-selection.ts`](e2e/ci-selection.ts) turns the block
into each job's scenario list; the run summary shows it.

In a stack, write `skip` in each lower layer's block, such as a code PR under its
tests PR. Every job in that run skips, the static checks included. The top layer
checks the combined change: its static checks run against the whole tree,
`apps-version` compares it with `main`, and its `e2e` block must select the
scenarios for every layer's changes. `skip` fails the `select` job unless another
open PR targets the layer's branch, so a lone PR or the top layer cannot skip. The
`select` job waits up to 3 minutes for that PR to open, so open the stack's layers together
(`gh stack submit` does).
After changing a lower layer, rebase the layers above it so the top runs again.
Merge the stack only when the top layer passes, bottom first, without pausing between
layers: each merge deploys production.

Choose from the actual callers of the changed code. Search `e2e/tests/` for the
routes, tools and UI the change touches, and include every file that exercises them
on any target. A tests PR on top of a stack gets its own new or changed spec files
for free; add the existing files that cover the code layers below it. `main` runs the
full suite after merge, so a missed scenario is still caught there. The `select`
job reads the live description when it runs. If it has no `e2e` block yet, the job
waits up to 3 minutes for one, so write the block right after opening the PR. After
changing the block once CI has read it, push (an empty commit will do) or rerun the whole
workflow (`gh run rerun <run-id>`), not only failed jobs. Rerunning the whole workflow deletes
the evidence of every earlier attempt, so push instead when an attempt failed.

### Adding to a Cloud Worker's upload

Cloudflare compiles and evaluates the modules a Worker's entry imports statically
when an isolate starts, about 40 ms for each megabyte on every cold request, and
refuses an upload whose startup takes more than a second of CPU. The `site` job
compares each Cloud Worker's upload, and the bytes its entry imports statically,
with `main`, and fails a pull request that adds more than 50 KB to either, about
2 ms, unless the description allows it:

````md
```worker-growth
api +120,000: the SAML sign-in library, which every enterprise sign-in loads
```
````

Each line names a Worker, the most bytes the PR may add to it, and why that is
worth the cold-start time. First try to make room: the job summary names the
packages and files that grew and lists the ways. In a stack, the top layer's
description allows for every layer. The job reads the live description, so rerun
it after an edit. The budgets in
[`worker-build.ts`](apps/hosted/cloud/src/infrastructure/worker-build.ts) are
backstops with room above each Worker's size; the deploy enforces them too.
Change one only in a PR that does nothing else and says what the added
cold-start time buys. Never raise one to fit a change.

A ruleset on `main` requires a pull request whose `checks / check` and
`checks / e2e` passed. When GitHub refuses a merge as blocked ("the base branch
policy prohibits the merge"), a required check is pending, failed or missing: wait
for a pending run with `ci-wait`, fix or report a failed one, and push or rerun a
cancelled one. Never bypass it: no `gh pr merge --admin`, no merge through the
REST or GraphQL API to get around a refusal, and no change to the ruleset. Only
Rhys turns it off, in an emergency. See [CI configuration](notes/ci.md#the-main-ruleset).

A failure on `main` is a regression or a flake that a PR selection missed. Fixing
it takes priority over new work that touches the same area.

A PR run takes at most about seven minutes. Wait for it once; do not poll post-merge
suites before handing off. When a job fails in a scenario the change does not
touch:

- Compare with the latest `main` run: `gh run list -w CI -b main -L 3`.
- If `main` fails the same scenario, it is not yours. Name it in the handoff.
- Otherwise read the failure evidence before rerunning. Rerun a failed job at
  most once, with `gh run rerun <run-id> --failed`. Each attempt keeps its own evidence
  artifact, named with its attempt number (`e2e-cloud-evidence-0-attempt-1`). Rerunning
  all jobs deletes every earlier attempt's artifacts. A scenario that fails again, or fails on unrelated PRs, is a flake.
  Record the scenario, the run link and the error in the handoff and finish the
  task; fixing it is separate work that Rhys schedules.

A flake is a bug in the product or the scenario, not noise. Never add retries,
longer deadlines or skips to make a run pass.

`.github/workflows/cloud-tests.yml` runs deployed tests only after pushes to `main`.
It finishes the active run and coalesces pending pushes, so one run can test several
merges. Its `coverage` job lists them in the run summary and adds a notice when a
run tests more than one commit. It counts from the nearest earlier ancestor whose run
uploaded `deployed-planetscale-results` (`deployed-neon-results` before November 13, 2026), which exists only when the scenarios ran, so a
setup failure or a rerun of an older commit cannot hide a gap. Manual deployed jobs share
the same non-cancelling concurrency group. Each main run owns a disposable PlanetScale staging environment whose Workers reach
the branch through their own Hyperdrive configuration, as production does. Manual
`deployed-tests.yml` dispatches still default to Neon, and pull request previews stay on Neon.
Scenarios retain 60-second deadlines. The job owns its teardown and evidence artifacts. These post-merge
checks are not required PR checks. Agents can run targeted deployments through
the same SDK and CLI on demand.

Every push to `main` deploys production directly, without a deployed-test gate. Deploy skips its deploy job for
a push that changes only paths no deploy reads (tests, notes, other workflows; see
`notes/ci.md`, "Deploy decision"): the run's `decide` job summary gives the decision and its
reason. A skipped merge has nothing new live to verify. A manual dispatch or "Re-run all
jobs" always deploys; "Re-run failed jobs" keeps `decide`'s earlier answer.
The deployed suite remains available for manual dispatch with Neon or PlanetScale.

Blacksmith Linux runners run every check job. Local and self-host E2E jobs use
`blacksmith-16vcpu-ubuntu-2404`. Cloud E2E jobs use `blacksmith-8vcpu-ubuntu-2404`: each runs
one local Cloud at a time, which kept 16 vCPUs only 8-28% busy. The `cloud` job keeps 16 vCPUs
with four workers: on 8 its browser scenarios saturated the cores and neared their 60 s limit. The load job also uses 16 vCPUs: on 4 vCPUs the
product server, PGlite and the test driver contend. Its inventory case has a 120-second
test limit because its body takes 40-48s on CI. Static checks use 4 vCPUs.

Do not run CI checks on macOS runners. They cost 5-20x as much per minute as Linux
runners and were most of the CI bill, and no check needs macOS. Fix slow or flaky
scenarios on Linux instead of moving them to a Mac.

- `check` passes when `select` and each static check job passed. The static checks run as
  parallel jobs, so a pull request waits for the slowest, about a minute and a half, not their
  sum. `static` runs `bun run check`: the format check, `oxlint`, the typecheck, the
  no-tests-outside-`e2e/` check and the e2e boundary check.
  `site` builds the public site and runs `bun run site:links`, which fails when
  any marketing or docs page links to a path that would 404. Then
  `bun run hosted:cloud:worker-sizes` builds each Cloud Worker as the deploy does,
  for production and for the pull request's preview, and fails when one exceeds
  its upload budget or a pull request adds more than 50 KB to one without an
  allowance (see "Adding to a Cloud Worker's upload"); the job summary shows each
  Worker's size, its change from `main` and the packages and files that grew. `apps-package` checks the apps npm
  tarball, and `tooling` checks the dependency patches and the scripts that run CI,
  releases, the public export and deploys. `tooling-cloud` runs the checks that start a
  browser or a database or read recorded Cloud APIs: test stages, the patched Playwright,
  emulator and request failures, PostHog and the deployed origin. Put a new static check
  in the job it fits, keeping each under the E2E jobs' usual time, or in a new job that
  `check` needs.
- `select` runs [`e2e/ci-selection.ts`](e2e/ci-selection.ts) and gives each e2e job
  its `--test-name` pattern, or skips the job when none of its scenarios is selected.
  Its job patterns hold the exclusions and splits below.
- `e2e-local` and `e2e-self-host` run `bun run e2e:prepare`, then `e2e:local`
  and `e2e:self-host` under `xvfb-run`. The self-host run excludes the Claude
  Code MCP scenario, which needs a model API key that CI does not hold. A full run
  splits them by spec file over runners (three for local, 12 for self-host; `shards` in
  `e2e/ci-selection.ts`). Local parts run the usual eight workers; self-host parts run four,
  since eight kept every core busy and slowed scenarios to 1.7 times their time alone (2.6 at
  p95). Each part finishes in about four to five minutes. A selection runs on one runner with
  eight workers. The local parts are mostly idle and wait on their longest spec file, so keep
  local spec files short enough to split.
- `e2e-self-host-scale` runs the 300-account workload and then the 7,000-tool MCP
  catalog scenario and the slow and stalled tool listing scenarios on its own runner,
  in parallel with the functional jobs. This preserves the four concurrent writers,
  the catalog and listing latency bounds and the inventory case's 120-second limit without
  competing with the functional job's product servers.
- `e2e-cloud` runs Cloud onboarding, the v1 sign-in check, delivered observability, MCP tool-call privacy, client rejection and app evaluation
  incident reporting, bearer refusal, billing polling, MCP session object database connection,
  API-key storage outage, supervisor-kept tool listing, Cloud SSO SAML, Safari error provenance, remote skill
  cache, team installation and app Worker build load scenarios: every scenario that needs managed local
  Cloud, except those `notRunInCi` lists as failing there. The refusal scenario writes stored rows into the runner-owned
  Postgres. It starts the local Cloud Worker, a throwaway Postgres container and the service
  emulators, so it needs Docker but no credentials. Scenarios that hold row locks to pause the
  server's own statements get a second local Cloud, so their locks cannot stall other scenarios.
  The MCP session timing scenario also gets its own: it counts every request in the isolate that
  runs all session objects, and another scenario's request would change that count.
  Every scenario's request comes from one address, so these local Clouds turn Better Auth's
  per-address limit off, as deployed test stages do; the scenario that proves the limit gets
  its own local Cloud with it on (`e2e:cloud --auth-rate-limit`).
  Each of these local Clouds is a Cloud job in `e2e/ci-selection.ts`, and its `runner`
  there puts it on one of the `e2e-cloud` runners, which run at once; a runner's local Clouds
  run one after another. Two local Clouds cannot run at once in one checkout: each rebuilds the
  site and dashboard, with its own origins, into the one `apps/hosted/cloud/.generated/site`
  that both serve. On a full run `cloud-product` passes what one local Cloud holds, and each of
  its local Clouds has a runner of its own; the longest, about five and a half minutes, waits out
  the MCP session restore scenario's 270-second idle. Each runner builds the apps package and
  Motel once before its runs; runs only serve that Motel bundle, because every target in a run
  shares it.
- `e2e` passes when `select` succeeded, every E2E job it chose passed and every other one was
  skipped; it runs even after a cancellation, which fails it. The matrix runners' check
  names change with the selection, so this is the one E2E check to require.

Cloud scenarios verify
API/MCP outcomes, workflow correlation, browser failures, app traces and analytics.
Deployed tests run through `bun run e2e:deployed`; the runner owns provisioning
and teardown. The release workflow builds and tests Docker images after merge and on
manual dispatch. Publication requires an explicit channel dispatch from main.
The Beta workflow (`beta.yml`) makes that dispatch, on each push to main and on a
backstop schedule GitHub delivers hours late, when main has commits the last beta
lacks and npm published that beta at least six hours ago, and retries a failed one
with a bounded back-off; see [Releasing](RELEASING.md#publish-beta).
Pull requests do not run "Executor releases". CI runs two short release lanes
instead, chosen like the E2E jobs from the pull request's changes since its merge
base with `main` (`e2e/release-lanes.ts`): `release-docker` builds the self-host
image on amd64 and runs the released-image scenarios when the image's source (the
workspace packages it is built from), its build inputs or a file that suite imports
changed, and `release-local` packages linux-x64 and runs its install, launcher,
lockdown, credential store and desktop startup checks when the CLI's or the desktop
app's source, their build inputs or a packaging script changed. The required `checks / e2e` check covers both, so wait
for CI only (`ci-wait --pr N --workflow CI`); a lower stack layer runs neither.

After merge, the "Release check" workflow decides on every push to `main`, and
hourly as a backstop, whether main, with every commit since the last check,
changed what a release lane builds or runs. The paths are computed from the
checkout (`e2e/release-check.ts`), so nothing is kept by hand. When they changed,
it starts "Executor releases" with a repository dispatch, a paced check that
builds at most once every two hours:
Linux x64 packaging with desktop crash recovery, its installed CLI suite and the
image on both architectures. Linux
arm64, Windows and macOS run in each beta's publishing run, which tests every
platform before it publishes, and in manual build runs. A failed run opens or
updates one issue labelled `release-matrix-red`, which the next green run closes,
and holds every beta until a later run passes. Fix a failure; do not
re-run it to make it green. To check a release change before merge, dispatch the
workflow on the branch with channel `build`. macOS runners cost 5-20x as much as
Linux runners, so keep them off pull requests.

A failed e2e job uploads raw reports and server logs. Product database files,
runtime dependencies and private `actors.json` sessions are excluded.
Reports use Vitest's final result, including setup and cleanup failures.
Evidence rendering runs only on request.

`.github/actions/setup` pins Bun and Node and installs the workspace with
`bun install --frozen-lockfile`. Change toolchain versions there only.
`.github/actions/e2e-tools` installs Playwright Chromium, ffmpeg and Xvfb.
Validate workflow edits with `actionlint`.

## Workspace lifecycle

The canonical checkout and shared preview live at
`~/agent-workspace/executor-next`, on `main`. Keep it clean and synchronized with
`origin/main`. The old `sdk-scaffold` rift is not the shared preview or a second
source of truth. Its active task branches must be finished through normal PRs.

Before work, run `bun run workspace:check` in the canonical checkout. The check
fetches origin and reports the branch, dirty files, and divergence. It never
stashes, resets, switches branches, or changes worktree files. Resolve any
reported work before starting another task; never discard it to pass the check.

Each implementation task or agent gets its own short-lived rift and named
branch, created from current main. Run `bun run workspace:check --task` there
before editing. Use that rift for the whole task; do not mix another agent's
edits into it. Give task previews separate ports and scratch data.

Commit coherent pieces of authorized task work before starting a different task.
Unfinished work stays on a named branch with an explicit owner and status.
A task handoff must name its checkout, branch, commit or PR, checks, and remaining
uncommitted files. Do not leave work only in a dirty shared preview.

A merge is complete only after verifying the remote result and fast-forwarding
the clean canonical checkout to it. Run `bun run workspace:check` again. If the
preview has local edits, preserve and identify them; report the sync as blocked
instead of resetting or calling the preview current. Keep active task rifts
unchanged until their owners reconcile with the merged main.

Develop locally and keep secrets in 1Password. Publishing, merging, deployment,
and deferred features still require the user's authorization. This workflow
permits local commits for an authorized implementation task; it does not grant
blanket merge or deployment permission.
