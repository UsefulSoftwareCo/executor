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

## Checks

For application features, fixes, and behavior-preserving refactors, use the
[executor-e2e skill](.agents/skills/executor-e2e/SKILL.md).

For authenticated development testing, use the local-only
[test account command](notes/test-accounts.md). It provisions synthetic users,
organization roles, and short-lived sessions for self-host and cloud dev.
Keep session files private and out of tool output.

Run `bun run format` before committing. `bun run check` runs the format check,
`oxlint`, and the typecheck; CI-style verification should use it. Lint rules
live in `.oxlintrc.jsonc`, formatter settings in `.oxfmtrc.json`.

## CI

`.github/workflows/ci.yml` runs on pull requests and manual dispatch.
Its local checks use no secrets and include the emulated Cloud target. An earlier
PR run on the same ref is cancelled. The jobs live in `.github/workflows/checks.yml`,
a `workflow_call` workflow, so another repository can call the same jobs.

`.github/workflows/cloud-tests.yml` runs deployed tests only after pushes to `main`.
It finishes the active run and coalesces pending pushes. The functional job runs
before the separate MCP memory soak job; manual deployed jobs share the same
non-cancelling concurrency group. Each job owns a disposable Neon staging environment.
The soak job keeps three full-duration probes and preserves their 20-minute deadlines.
The shared-session and distributed-session probes are temporarily skipped while their
unexpected stream endings remain unresolved; the reconnect-burst probe stays enabled.
Functional scenarios retain 60-second deadlines. Both jobs own their teardown and evidence artifacts. These post-merge
checks are not required PR checks. Agents can run targeted deployments through
the same SDK and CLI on demand.

Every push to `main` deploys production directly, without a deployed-test gate.
The deployed suite remains available for manual dispatch with Neon or PlanetScale.

Blacksmith runners run five check jobs. Local and Cloud E2E jobs use
`blacksmith-16vcpu-ubuntu-2404`. Self-host uses a 12-vCPU M4 Mac for its 16 concurrent
product servers and browsers. The load job uses a 6-vCPU M4 Mac for its
single-threaded PGlite workload. Static checks use 4 vCPUs.

- `check` runs `bun run check`: the format check, `oxlint`, the typecheck, the
  no-tests-outside-`e2e/` check and the e2e boundary check.
- `e2e-local` and `e2e-self-host` run `bun run e2e:prepare`, then `e2e:local`
  under `xvfb-run` and `e2e:self-host` headlessly on macOS. The self-host run excludes the Claude
  Code MCP scenario, which needs a model API key that CI does not hold.
- `e2e-self-host-scale` runs the 1,000-account workload on its own runner, in parallel
  with the functional jobs. This preserves its four concurrent writers and
  60-second deadline without competing with 15 independent product servers.
- `e2e-cloud` runs Cloud onboarding and delivered observability scenarios. It starts the local Cloud
  Worker, a throwaway Postgres container and the service emulators, so it needs
  Docker but no credentials.

Cloud scenarios verify
API/MCP outcomes, workflow correlation, browser failures, app traces and analytics.
Deployed tests run through `bun run e2e:deployed`; the runner owns provisioning
and teardown. The release workflow builds and tests Docker images on release PRs
and manual dispatch. Publication requires an explicit channel dispatch from main.

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
