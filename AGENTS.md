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

`.github/workflows/ci.yml` runs only on manual dispatch.
It has read-only repository permissions, uses no secrets, and cancels an
earlier run on the same ref. The jobs live in `.github/workflows/checks.yml`,
a `workflow_call` workflow, so another repository can call the same jobs.

Continuous deployment runs separately on every push to `main`; it does not
wait for the CI workflow.

Blacksmith `blacksmith-4vcpu-ubuntu-2404` runners run four jobs:

- `check` runs `bun run check`: the format check, `oxlint`, the typecheck and
  the e2e boundary check.
- `e2e-local` and `e2e-self-host` run `bun run e2e:prepare`, then `e2e:local`
  and `e2e:self-host` under `xvfb-run`. The self-host run excludes the Claude
  Code MCP scenario, which needs a model API key that CI does not hold.
- `e2e-cloud` runs Cloud onboarding and delivered observability scenarios. It starts the local Cloud
  Worker, a throwaway Postgres container and the service emulators, so it needs
  Docker but no credentials.

The check job also verifies bounded OTLP export, partial rejection, privacy,
seven-day local retrieval, Sentry and usage receivers. Cloud scenarios verify
API/MCP outcomes, workflow correlation, browser failures, app traces and analytics.
These checks remain manually invoked. Deployment gating and automatic CI
enforcement remain deferred as recorded in `notes/deferred.md`.

A failed e2e job uploads its `.local/e2e` evidence directory as an artifact.
Private `actors.json` session files are excluded.

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
