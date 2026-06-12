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

- `scenarios/*.test.ts` — runs on every target (cloud + selfhost)
- `cloud/*.test.ts` — cloud-only (e.g. billing, WorkOS-session UI)
- `selfhost/*.test.ts` — selfhost-only

## Anatomy

```ts
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { scenario } from "../src/scenario";

const coreApi = composePluginApi([] as const); // tools/integrations/connections/providers/executions/oauth/policies

scenario("Tools · a fresh workspace advertises the built-in tools", { needs: ["api"] }, (ctx) =>
  Effect.gen(function* () {
    const identity = yield* ctx.target.newIdentity(); // fresh isolated user+org
    const client = yield* ctx.api.client(coreApi, identity); // typed HttpApiClient
    const tools = yield* client.tools.list();
    expect(tools.length, "at least one tool is exposed").toBeGreaterThan(0);
  }),
);
```

- Capabilities (`needs`): `api`, `browser` (cloud only today), `mcp-oauth`
  (selfhost only today), `billing` (cloud only).
- Resources created in a test must be cleaned up with `Effect.ensuring` (a
  finalizer), not trailing statements — a mid-test failure must not leak state
  into the shared instance.

## Browser scenarios (cloud)

```ts
const identity = yield * ctx.target.newIdentity(); // logged in, has an org
// or newIdentity({ org: false }) for the onboarding flow
yield *
  ctx.browser.session(identity, async ({ page, step }) => {
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
const session = ctx.mcp.session(identity);
const tools = yield * session.listTools(); // OAuth happens headlessly here
const r = yield * session.call("execute", { code: "return 1 + 1;" });
// human-in-the-loop: session.approvePaused(r.text) resumes a paused execution
```

## Running

```sh
cd e2e
bun run test               # boots both dev servers, runs everything
bun run test:cloud         # one target
bun run ports              # print THIS checkout's derived ports
# attach to an already-running server while iterating (use `bun run ports` URLs):
E2E_CLOUD_URL=http://127.0.0.1:<port> ../node_modules/.bin/vitest run --project cloud <file>
E2E_SELFHOST_URL=http://localhost:<port> ../node_modules/.bin/vitest run --project selfhost <file>
```

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
