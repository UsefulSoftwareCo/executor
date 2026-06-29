# RUNNING.md — how things run today

> **This document may be out of date.** It describes how things run today,
> not how they must run. Trust it as a starting point; if you hit weirdness,
> the implementation has probably moved and this file is why. Verify against
> the code, then update this file when you notice drift. The principles in
> [AGENTS.md](AGENTS.md) are the stable contract; everything below is
> implementation detail that churns.

## Fresh checkout / worktree setup

`bun run bootstrap` from the repo root — idempotent: `bun install` (whose
prepare hook builds `@executor-js/vite-plugin` and `packages/react`, the
artifacts dev servers fail without) plus Playwright chromium. A fresh
worktree that skips it dies with "Failed to resolve entry for package
'@executor-js/vite-plugin'".

Our two upstream forks — `@executor-js/emulate` (service emulators) and
`@executor-js/mcporter` (headless MCP client) — are consumed purely as
published npm packages; nothing in this repo references them by path. There
are no `vendor/` submodules. Each fork is its own standalone repo
(`github.com/UsefulSoftwareCo/emulate`, `github.com/UsefulSoftwareCo/mcporter`):
develop on its `main`, publish a bump, then bump the dependency here. The
`emulate` skill covers the emulator publish/deploy loop.

## Dev servers

- Everything except desktop/cloud: `bun run dev` (turbo, from root)
- One app: `bun run dev` from its `apps/<name>` directory
- Self-host boots standalone with just env vars — see
  `e2e/setup/selfhost.globalsetup.ts` for the canonical recipe (data dir,
  bootstrap admin email/password, base URL, `EXECUTOR_ALLOW_LOCAL_NETWORK`)
- Cloud needs WorkOS + Autumn; for a no-.env boot, point it at emulators —
  see `e2e/setup/cloud.globalsetup.ts` for the canonical recipe (the real
  SDKs against emulated services, PGlite dev DB)

The e2e globalsetup files are the source of truth for "how do I boot a
working instance of X" — read them before inventing a boot path.

## E2E: running, viewing, sharing

`e2e/AGENTS.md` covers writing scenarios. Operationally:

- `cd e2e && bun run test` boots dev servers and runs everything;
  `--project cloud|selfhost` narrows. `E2E_CLOUD_URL`/`E2E_SELFHOST_URL`
  attach to an already-running server instead of booting.
- Runs land in `e2e/runs/<target>/<scenario-slug>/` — `result.json`, step
  screenshots, `session.mp4` + `trace.zip` for browser scenarios, and the
  scenario source as `test.ts`.
- `cd e2e && bun run serve` builds the viewer and serves the scenario ×
  target matrix over HTTP, bound to all interfaces. It prefers port 8901
  but walks forward to the next free port if
  that's taken (so concurrent worktrees, or a leaked previous viewer, never
  wedge each other) — read the printed `e2e viewer → …` URL for the actual
  port. `PORT=…` pins a port explicitly and fails loudly if it's busy. The
  built SPA is port- and mount-agnostic (relative assets + hash routing), so
  whatever port it lands on just works. Individual runs are at
  `#/<target>/<slug>` hash routes — when handing results to the user, link
  those directly, not the bare matrix.
- `bun e2e/scripts/pr-media.ts e2e/runs/<target>/<slug>` converts a run's
  recording to a gif, uploads it to the `e2e-media` branch, and prints
  PR-ready markdown.

E2E dev-server ports are derived and CLAIMED per checkout (`cd e2e && bun
run ports` prints this checkout's block; see `e2e/src/ports.ts`) — each
checkout hashes its repo root to a preferred block, atomically locks it,
and walks to the next free block if squatted, so concurrent worktrees never
collide or attach to each other's servers. `E2E_*_PORT` env vars pin ports
explicitly. If a boot reports a squatted port, an old dev server leaked —
`bun run reap` (repo root) lists and kills orphaned stacks.

## The dev CLI: live instances, interactively

`cd e2e && bun run cli` — the same primitives scenarios use, as commands.
Boot a target, mint identities, make typed API calls, drive MCP, read the
emulator ledger — develop interactively, then crystallize the journey into
a scenario.

```sh
bun run cli up selfhost --share   # boot, shared, stays up
bun run cli up cloud --share      # emulated WorkOS+Autumn
bun run cli status                # what's running, URLs, creds
bun run cli identity selfhost     # fresh identity (headers / cookies / creds)
bun run cli api selfhost tools.list
bun run cli mcp selfhost call execute '{"code":"return 1+1;"}'
bun run cli ledger cloud workos   # what hit the emulator
bun run cli down selfhost         # tear down
```

Instances persist until `down` — `up --share` IS the "touch it" handoff
artifact, and the seeding direction too: boot, drive the product into a
state (API/MCP/UI), hand across the URL. State files in `e2e/.dev/` mark
deliberate long-lived instances (vs leaks); attach scenarios to a running
instance with `E2E_<TARGET>_URL`.

## Environment gotchas (learned the hard way)

- The shell is fish, and the working directory resets between Bash calls.
  Use absolute paths rooted at THIS worktree; don't rely on a prior `cd`.
- Don't write probe scripts to `/tmp` — they can't resolve workspace
  packages (`effect`, `playwright`, …). Put scratch scripts under the repo
  root (`scratch/` is gitignored) so bun resolves the workspace.
- A fresh worktree's Vite dep-optimizer cache can serve PRE-REBASE code
  (symptom: behavior matching old code only in dev servers, while unit
  tests pass). Kill the server, clear `node_modules/.vite` /
  `.tanstack`-adjacent caches, reboot.
- `bun.lock` conflicts on rebase: take either side, re-run `bun install`,
  never hand-merge.
- Long-lived demo servers you left up for the user look like leaks to
  cleanup tooling — `e2e/.dev/<target>.json` marks deliberate instances;
  check it before reaping, and `bun run cli down <target>` is the clean
  teardown.
