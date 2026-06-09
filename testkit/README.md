# testkit (MCP surface) — MVP

Black-box tests through the **MCP surface**, on the vendored mcporter fork
(`vendor/mcporter`, with its headless `cookieConsentStrategy`). Every run emits a
**chat-transcript recording** (`run.json`) — the MCP surface *is* an agent-in-a-chat,
so that's the natural shape.

## Write a test

```js
import { mcpTarget, mcpTest, cookieConsentStrategy } from "./src/testkit.mjs";

// the per-host seam: which MCP server + how to consent (headless, CI-safe)
const selfhost = mcpTarget({
  name: "selfhost",
  server: "http://localhost:5173/mcp",
  consent: cookieConsentStrategy({ appBaseUrl: "http://localhost:5173", email, password }),
});

mcpTest("execute runs code", selfhost, async (mcp) => {
  mcp.say("Confirm the sandbox evaluates and returns a value");  // → reasoning turn
  const r = await mcp.call("execute", { code: "return 6*7;" });  // → tool turn
  mcp.expect(r.text).toBe("42");                                 // → assert turn
});
```

## Run + watch

```bash
node run.mjs                      # runs tests, writes runs/*.run.json, prints chat
node src/render.mjs runs/X.run.json            # render a recording in the terminal
node src/render.mjs runs/X.run.json --html out.html   # watchable HTML
node serve.mjs                    # serve runs/ (index + per-run HTML) on :8901
```

## What a recording is

`run.json` = a chat transcript (`turns`: user / assistant·reasoning / tool / assert /
error) + `asserts` + `ok`/`error`/`durationMs`. The HTML renders it as a chat: task
bubble → reasoning → collapsible tool cards (args + result) → inline asserts. Failures
record too — `ok:false` with the failing turn in place.

## Status / next

- **Now:** scripted brain (deterministic, no LLM). Proven against dev `/mcp`.
- **Next:** `agentTest` — LLM brain (real model drives via MCP, reasoning captured
  verbatim); raw JSON-RPC `protocol[]` layer linked to tool turns; MCP-apps as `app`
  turns. Productionize to TS + Effect Vitest later (see memory: effect-testing-stack-note).
- Self-contained ESM JS under `testkit/` (not in the bun workspace) — imports the fork's
  built `dist`. Throwaway-grade until productionized; the proof is real.
