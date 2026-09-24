import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, type ServerInstance } from "./serve";
import { OTC_TTL_MS, makeOtcStore } from "./otc";

let clientDir: string;
let dataDir: string;
let server: ServerInstance | null = null;

const TOKEN = "test-bearer-token";

const testHandlers = () => ({
  api: {
    handler: async () => new Response("ok"),
    dispose: async () => {},
  },
  mcp: {
    handleRequest: async () => new Response("ok"),
    handleApprovalRequest: async () => new Response("ok"),
    handlePausedRequest: async () => new Response("ok"),
    close: async () => {},
  },
});

const startTestServer = async (): Promise<string> => {
  server = await startServer({
    port: 0,
    hostname: "127.0.0.1",
    clientDir,
    authToken: TOKEN,
    handlers: testHandlers(),
  });
  return `http://127.0.0.1:${server.port}`;
};

beforeEach(() => {
  clientDir = mkdtempSync(join(tmpdir(), "exec-otc-serve-"));
  dataDir = mkdtempSync(join(tmpdir(), "exec-otc-data-"));
  process.env.EXECUTOR_DATA_DIR = dataDir;
  process.env.EXECUTOR_SCOPE_DIR = dataDir;
  writeFileSync(
    join(clientDir, "index.html"),
    "<!doctype html><html><body>index-shell</body></html>",
  );
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  delete process.env.EXECUTOR_DATA_DIR;
  delete process.env.EXECUTOR_SCOPE_DIR;
  rmSync(clientDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("OTC exchange endpoint", () => {
  it("mints a code via the bearer-gated route and exchanges it once (200 + HttpOnly cookie)", async () => {
    const origin = await startTestServer();
    const mint = await fetch(`${origin}/api/auth/otc`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(mint.status).toBe(200);
    const { code } = (await mint.json()) as { code: string };
    expect(code.length).toBeGreaterThanOrEqual(16); // ≥128 bits base64url

    const exchange = await fetch(`${origin}/api/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `code=${encodeURIComponent(code)}`,
    });
    expect(exchange.status).toBe(200);
    const body = (await exchange.json()) as { token: string };
    expect(body.token).toBe(TOKEN);

    const setCookie = exchange.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("executor_session");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  it("rejects a replayed code (single-use — second exchange is 400)", async () => {
    const origin = await startTestServer();
    const mint = await fetch(`${origin}/api/auth/otc`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const { code } = (await mint.json()) as { code: string };

    const first = await fetch(`${origin}/api/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `code=${encodeURIComponent(code)}`,
    });
    expect(first.status).toBe(200);

    const replay = await fetch(`${origin}/api/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `code=${encodeURIComponent(code)}`,
    });
    expect(replay.status).toBe(400);
  });

  it("rejects an unknown code", async () => {
    const origin = await startTestServer();
    const res = await fetch(`${origin}/api/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "code=never-issued",
    });
    expect(res.status).toBe(400);
  });

  it("rejects the mint route without a bearer", async () => {
    const origin = await startTestServer();
    const res = await fetch(`${origin}/api/auth/otc`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects an expired code (TTL honored by the store)", () => {
    let now = 1_000;
    const store = makeOtcStore(() => now);
    const code = store.issue();
    expect(store.consume(code)).toBe(code);

    // Re-issue after expiry — the consumed code must stay dead even after
    // pruning.
    const code2 = store.issue();
    now = now + OTC_TTL_MS + 1;
    expect(store.consume(code2)).toBeNull();
    expect(store.consume(code)).toBeNull();
  });
});
