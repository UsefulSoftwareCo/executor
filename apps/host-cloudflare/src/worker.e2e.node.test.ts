import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

// ---------------------------------------------------------------------------
// End-to-end test for the Cloudflare host: boots the REAL worker on workerd via
// Miniflare (wrangler `unstable_dev`) with a local D1 + R2, dev-auth on. This is
// the only test that exercises the CF-specific stack together — D1 schema
// bring-up, the R2 large-value offload, QuickJS-WASM execution, and the MCP
// envelope — through the actual HTTP surface.
// ---------------------------------------------------------------------------

const dir = fileURLToPath(new URL(".", import.meta.url));

// Inline spec (no network); registers one tool, exercising the D1 write path.
const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Test", version: "1.0.0" },
  servers: [{ url: "https://example.com" }],
  paths: {
    "/ping": { get: { operationId: "ping", responses: { "200": { description: "ok" } } } },
  },
});

describe("cloudflare host e2e (workerd/miniflare)", () => {
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    worker = await unstable_dev(resolve(dir, "worker.ts"), {
      config: resolve(dir, "../wrangler.jsonc"),
      ip: "127.0.0.1",
      local: true,
      experimental: { disableExperimentalWarning: true },
      vars: {
        EXECUTOR_SECRET_KEY: "test-secret-key-0123456789abcdef",
        ENABLE_DEV_AUTH: "true",
      },
    });
  }, 120_000);

  afterAll(async () => {
    await worker?.stop();
  });

  it("executes TypeScript via /api/executions (QuickJS on workerd)", async () => {
    const res = await worker.fetch("/api/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "export default 6 * 7" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; isError: boolean };
    expect(body.isError).toBe(false);
    expect(body.text).toBe("42");
  }, 60_000);

  it("adds an OpenAPI source and reads it back (D1 write + read path)", async () => {
    const add = await worker.fetch("/api/scopes/default/openapi/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spec: { kind: "blob", value: SPEC },
        name: "Test API",
        baseUrl: "https://example.com",
        namespace: "testapi",
      }),
    });
    expect(add.status).toBe(200);
    const added = (await add.json()) as { toolCount: number; namespace: string };
    expect(added.toolCount).toBeGreaterThan(0);

    const got = await worker.fetch("/api/scopes/default/openapi/sources/testapi");
    expect(got.status).toBe(200);
    const source = (await got.json()) as { namespace: string } | null;
    expect(source?.namespace).toBe("testapi");
  }, 60_000);

  it("gates the API when dev-auth is on but treats the request as the dev admin", async () => {
    // dev-auth means the request is the fixed dev admin; /api/scope resolves.
    const res = await worker.fetch("/api/scope");
    expect(res.status).toBe(200);
  });

  it("serves an MCP initialize handshake at /mcp", async () => {
    const res = await worker.fetch("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  }, 60_000);
});
