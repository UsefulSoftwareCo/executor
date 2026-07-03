# Writing e2e scenarios

A scenario is ONE user-meaningful product journey, written once against the
`Target` interface and run on every deployment that supports its capabilities.
Tests are **black-box**: drive the product only through public surfaces (typed
API, web UI, MCP, CLI). Never import app internals, never poke the DB, never
modify product code or stubs — if the product or stub blocks you, STOP and
report the blocker instead of working around it.

**The test source is the review artifact.** A reviewer judges correctness by
reading the test; write it so it reads as a spec. Assertions are plain vitest
`expect` (use the message argument for intent). Browser runs additionally
produce a Playwright trace, video, and step screenshots for debugging.

## File placement

Scenario directories map to vitest projects (`vitest.config.ts` is the
authoritative list of targets and what each one includes):

- `scenarios/*.test.ts` — cross-target; runs on cloud + selfhost by default,
  and selected files also run on selfhost-docker and cloudflare
- `cloud/*.test.ts` — cloud-only (e.g. billing, WorkOS-session UI, telemetry)
- `selfhost/*.test.ts` — selfhost-only (also runs on selfhost-docker)
- `cloudflare/*.test.ts` — the Cloudflare self-host worker
- `local/*.test.ts` — the single-user local app; each scenario boots its own
  `executor web`
- `cli/*.test.ts` — the supervised CLI daemon inside guest VMs
- `desktop/`, `desktop-packaged/`, `desktop-vm/` — see Desktop targets below

## Anatomy

```ts
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const coreApi = composePluginApi([] as const); // tools/integrations/connections/providers/executions/oauth/policies

scenario(
  "Tools · a fresh workspace advertises the built-in tools",
  {}, // options: { timeout?: number; skip?: string (reason — registers as skipped) }
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const identity = yield* target.newIdentity(); // fresh isolated user+org
    const api = yield* client(coreApi, identity); // typed HttpApiClient
    const tools = yield* api.tools.list({ query: {} });
    expect(tools.length, "at least one tool is exposed").toBeGreaterThan(0);
  }),
);
```

- A scenario declares what it needs by **yielding services** from
  `src/services.ts` (`Target`, `Api`, `Browser`, `Mcp`, `Billing`, `Cli`,
  `Telemetry`, …). There is no `needs` list: yielding a service the current
  target can't provide skips the test and records why in `skipped.json`.
- Which target provides what (from `targets/*.ts`): `api` — everything except
  local and the desktop targets; `browser` — cloud, selfhost, selfhost-docker,
  cloudflare, local; `mcp-oauth` — cloud, selfhost, selfhost-docker,
  cloudflare (dev-auth on cloudflare, so no real consent hop); `billing` —
  cloud only. `Telemetry` and `Autumn` appear when the suite booted motel /
  the Autumn emulator (cloud).
- Resources created in a test must be cleaned up with `Effect.ensuring` (a
  finalizer), not trailing statements — a mid-test failure must not leak state
  into the shared instance.

## Browser scenarios

```ts
const target = yield * Target;
const browser = yield * Browser;
const identity = yield * target.newIdentity(); // logged in, has an org
// or newIdentity({ org: false }) for the onboarding flow
yield *
  browser.session(identity, async ({ page, step }) => {
    await step("A fresh user lands on the integrations page", async () => {
      await page.goto("/", { waitUntil: "networkidle" });
      await page.getByText("Integrations").first().waitFor();
    });
  });
```

- `step(label, fn)` names a Playwright trace group and saves a screenshot —
  label steps as user actions ("Open the org switcher"), not selectors.
- The session records video (mp4) + a full Playwright trace into the run's
  artifact dir; a failure saves `failure.png` automatically.
- Prefer role-based locators (`getByRole("menuitem", ...)`) — text locators
  often match the look-alike trigger button in the bottom bar.
- After an action that navigates, wait for the URL/network to settle before
  opening menus: `await page.waitForLoadState("networkidle")`.
- The stub user renders as "Test User" / `test@example.com`.

## MCP scenarios

```ts
const mcp = yield * Mcp;
const session = mcp.session(identity);
const tools = yield * session.listTools(); // OAuth happens headlessly here
const r = yield * session.call("execute", { code: "return 1 + 1;" });
// human-in-the-loop: session.approvePaused(r.text) resumes a paused execution
```

## Telemetry scenarios (cloud)

The suite boots a motel OTLP store and points the target's real exporter at
it, so a scenario can assert on the spans the server ACTUALLY exported —
the layer where "observability silently went dark" bugs live (an attribute
stamped on a span the exporter never carries looks identical to health).

```ts
const telemetry = yield * Telemetry; // skips when motel didn't boot
const span =
  yield *
  telemetry.expectSpan({
    operation: "executor.tool.execute",
    attributes: { "mcp.tool.name": failAddress }, // exact match, values stringified
  });
expect(span.span.tags["executor.tool.outcome"]).toBe("fail");
```

- `expectSpan` polls (~20s): exporters batch, so arrival is
  eventually-consistent — "the span reaches the store, soon" IS the contract.
- The cloud globalsetup boots motel automatically; `bun run motel` runs the
  same store standalone (browse it, or point a dev server's exporter at it).
- Spec gotcha for fixtures: give operations explicit `tags` — tool addresses
  are `group.leaf`, and an untagged op derives its group from the URL path,
  so `/fail` does NOT produce a `.fail`-suffixed address.
- Prior art: `cloud/telemetry-contract.test.ts`.

## Running

```sh
cd e2e
bun run test               # boots both dev servers, runs cloud + selfhost
bun run test:cloud         # one target (also: test:selfhost, test:selfhost-docker,
                           #   test:cloudflare, test:local, test:desktop, test:watch)
bun run ports              # print THIS checkout's derived ports
bun run summary            # pass/fail digest per target from runs/
# attach to an already-running server while iterating (use `bun run ports` URLs):
E2E_CLOUD_URL=http://127.0.0.1:<port> ../node_modules/.bin/vitest run --project cloud <file>
E2E_SELFHOST_URL=http://localhost:<port> ../node_modules/.bin/vitest run --project selfhost <file>
```

For interactive work against a live instance (boot, mint identities, typed API
calls, MCP calls, emulator ledger) use the dev CLI: `bun run cli` — full
command list in [RUNNING.md](../RUNNING.md).

Ports are claimed at boot (see `src/ports.ts`): each checkout hashes its repo
root to a preferred block, atomically locks it (a held lock port makes races
impossible), and walks to the next free block if it's locked or squatted — so
concurrent suites in different worktrees can never collide or attach to each
other's servers. `bun run ports` shows the preferred block; the boot log says
if a suite moved. `E2E_*_PORT` env vars pin ports explicitly (no probing) and
`E2E_<TARGET>_URL` attaches to a running instance.

Each run writes `runs/<target>/<slug>/result.json` plus any browser artifacts
(trace.zip / session.mp4 / screenshots). `bun run serve` hosts the scenario ×
target matrix; a run page links the trace into Playwright's trace viewer. The
viewer itself is a Vite/React SPA in `viewer/` (rebuilt into `runs/` by
`bun run viewer:build`); `bun e2e/scripts/pr-media.ts runs/<target>/<slug>`
turns a run's recording into PR-ready markdown.

When handing results to the user, follow the evidence contract in the root
[AGENTS.md](../AGENTS.md) (direct run links + a live instance + what to try);
[RUNNING.md](../RUNNING.md) has the current sharing/demo mechanics.

## Desktop targets (the app on real OSes, filmed)

The packaged desktop app runs as its own targets, each landing in its own
`runs/<target>/` bucket with a video. One shared scenario (`desktop-vm/`) and the
shared driver (`src/vm/desktop.ts`) + setup plumbing (`setup/desktop-vm.ts`); one
project + globalsetup per guest OS.

- **`desktop-packaged`** — the real electron-builder bundle on THIS machine's
  display (the supervised-daemon attach path). Needs a logged-in GUI session.
- **`desktop-macos` / `desktop-linux`** — the same bundle inside a guest VM,
  driven over CDP from the host and filmed. The globalsetup boots the guest
  (tart), builds + pushes the bundle, brings the app up with
  `--remote-debugging-port`, forwards it, and the scenario connects + drives +
  records. Provisioned automatically — or attach to a running guest with
  `E2E_DESKTOP_VM_IP=<ip>`:

  ```sh
  vitest run --project desktop-macos      # or desktop-linux
  ```

- **`desktop-windows`** — same scenario, but ATTACHES to a long-lived dockur
  Windows guest over an SSH jump instead of provisioning one (no bundle build).

There are also **`cli-macos` / `cli-linux` / `cli-windows`** projects (the
supervised CLI daemon inside a guest VM, `cli/*.test.ts` +
`scenarios/restart-persistence.test.ts`): the globalsetup provisions the VM
and `executor service install`s the daemon; `restart()` reboots the guest for
real, proving the boot-time auto-start path. tart for macOS/Linux, EC2 for
Windows.

macOS-guest gotchas (VNC login first, single-instance lock vs a host
Executor.app, guest log paths): see [notes/testing-on-mac.md](notes/testing-on-mac.md).

The guests run tart `--no-graphics` (no host window, never steals focus) but
still have a usable display:

- **macOS**: the base image's autologin reaches a real Aqua session
  (WindowServer/Dock/Finder). Launch the app INTO it with `sudo launchctl asuser
<uid> …` (a plain SSH spawn lands in a non-GUI session); the unsigned arm64
  bundle is ad-hoc `codesign`'d in the guest; `screencapture` films it.
- **linux**: no window server, so the app renders into an `Xvfb` display with a
  minimal WM (`openbox` — without it the electron window never maps); the window
  maps tiny (10x10) so the globalsetup `xdotool`-resizes it to fill, and ffmpeg
  `x11grab` films it. `--no-sandbox` (the chrome-sandbox needs setuid root).

Base images (`admin`/`admin`): `executor-macos-base` (cirruslabs sequoia, autologin)
and `executor-linux-base` (cirruslabs ubuntu + Xvfb/ffmpeg/openbox/xdotool +
electron runtime libs). The bundle's `executor` binary is cross-compiled for the
guest (`BUN_TARGET`), and electron-builder's `dir` target assembles the unpacked
app on macOS — so both bundles build on this Mac.

Note: `desktop-packaged`'s `guiAvailable()` probe (`launchctl managername`) reads
"Background" over SSH even when Aqua is up, so it's host-only; the VM targets gate
on a CDP page target instead.

## Discovering endpoints

- The full OpenAPI spec: `curl http://127.0.0.1:<cloud port>/api/openapi.json`
  (cloud; port from `bun run ports`).
- The typed client mirrors it: `client.<group>.<endpoint>(...)` with groups
  tools/integrations/connections/providers/executions/oauth/policies.
- To see payload shapes, read the API definitions under
  `packages/core/api/src/<group>/api.ts` (READ ONLY — for shapes, not imports).

## Isolation rules

- Cloud: `newIdentity()` is a fresh user+org — you are isolated for free.
- Selfhost: everyone is the bootstrap admin. PREFIX every resource you create
  with your scenario slug (e.g. policy pattern `policies-scn.*`) so parallel
  scenarios don't collide, and don't assert on global counts (assert "contains
  mine", not "length is 1").

## Quality bar

- The scenario name reads like a product guarantee ("Billing · the free plan
  stops organization creation after 3"), not a test id.
- The test reads as a spec top-to-bottom; a reviewer should understand the
  journey and the guarantee without running it.
- Assert outcomes the user cares about, not implementation details. No
  tautologies (don't assert what the setup already guarantees). Assert on
  values, not booleans — `expect(list).toContain(x)`, never
  `expect(list.includes(x)).toBe(true)` — so failures show the data.
- Keep it deterministic: no sleeps; wait on conditions.

## Developer-session recordings (chat theater + desk)

Some scenarios are meant to be WATCHED — they show the product the way a
developer actually uses it. Three tiers, pick deliberately:

1. **Chat theater** (`src/clients/chat-theater.ts`): the default for
   product-flow recordings. The "agent" is a chat renderer in a recorded
   PTY; every tool spinner brackets a REAL mcporter MCP call (OAuth,
   execute, approval resume). No inference, no third-party binary.
   Exemplar: `scenarios/connect-handoff-session.test.ts`. Artifacts:
   `terminal.cast` (the chat) + `session.mp4` (browser hops); the viewer
   plays them in story order.
2. **Replay brain + real client** (`src/clients/replay-brain.ts`): when the
   third-party CLIENT's behavior is under test (OpenCode/Claude Code
   protocol handling). A scripted OpenAI-wire server plays the LLM; the
   real client does everything else. Script by transcript inspection, never
   turn counting.
3. **Real-inference evals**: a different axis (performance distributions,
   not pass/fail). Not in this suite.

**The Desk** (`desk/`): films a scenario on one virtual Linux desktop — the
chat renderer in a visible xterm, the browser as a real headed window, one
ffmpeg x11grab. The film replaces session.mp4 in the run dir; the scenario
file is unchanged (chat-theater switches transports on `E2E_DESK=1`).

```
e2e/desk/run.sh [scenario] [project]   # docker; first run builds + installs
```
