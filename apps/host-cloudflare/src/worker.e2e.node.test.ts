import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

// ---------------------------------------------------------------------------
// End-to-end test for the Cloudflare host: boots the REAL worker on workerd via
// Miniflare (wrangler `unstable_dev`) with a local D1 + R2, dev-auth on. This is
// the only test that exercises the CF-specific stack together — D1 schema
// bring-up, the R2-backed blob seam (multi-MB spec storage), QuickJS-WASM
// execution, and the MCP envelope — through the actual HTTP surface.
// ---------------------------------------------------------------------------

const dir = fileURLToPath(new URL(".", import.meta.url));
const runId = randomUUID().slice(0, 8);

// Inline spec (no network); registers one tool, exercising the D1 write path.
const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Test", version: "1.0.0" },
  servers: [{ url: "https://example.com" }],
  paths: {
    "/ping": {
      get: { operationId: "ping", responses: { "200": { description: "ok" } } },
    },
  },
});

const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface JsonReadableResponse {
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

const readMcpJson = async <A>(response: JsonReadableResponse): Promise<A> => {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as A;
  }
  const text = await response.text();
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  expect(data).toBeTruthy();
  return decodeUnknownJson(data!) as A;
};

describe("cloudflare host e2e (workerd/miniflare)", () => {
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    // CI runs from a fresh checkout with no `vite build`, so `./dist` (the SPA
    // assets dir wrangler.jsonc points `assets.directory` at) is absent and
    // `unstable_dev`'s assets validation aborts boot. This e2e drives the
    // API/MCP surface (all `run_worker_first` paths), not the SPA, so a minimal
    // placeholder index.html satisfies the validation without a real build.
    const distIndex = resolve(dir, "../dist/index.html");
    if (!existsSync(distIndex)) {
      mkdirSync(resolve(dir, "../dist"), { recursive: true });
      writeFileSync(distIndex, "<!doctype html><title>executor</title>");
    }

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
    const body = (await res.json()) as {
      status: string;
      text: string;
      isError: boolean;
    };
    expect(body.status).toBe("completed");
    expect(body.isError).toBe(false);
    expect(body.text).toBe("42");
  }, 60_000);

  it("adds a LARGE OpenAPI source — exercises the R2 blob seam (~1MB spec) + createMany batching (>100 tools)", async () => {
    // Synthesize a spec big enough to (a) far exceed D1's per-value cap if it
    // were inlined — proving the spec text really lands in the R2 blob seam —
    // and (b) derive >100 tools (past D1's 100 bound-param createMany limit).
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 250; i++) {
      paths[`/op${i}`] = {
        get: {
          operationId: `op${i}`,
          summary: `operation ${i}`,
          description: "d".repeat(4000), // padding -> ~1MB total spec
          responses: { "200": { description: "ok" } },
        },
      };
    }
    const largeSpec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Large", version: "1.0.0" },
      servers: [{ url: "https://example.com" }],
      paths,
    });
    expect(largeSpec.length).toBeGreaterThan(900_000);

    const slug = `largeapi-${runId}`;
    const add = await worker.fetch("/api/openapi/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spec: { kind: "blob", value: largeSpec },
        slug,
        description: "Large API",
        baseUrl: "https://example.com",
      }),
    });
    expect(add.status).toBe(200);
    const added = (await add.json()) as { toolCount: number };
    expect(added.toolCount).toBe(250);

    // Reads back the catalog row whose config points at the R2 spec blob.
    const got = await worker.fetch(`/api/openapi/integrations/${slug}`);
    expect(got.status).toBe(200);
    const integration = (await got.json()) as { slug: string } | null;
    expect(integration?.slug).toBe(slug);
  }, 90_000);

  it("adds an OpenAPI source and reads it back (D1 write + read path)", async () => {
    const slug = `testapi-${runId}`;
    const add = await worker.fetch("/api/openapi/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spec: { kind: "blob", value: SPEC },
        slug,
        description: "Test API",
        baseUrl: "https://example.com",
      }),
    });
    expect(add.status).toBe(200);
    const added = (await add.json()) as { toolCount: number; slug: string };
    expect(added.toolCount).toBeGreaterThan(0);

    const got = await worker.fetch(`/api/openapi/integrations/${slug}`);
    expect(got.status).toBe(200);
    const integration = (await got.json()) as { slug: string } | null;
    expect(integration?.slug).toBe(slug);
  }, 60_000);

  it("registers the Microsoft Graph API route in the runtime plugin set", async () => {
    const res = await worker.fetch("/api/microsoft/graph", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("gates the API when dev-auth is on but treats the request as the dev admin", async () => {
    // dev-auth means the request is the fixed dev admin; a gated route resolves
    // to the principal. There is no scope stack in v2 — account/me is the
    // identity-backed read that the API gate protects.
    const res = await worker.fetch("/api/account/me");
    expect(res.status).toBe(200);
    const me = (await res.json()) as {
      user: { id: string };
      organization: { id: string };
    };
    expect(me.user.id).toBe("dev");
  });

  it("lists tools on a follow-up request after a fresh initialize (DO session survives across requests)", async () => {
    // The production regression: `initialize` creates the session, then a
    // SEPARATE `tools/list` request must find it. With the old in-process store a
    // second Worker isolate never saw the session and this returned "Not
    // connected"; the MCP-session Durable Object (id == session id) routes the
    // follow-up back to the same isolate, so the tool list comes through.
    const accept = "application/json, text/event-stream";
    const rpc = (sessionId: string | null, body: unknown) =>
      worker.fetch("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept,
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(body),
      });

    const init = await rpc(null, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    await rpc(sessionId, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const list = await rpc(sessionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(list.status).toBe(200);
    const listed = await readMcpJson<{
      result?: { tools?: ReadonlyArray<{ name: string }> };
    }>(list);
    const toolNames = listed.result?.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain("execute");
  }, 60_000);

  it("serves streamable HTTP GET only for initialized sessions", async () => {
    const missing = await worker.fetch("/mcp", {
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
    expect(missing.status).toBe(400);
    await missing.text();

    const init = await worker.fetch("/mcp", {
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
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await init.text();

    const stream = await worker.fetch("/mcp", {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "mcp-session-id": sessionId!,
      },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();
  }, 60_000);

  it("invokes the execute tool over MCP (initialize → tools/call → QuickJS)", async () => {
    const accept = "application/json, text/event-stream";
    const rpc = (sessionId: string | null, body: unknown) =>
      worker.fetch("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept,
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(body),
      });

    const init = await rpc(null, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    await rpc(sessionId, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const call = await rpc(sessionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "execute", arguments: { code: "export default 6 * 7" } },
    });
    expect(call.status).toBe(200);
    const result = await readMcpJson<{
      result?: { structuredContent?: { result?: number } };
    }>(call);
    expect(result.result?.structuredContent?.result).toBe(42);
  }, 60_000);
});
