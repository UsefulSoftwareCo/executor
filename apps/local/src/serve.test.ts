import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireDataDirOwnership } from "./db/data-dir-ownership";
import { startServer, type ServerInstance } from "./serve";

let clientDir: string;
let dataDir: string;
let server: ServerInstance | null = null;

const TOKEN = "test-token";

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

const startTestServer = async (
  opts: { authToken?: string; hostname?: string } = {},
): Promise<string> => {
  server = await startServer({
    port: 0,
    hostname: opts.hostname ?? "127.0.0.1",
    clientDir,
    authToken: opts.authToken ?? TOKEN,
    handlers: testHandlers(),
  });
  return `http://127.0.0.1:${server.port}`;
};

beforeEach(() => {
  clientDir = mkdtempSync(join(tmpdir(), "exec-local-serve-"));
  dataDir = mkdtempSync(join(tmpdir(), "exec-local-data-"));
  // Isolate auth.json writes and dynamic plugin lookup from the real ~/.executor/workspace.
  process.env.EXECUTOR_DATA_DIR = dataDir;
  process.env.EXECUTOR_SCOPE_DIR = dataDir;
  mkdirSync(join(clientDir, "assets"), { recursive: true });
  writeFileSync(
    join(clientDir, "index.html"),
    "<!doctype html><html><body>index-shell</body></html>",
  );
  writeFileSync(join(clientDir, "assets", "app.js"), "console.log('ok')");
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

describe("startServer static/SPA routing (unauthenticated)", () => {
  it("returns 404 for missing asset-like paths", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/assets/missing.js`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("falls back to index.html for extension-less SPA routes without a token", async () => {
    const baseUrl = await startTestServer();
    // No Authorization header — the shell must still load so the browser can
    // read its `?_token` and authenticate subsequent /api calls.
    const response = await fetch(`${baseUrl}/sources/add`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("index-shell");
  });
});

describe("startServer startup cleanup", () => {
  it("releases the owned DB when a default-handler server stops", async () => {
    server = await startServer({ port: 0, clientDir, authToken: TOKEN });
    await server.stop();
    server = null;

    const ownership = await acquireDataDirOwnership(dataDir);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: release the proof lock even if the assertion fails
    try {
      expect(ownership.lockPath).toContain("data.db.owner-lock");
    } finally {
      await ownership.release();
    }
  });

  it("releases the owned DB if Bun.serve fails after handler boot", async () => {
    const blocker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("busy"),
    });

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: keep the busy-port blocker alive only for this assertion and always stop it
    try {
      await expect(
        startServer({
          port: blocker.port,
          hostname: "127.0.0.1",
          clientDir,
          authToken: TOKEN,
        }),
      ).rejects.toThrow();

      const ownership = await acquireDataDirOwnership(dataDir);
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: release the proof lock even if the assertion fails
      try {
        expect(ownership.lockPath).toContain("data.db.owner-lock");
      } finally {
        await ownership.release();
      }
    } finally {
      blocker.stop(true);
    }
  });
});

describe("startServer bearer auth", () => {
  it("mints and persists a 0600 auth.json when no token is supplied", async () => {
    server = await startServer({ port: 0, clientDir, handlers: testHandlers() });
    const tokenPath = join(dataDir, "server-control", "auth.json");
    expect(existsSync(tokenPath)).toBe(true);
    // Owner read/write only.
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(typeof server.authToken).toBe("string");
    expect(server.authToken.length).toBeGreaterThan(0);
  });

  it("serves /api/health without a token", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("requires the bearer token on /api", async () => {
    const baseUrl = await startTestServer();

    const unauthorized = await fetch(`${baseUrl}/api/scope`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe('Bearer realm="executor"');

    const authorized = await fetch(`${baseUrl}/api/scope`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.text()).toBe("ok");
  });

  it("requires the bearer token on /mcp", async () => {
    const baseUrl = await startTestServer();

    const unauthorized = await fetch(`${baseUrl}/mcp`, { method: "POST" });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authorized.status).toBe(200);
  });

  it("leaves the OAuth provider callback unauthenticated (state-gated)", async () => {
    const baseUrl = await startTestServer();
    // Reaches the api handler ("ok") rather than a 401 — the callback path is
    // exempt because the external provider browser can't carry the bearer.
    const response = await fetch(`${baseUrl}/api/oauth/callback?state=abc`);
    expect(response.status).toBe(200);
  });

  it("serves the CIMD client metadata document without a bearer", async () => {
    const baseUrl = await startTestServer();
    const documentUrl = `${baseUrl}/api/oauth/client-id-metadata/local.json`;
    const response = await fetch(documentUrl);
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as {
      readonly client_id: string;
      readonly redirect_uris: readonly string[];
      readonly application_type: string;
    };
    expect(metadata.client_id).toBe(documentUrl);
    expect(metadata.redirect_uris).toEqual([
      "http://127.0.0.1/api/oauth/callback",
      "http://localhost/api/oauth/callback",
      "http://[::1]/api/oauth/callback",
    ]);
    expect(metadata.application_type).toBe("native");
  });

  it("requires the bearer token on the OAuth await poll", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/oauth/await/session-1`);
    expect(response.status).toBe(401);
  });

  it("auto-mints a token on a non-loopback bind instead of refusing", async () => {
    server = await startServer({
      port: 0,
      hostname: "0.0.0.0",
      clientDir,
      handlers: testHandlers(),
    });
    expect(server.authToken.length).toBeGreaterThan(0);
  });
});

describe("startServer CORS hardening", () => {
  it("reflects credentialed CORS only for allowed loopback origins", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: "http://127.0.0.1:4789" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4789");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("does not send CORS headers to a disallowed origin", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: "https://evil.example" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers browser CORS preflights before auth", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/scope`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:4789",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,b3,traceparent",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4789");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-headers")).toContain("traceparent");
  });
});
