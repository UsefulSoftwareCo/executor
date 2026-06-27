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

- `cd e2e && bun run test` runs the portable hermetic projects: harness unit
  tests, client adapters, cloud, selfhost, local, and Cloudflare. The cloud and
  selfhost projects exclude scenarios whose purpose is to detect drift in a
  public service.
- `bun run test:cloud`, `bun run test:selfhost`, and
  `bun run test:cloudflare` run the corresponding full project, including
  live-provider checks. Their `:hermetic` variants match the pull-request
  gates.
- `bun run test:selfhost-docker:hermetic` runs the same journeys against the
  production Docker artifact. `bun run test:desktop-packaged` builds and drives
  the unsigned packaged Electron application and needs a GUI display.
- `E2E_CLOUD_URL` and `E2E_SELFHOST_URL` attach to an already-running server
  instead of booting one.
- Project names describe execution policy, while `E2E_TARGET` describes the
  deployed product. For example, `cloud` and `cloud-hermetic` both resolve the
  cloud target and use the same boot recipe.
- Local exploration allows a scenario to skip when its target does not offer a
  requested Effect service. CI sets `E2E_REQUIRED_CAPABILITY_MODE=required`, so
  a missing service promised by the project's matrix fails instead of becoming
  a green skip. The matrix is `e2e/src/project-matrix.ts`.
- Runs land in `e2e/runs/<target>/<scenario-slug>/` — `result.json`, step
  screenshots, `session.mp4` + `trace.zip` for browser scenarios, and the
  scenario source as `test.ts`.
- `cd e2e && bun run serve` builds the viewer and serves the scenario ×
  target matrix over HTTP, bound to all interfaces (reachable over the
  tailnet). It prefers port 8901 but walks forward to the next free port if
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

## E2E CI tiers

The end-to-end workflow separates deterministic product guarantees from
environment and provider drift:

- Pull requests run harness unit tests, emulator-backed cloud and selfhost,
  local, Cloudflare, and the production selfhost image on ephemeral
  GitHub-hosted Linux VMs. The same VM runs development and packaged Electron
  journeys under Xvfb.
- The Cloudflare lane leaves `ENABLE_DEV_AUTH` off. A scoped loopback Access
  issuer signs human and service application tokens and serves the team JWKS,
  so issuer, audience, expiry, signature, and machine-identity checks remain in
  the pull-request gate without a Cloudflare account.
- The client lanes install pinned Claude Code and OpenCode binaries and require
  their real-client capabilities. Model traffic goes only to local replay
  fixtures, so they need neither a user login nor paid inference.
- macOS and Windows runners build the native unsigned package and start the
  bundled Executor binary. They do not claim GUI journey coverage. Linux is the
  current required packaged-GUI lane.
- The scheduled or manually dispatched `desktop-linux-kvm` job provides the
  stronger guest boundary when `E2E_LINUX_KVM_ENABLED=true`. A labeled x64
  self-hosted runner uses the prepared QCOW2 image at `E2E_KVM_BASE_IMAGE` to
  create a disposable cloud-init overlay, launch the packaged app on Xorg,
  drive a native window, record its SPICE framebuffer, and discard the domain.
  The runner must provide QEMU, libvirt, `virt-install`, `cloud-localds`, SSH,
  Xvfb, Openbox, `remote-viewer`, and ffmpeg. The base image must provide the
  guest Xorg, Openbox, D-Bus, `xdpyinfo`, `xdotool`, SSH, and Electron runtime
  libraries.
- Public Microsoft Graph metadata and the hosted Microsoft OAuth emulator run
  nightly and are nonblocking. `bun run test:live` reproduces that group. The
  Resend handoff, no-auth API, and PostHog-shaped MCP flows use scoped local
  emulators and remain in pull-request coverage.
- Real service installation and reboot in Tart macOS/Linux guests is enabled
  only when `E2E_TART_VM_ENABLED=true` and an `executor-e2e` macOS runner has the
  documented base images. The EC2 Windows guest is similarly gated by
  `E2E_WINDOWS_VM_ENABLED=true` and dedicated AWS credentials. These are CLI
  service VMs, not macOS or Windows desktop-GUI claims.
- Every e2e job sanitizes `e2e/runs` before artifact upload. If sanitization
  fails, the workflow does not publish the unsanitized directory.

## The dev CLI: live instances, interactively

`cd e2e && bun run cli` — the same primitives scenarios use, as commands.
Boot a target, mint identities, make typed API calls, drive MCP, read the
emulator ledger — develop interactively, then crystallize the journey into
a scenario.

```sh
bun run cli up selfhost --share   # boot, reachable over the tailnet, stays up
bun run cli up cloud --share      # emulated WorkOS+Autumn, tailscale-HTTPS fronted
bun run cli status                # what's running, URLs, creds
bun run cli identity selfhost     # fresh identity (headers / cookies / creds)
bun run cli api selfhost tools.list
bun run cli mcp selfhost call execute '{"code":"return 1+1;"}'
bun run cli ledger cloud workos   # what hit the emulator
bun run cli down selfhost         # tear down (also removes tailscale serves)
```

Instances persist until `down` — `up --share` IS the "touch it" handoff
artifact, and the seeding direction too: boot, drive the product into a
state (API/MCP/UI), hand across the URL. State files in `e2e/.dev/` mark
deliberate long-lived instances (vs leaks); attach scenarios to a running
instance with `E2E_<TARGET>_URL`.

Why cloud `--share` is more involved (encoded in the CLI, kept here for
when you hit it manually): the cloud app sets `secure: true` auth cookies,
so login breaks over plain http from any non-localhost origin ("Invalid
login state"). Both the app AND the WorkOS emulator get fronted with
`tailscale serve` HTTPS, the emulator advertises its public URL on both
sides (its `baseUrl` and the app's `WORKOS_API_URL` — the browser-facing
authorize URL derives from the latter), and Vite must allow the public
hostname (`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`).

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
- The real Tailscale CLI on this machine is
  `/opt/homebrew/opt/tailscale/bin/tailscale`; `/usr/local/bin/tailscale`
  is a broken shim pointing at a deleted app. The tailnet IP is on the
  `utun` interface (100.x.y.z) if the CLI fails.
- `bun.lock` conflicts on rebase: take either side, re-run `bun install`,
  never hand-merge.
- Long-lived demo servers you left up for the user look like leaks to
  cleanup tooling — `e2e/.dev/<target>.json` marks deliberate instances;
  check it before reaping, and `bun run cli down <target>` is the clean
  teardown.
