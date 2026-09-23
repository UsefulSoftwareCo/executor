/** Consent reads every tool page over the real typed HTTP client. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { registerBrowser } from "./dom.ts";
import { Effect } from "effect";
import { AtomRegistry } from "effect/unstable/reactivity";
import { AppId } from "@executor-js/sdk";
import { OrganizationId } from "@executor-js/hosted-server/organization";

test("consent includes later pages and rejects catalogs that change during loading", async () => {
  let changed = false;
  const cursors: Array<string | null> = [];
  const app = AppId.make("app_catalog");
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json");
    if (url.pathname !== `/api/organizations/org_catalog/apps/${app}/tools`) {
      response.end("{}");
      return;
    }
    const cursor = url.searchParams.get("cursor");
    cursors.push(cursor);
    const deployment = changed && cursor !== null ? "dpl_changed" : "dpl_catalog";
    const names =
      cursor === null
        ? Array.from({ length: 2000 }, (_, i) => `tool_${String(i).padStart(4, "0")}`)
        : ["tool_2000"];
    response.end(
      JSON.stringify({
        deployment,
        items: names.map((name) => ({
          app,
          deployment,
          name,
          description: "Synthetic tool",
          inputSchema: { type: "object", properties: {} },
        })),
        ...(cursor === null ? { next: "tool_1999" } : {}),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  registerBrowser(origin);
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: string | URL | Request, init?: RequestInit) =>
      originalFetch(typeof input === "string" ? new URL(input, origin) : input, init),
  });
  const registry = AtomRegistry.make();
  try {
    const { mcpToolsAtoms } = await import("../src/contracts/mcp.ts");
    const tools = mcpToolsAtoms(OrganizationId.make("org_catalog"))(app);
    const result = await Effect.runPromise(
      AtomRegistry.getResult(registry, tools, { suspendOnWaiting: true }),
    );
    assert.equal(result.length, 2001);
    assert.equal(result.at(-1)?.name, "tool_2000");
    assert.deepEqual(cursors, [null, "tool_1999"]);
    changed = true;
    registry.refresh(tools);
    await assert.rejects(
      Effect.runPromise(AtomRegistry.getResult(registry, tools, { suspendOnWaiting: true })),
    );
  } finally {
    registry.dispose();
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    await GlobalRegistrator.unregister();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
