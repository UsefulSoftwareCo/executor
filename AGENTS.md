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

The one exception is the Go host in `apps/hosted/self-host/native`. Its
`go test` suite covers timing races between the host's proxy and workerd that a
real image cannot hit reliably, and CI runs it in the `self-host-native` job.

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
exact lines, and no forward apply. Bun skips a stale selector and still exits 0,
so move a patch with its dependency's version, or remove both. Git is stricter
than Bun: after `bun patch --commit`, drop `.bun-tag-*` sections and sections
whose `b/` path is outside the package, and keep `\ No newline at end of file`
markers. Its fixtures are in `scripts/check-patches-fixtures.ts`.

The typecheck runs `tsc-rs`, a Rust port of the TypeScript 7 compiler that is
about twice as fast as Go's `tsc` here and has the Effect language service
diagnostics built in. It reports the Effect diagnostics configured in
`tsconfig.json`; it warns that `unstableApiUsage` and `experimentalApiUsage` are
unknown rules because its Effect rules predate them. Effect errors fail the
typecheck; warnings mark rules with too many existing sites to fix at once.
Editors still use TypeScript 7 (`tsc` is the native Go compiler), which
`bun install` patches with `@effect/tsgo` in `prepare` for the same diagnostics.
TypeScript 7 has no JavaScript compiler API. The `packages/apps` build scripts
and `e2e/check-boundary.ts` import TypeScript 5.9 as `typescript-5` for it;
do not use that package to typecheck.

## CI

`.github/workflows/ci.yml` runs on pull requests, pushes to `main` and manual
dispatch. Its local checks use no secrets and include the emulated Cloud target.
An earlier PR run on the same ref is cancelled. Each push to `main` has its own
concurrency group, so every push finishes a run and gives each merge a baseline,
even when merges come in a burst. A stack that lands in one push gets one run, at
its top commit. Overlapping `main` runs share no deployed stage, database or
secret. They do read the npm registry and create hosted emulators.dev instances,
each named with a random UUID, so they do not interfere. The jobs live in `.github/workflows/checks.yml`,
a `workflow_call` workflow, so another repository can call the same jobs.

### Choosing a PR's E2E scenarios

A pull request runs only the E2E scenarios it selects. Pushes to `main` run the
full suite. The static checks (`check`, `apps-version`, `self-host-native`) always
run, except in a skipped stack layer. Put exactly one fenced `e2e` block in the PR
description, listing spec files from `e2e/tests/`:

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
them; run it before merging. Write `none` for a change no scenario exercises, such as documentation. Write each name as it appears in
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
suite takes about fifteen and holds the runners other PRs wait for. Reserve `all` for
changes that every scenario runs through: the e2e harness (`e2e/sdk`, `e2e/support`,
`e2e/setup.ts`), the toolchain, the lockfile or the workflows. Write the reason after
it, such as `all: changes the lockfile`; `all` without a reason fails the `select` job.
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
changing the block once CI has read it, push or rerun the whole workflow
(`gh run rerun <run-id>`), not only failed jobs.

A failure on `main` is a regression or a flake that a PR selection missed. Fixing
it takes priority over new work that touches the same area.

A PR run takes at most about seven minutes. Wait for it once; do not poll post-merge
suites before handing off. When a job fails in a scenario the change does not
touch:

- Compare with the latest `main` run: `gh run list -w CI -b main -L 3`.
- If `main` fails the same scenario, it is not yours. Name it in the handoff.
- Otherwise read the failure evidence before rerunning. Rerun a failed job at
  most once. A scenario that fails again, or fails on unrelated PRs, is a flake.
  Record the scenario, the run link and the error in the handoff and finish the
  task; fixing it is separate work that Rhys schedules.

A flake is a bug in the product or the scenario, not noise. Never add retries,
longer deadlines or skips to make a run pass.

`.github/workflows/cloud-tests.yml` runs deployed tests only after pushes to `main`.
It finishes the active run and coalesces pending pushes, so one run can test several
merges. Its `coverage` job lists them in the run summary and adds a notice when a
run tests more than one commit. It counts from the nearest earlier ancestor whose run
uploaded `deployed-neon-results`, which exists only when the scenarios ran, so a
setup failure or a rerun of an older commit cannot hide a gap. Manual deployed jobs share
the same non-cancelling concurrency group. Each job owns a disposable Neon staging environment.
Scenarios retain 60-second deadlines. The job owns its teardown and evidence artifacts. These post-merge
checks are not required PR checks. Agents can run targeted deployments through
the same SDK and CLI on demand.

Every push to `main` deploys production directly, without a deployed-test gate.
The deployed suite remains available for manual dispatch with Neon or PlanetScale.

Blacksmith Linux runners run every check job. Local, self-host and Cloud E2E jobs use
`blacksmith-16vcpu-ubuntu-2404`. The load job also uses 16 vCPUs: on 4 vCPUs the
product server, PGlite and the test driver contend. Its inventory case has a 120-second
test limit because its body takes 40-48s on CI. Static checks use 4 vCPUs.

Do not run CI checks on macOS runners. They cost 5-20x as much per minute as Linux
runners and were most of the CI bill, and no check needs macOS. Fix slow or flaky
scenarios on Linux instead of moving them to a Mac.

- `check` runs `bun run check`: the format check, `oxlint`, the typecheck, the
  no-tests-outside-`e2e/` check and the e2e boundary check.
  It also builds the public site and runs `bun run site:links`, which fails when
  any marketing or docs page links to a path that would 404. Then
  `bun run hosted:cloud:worker-sizes` builds each Cloud Worker as the deploy does,
  for production and for the pull request's preview, and fails when one exceeds
  its upload budget; the job summary shows each Worker's size, its change from
  `main` and the packages and files that grew.
- `select` runs [`e2e/ci-selection.ts`](e2e/ci-selection.ts) and gives each e2e job
  its `--test-name` pattern, or skips the job when none of its scenarios is selected.
  Its job patterns hold the exclusions and splits below.
- `e2e-local` and `e2e-self-host` run `bun run e2e:prepare`, then `e2e:local`
  and `e2e:self-host` under `xvfb-run`. The self-host run excludes the Claude
  Code MCP scenario, which needs a model API key that CI does not hold. A full run
  splits them by spec file over runners (two for local, three for self-host; `shards` in
  `e2e/ci-selection.ts`), each with the usual number of workers, so each part finishes in
  about four minutes instead of six and ten. A selection runs on one runner.
- `e2e-self-host-scale` runs the 1,000-account workload and then the 7,000-tool MCP
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
  there puts it on one of three `e2e-cloud` runners that run at once, about four minutes each
  on a full run. Each runner builds the apps package and Motel once before its runs; runs only
  serve that Motel bundle, because every target in a run shares it.
- `e2e` passes when `select` succeeded, every E2E job it chose passed and every other one was
  skipped; it runs even after a cancellation, which fails it. The matrix runners' check
  names change with the selection, so this is the one E2E check to require.

Cloud scenarios verify
API/MCP outcomes, workflow correlation, browser failures, app traces and analytics.
Deployed tests run through `bun run e2e:deployed`; the runner owns provisioning
and teardown. The release workflow builds and tests Docker images on release PRs
and manual dispatch. Publication requires an explicit channel dispatch from main.
Release PRs build and test the Linux and Windows targets only. The macOS targets run
on manual dispatch, where they are built, signed, notarized and tested. macOS runners
cost 5-20x as much as Linux runners, so keep them off pull requests.

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
