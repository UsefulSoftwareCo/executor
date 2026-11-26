# Working on Executor

Read [coding style](notes/coding-style.md) before changing code, and [test accounts](apps/hosted/testing/cli.ts) for authenticated local/stage/production testing.

## Boundaries & architecture

- **Effect v4 internally, ordinary values and Promises at public SDK / `apps` author boundaries.** Derive author callback types from native contracts; compose Effects directly inside the library.
- **Product-owned authorization.** Core SDK ownership is a lookup primitive, not permission enforcement. Share capabilities and UI views without forcing hosted organizations into local or adding `isCloud` flags.
- **Migrations must keep the app online.** Cloud migrations run before the replacement server deploys; a failed deploy does not roll back SQL. Add schema first, deploy code that uses it, drop obsolete fields in a later release. Never drop/rename a required column before replacement deploys, never add a maintenance Worker, never reset data or relabel a schema version. Verify fresh setup, retained data, repeat runs, and rollback on real adapters ([storage](notes/storage.md)).

## Tests are E2E only

- All tests live in `e2e/` and drive a real server through HTTP, MCP, CLI, or browser. Unit tests are banned everywhere else (`scripts/check-no-unit-tests.ts`).
- Two exceptions only: Go host `go test` in `apps/hosted/self-host/native` and the 7 Rust collector `cargo test` files in `packages/telemetry/collector/tests/`.
- Locally, run only named scenarios for code you changed (`--test-name '<title>'`). Never run a full suite locally; CI runs full suites.
- Snapshots (`toMatchInlineSnapshot`) are assertions — update only intentionally with `--update-snapshots --test-name '<title>'`.
- Never add retries, longer deadlines, or skips to paper over flakes; fix the race. Delete scenarios that no longer guard real user/API behavior.

## Public `v2` export mirror

- Public `UsefulSoftwareCo/executor` branch `v2` is overwritten from `executor-next` `main` on export. Never merge, push to, or open PRs directly against `v2`.
- To land an external contributor's `v2` PR so GitHub marks it merged: port it into a draft `executor-next` PR with a commit body line `Public-PR: UsefulSoftwareCo/executor#<number> <full head sha>`. Keep the SHA current if the contributor pushes updates.

## PRs, releases & workflow

- **Workspace:** keep `~/agent-workspace/executor-next` clean on `main`. Do all work in a rift workspace on a named branch; run `bun run workspace:check` before starting and `--task` in the rift.
- **Before pushing:** run `bun run format` and `bun run pr:check` (`--description <file>` before opening the PR).
- **Every PR description** requires one fenced ` ```e2e ` block listing `e2e/tests/*.spec.ts` files for callers of changed code, `none` (docs/notes/skills only), `all: <reason>` (harness/toolchain/lockfile/workflows only), or `skip` (lower stack layers only). Ready PRs touching files outside `e2e/narrowing.ts` run the full suite.
- **Stacks:** land stacks only via `gh stack merge <top PR> --yes --squash` after checking all layers are in one stack on `main`. Never bypass the `main` ruleset (`--admin`, API bypass). Never run CI checks on macOS runners.
- **Release notes:** for changes users of Cloud, the CLI, desktop, or self-host would notice, add `Release-note: Feature|Improvement|Fix: <plain sentence>` in a commit message body (PR titles are never published; see [RELEASING.md](RELEASING.md#release-notes)). A note goes to every product its change reaches; `bun run pr:check` prints who and the note's hash, and an entry with that hash in `scripts/releases/note-audiences.ts` changes it.
- **Generated / patched files:** never edit `node_modules` directly (use `bun patch <pkg>`). Never read/edit `packages/apps/protocols/*.json` directly (run `bun run apps:protocols` / `--write`; see [apps publishing](notes/apps-publishing.md#host-protocols)). After editing any `package.json`, run `bun install` and commit `bun.lock`.
- **Cloud Worker size:** `+50 KB` upload or static-import growth fails `site` unless justified in a fenced ` ```worker-growth ` block (`<worker> +<bytes>: <why>`). Never raise budgets in `worker-build.ts` to fit a change.
- **CI triage:** compare unrelated failures against `gh run list -w CI -b main -L 3`. Rerun failed jobs at most once with `gh run rerun <run-id> --failed` (never rerun all jobs after a failure — it deletes attempt evidence). Wait with `ci-wait`, never sleep loops.

## Enforcement map

| Rule                                                                     | Enforcer                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Format, lint, `executor/*` Oxlint rules                                  | `bun run check` (`.oxlintrc.jsonc`, `scripts/oxlint-plugin.ts`) |
| Types & Effect diagnostics                                               | `bun run typecheck` (`tsc-rs`)                                  |
| No unit tests outside `e2e/`                                             | `scripts/check-no-unit-tests.ts`                                |
| E2E import boundary                                                      | `e2e/check-boundary.ts`                                         |
| Dependency patches & exact versions                                      | `bun run patches:check`, `bun run versions:check`               |
| `bun.lock` & `packages/apps` version bump                                | `bun run pr:check`, `bun run lockfile:check`                    |
| Host protocols, telemetry, API errors, auth rate limit, storage versions | `bun run check` (`scripts/check.ts`)                            |
| PR `e2e` block, stack `skip`, `Release-note:` lines                      | `bun run pr:check` (`e2e/ci-selection.ts`)                      |
| Cloud Worker upload size budgets                                         | `bun run hosted:cloud:worker-sizes`                             |
| Docs/marketing broken links                                              | `bun run site:links`                                            |
| GitHub Actions workflow syntax                                           | `actionlint`                                                    |
