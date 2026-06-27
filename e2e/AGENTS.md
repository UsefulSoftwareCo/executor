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

- `scenarios/*.test.ts`: shared deployment journeys selected by each project's
  include list.
- `cloud/*.test.ts`, `selfhost/*.test.ts`, and `cloudflare/*.test.ts`:
  deployment-specific guarantees.
- `local/*.test.ts`, `desktop/*.test.ts`, `desktop-packaged/*.test.ts`, and
  `cli/*.test.ts`: client and machine-specific journeys.
- `src/clients/*.test.ts`: hermetic adapter tests selected by the `clients`
  project, including real third-party binaries against replay emulators.
- `harness/*.test.ts`: no-service Effect Vitest coverage for the runner,
  evidence pipeline, trace writers, and port allocation.
- Add or change project membership in `src/project-matrix.ts`. Do not duplicate
  the target or global-setup registry in `vitest.config.ts`.

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
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(coreApi, identity);
    const tools = yield* client.tools.list();
    expect(tools.length, "at least one tool is exposed").toBeGreaterThan(0);
  }),
);
```

- Yielding an Effect service declares the scenario's capability requirement.
  Unsupported services skip during local exploratory runs. CI uses required
  mode, so a service promised by the selected project's matrix fails instead
  of producing a green skip.
- Resources created in a test must be cleaned up with `Effect.ensuring` (a
  finalizer), not trailing statements — a mid-test failure must not leak state
  into the shared instance.

## Browser scenarios (cloud)

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

## MCP scenarios (selfhost)

```ts
const target = yield * Target;
const mcp = yield * Mcp;
const identity = yield * target.newIdentity();
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
const telemetry = yield * Telemetry;
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
- Spec gotcha for fixtures: give operations explicit `tags` — tool addresses
  are `group.leaf`, and an untagged op derives its group from the URL path,
  so `/fail` does NOT produce a `.fail`-suffixed address.
- Prior art: `cloud/telemetry-contract.test.ts`.

## Running

```sh
cd e2e
bun run test                    # portable hermetic projects
bun run test:harness            # runner and evidence unit tests, no target boot
bun run test:clients            # client adapters, no deployed target
bun run test:cloud:hermetic     # the cloud pull-request project
bun run test:cloud               # cloud plus live-provider drift checks
bun run test:selfhost-docker:hermetic
bun run test:desktop-packaged   # needs a GUI display
bun run test:live               # public-provider drift, nonblocking in CI
bun run ports              # print THIS checkout's derived ports
# attach to an already-running server while iterating (use `bun run ports` URLs):
E2E_CLOUD_URL=http://127.0.0.1:<port> ../node_modules/.bin/vitest run --project cloud <file>
E2E_SELFHOST_URL=http://localhost:<port> ../node_modules/.bin/vitest run --project selfhost <file>
```

`E2E_REQUIRED_CAPABILITY_MODE=required` turns a missing capability promised by
the project matrix into a failure. Pull-request CI sets it automatically.
Public-provider scenarios are explicitly excluded from hermetic projects and
run in the nightly nonblocking lane. See [RUNNING.md](../RUNNING.md) for the
native desktop and heavyweight VM coverage boundaries.

Ports are claimed at boot (see `src/ports.ts`): each checkout hashes its repo
root to a preferred block, atomically locks it (a held lock port makes races
impossible), and walks to the next free block if it's locked or squatted — so
concurrent suites in different worktrees can never collide or attach to each
other's servers. `bun run ports` shows the preferred block; the boot log says
if a suite moved. `E2E_*_PORT` env vars pin ports explicitly (no probing) and
`E2E_<TARGET>_URL` attaches to a running instance.

Each run writes `runs/<target>/<slug>/result.json` plus any browser artifacts
(trace.zip / session.mp4 / screenshots). `bun run serve` hosts the scenario ×
target matrix; a run page links the trace into Playwright's trace viewer.

### Published evidence policy

Text and JSON artifacts are redacted before publication. Screenshots and video
are retained byte-for-byte because generic pixel redaction cannot prove that a
secret is absent. Therefore visual artifacts may contain synthetic test data
only. A run with PNG, MP4, or WebM evidence must declare
`visualEvidence.dataClassification` in `result.json`, but that claim never
authorizes publication by itself. The harness also writes
`lane-provenance.json` from the central project matrix. CI binds each artifact
name to its workflow project outside `runs/`; both sanitization and static
publication require the persisted provenance to match that external binding.
This prevents a live lane from claiming a hermetic project that shares its
target. Visual artifacts are retained only for externally bound hermetic
`synthetic-only` lanes. Unknown, live, manual, forged, or mismatched lanes lose
their visual binaries and fail publication. The publication also includes
`publication.json` with sanitizer provenance, policy version, counts, binary
artifact paths, and the byte-canary limitation. Never point a recorded e2e
lane at a real user account or production data.

`scenario()` writes a focused `test.ts` and `test-source-metadata.json`. Direct
Vitest journeys, such as a packaged guest test, should call
`writeFocusedTestSource()` from `src/test-source.ts` with their run directory,
`import.meta.url` file path, and registered test name so the viewer receives
the same focused source evidence.

When handing results to the user, follow the evidence contract in the root
[AGENTS.md](../AGENTS.md) (direct run links + a live instance + what to try);
[RUNNING.md](../RUNNING.md) has the current sharing/demo mechanics.

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
2. **Replay brain + real client** (`src/clients/replay-brain.ts` and
   `src/clients/anthropic-replay-brain.ts`): when the third-party CLIENT's
   behavior is under test (OpenCode or Claude Code protocol handling). A
   scripted provider-wire server plays the LLM; the real client does
   everything else. Script by transcript inspection, never turn counting.
3. **Real-inference evals**: a different axis (performance distributions,
   not pass/fail). Not in this suite.

**The Desk** (`desk/`): films a scenario on one virtual Linux desktop — the
chat renderer in a visible xterm, the browser as a real headed window, one
ffmpeg x11grab. The film replaces session.mp4 in the run dir; the scenario
file is unchanged (chat-theater switches transports on `E2E_DESK=1`).

```
e2e/desk/run.sh [scenario] [project]   # docker; first run builds + installs
```
