# MCP Apps tests (sunpeak)

Render and test executor's generative-UI MCP Apps (the `render-ui` tool from the
`dynamic-ui` plugin) in a **real MCP-Apps host**, headlessly, in CI, with **no
VM and no Claude/ChatGPT account**.

[sunpeak](https://github.com/Sunpeak-AI/sunpeak) locally replicates the Claude
and ChatGPT app runtimes: it connects to an MCP server, calls a UI tool, mounts
the returned `ui://` resource in a sandboxed iframe with the host bridge, and
hands the test a frame-scoped handle to the rendered component. Every test runs
against both host simulations. This is the lightweight successor to the earlier
MCPJam Playwright harness (which we drove by hand via fragile UI selectors).

## Run

```bash
cd e2e/mcp-apps
npm install        # also patches sunpeak (see below) and is isolated from the bun workspace
npm test           # builds the shell, starts sunpeak + `executor mcp`, runs the specs
```

`playwright.config.ts` starts `executor mcp` over **stdio** (from source, so the
shell resource is served), so there is no daemon or HTTP token to manage. Specs
live in `tests/`; `npm run test:headed` and `npm run report` help when debugging.

A spec is tiny:

```ts
import { test, expect } from "sunpeak/test";
test("widget mounts", async ({ inspector }) => {
  const result = await inspector.renderTool("render-ui", { code: APP_SRC });
  const app = result.app().frameLocator("iframe"); // see "extra iframe" below
  await expect(app.locator('button:has-text("Increment")')).toBeVisible();
});
```

## Two interop notes (both handled here)

1. **sunpeak doesn't advertise the MCP-Apps UI *client* capability.** Its
   inspector connects with `new Client({ name, version })` and never declares
   `capabilities.extensions["io.modelcontextprotocol/ui"]`. executor's
   `render-ui` (correctly, per the MCP-Apps spec) only mounts the widget inline
   when the host advertises it can render `text/html;profile=mcp-app`; otherwise
   it returns its browser **fallback URL** and nothing renders. `scripts/patch-sunpeak.mjs`
   (a postinstall) adds that capability to sunpeak's client. This is
   upstream-worthy: sunpeak should advertise it itself.

2. **executor's shell nests one extra iframe.** The shell mounts the generated
   component in a nested `srcdoc` iframe (`shell-app` -> `inner-renderer`, the
   double-iframe sandbox), one level below sunpeak's `result.app()`. So tests use
   `result.app().frameLocator("iframe")` to reach the component.

## Why stdio + from source

`render-ui`'s shell resource (`ui://executor/shell-tanstack-query.html`) is
`packages/plugins/dynamic-ui/dist/mcp-app.html`. `pretest` builds it. Running
`executor mcp` from source serves it directly. (The compiled binary now ships
the shell too — see `apps/cli/src/build.ts` — but source is the cheaper path
for a test.)

## Scope

sunpeak is a host *simulation*: it covers the protocol contract, the rendered
UI, and tool/theme/display-mode behavior. It does not catch real-host quirks
(OAuth, production CSP). For the shell component in isolation there is also the
faster in-repo unit test at
`packages/plugins/dynamic-ui/src/shell/mcp-app.browser.test.ts`.
