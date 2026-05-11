import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, type ServerInstance } from "./serve";

let clientDir: string;
let server: ServerInstance | null = null;

const startTestServer = async (): Promise<string> => {
  server = await startServer({
    port: 0,
    hostname: "127.0.0.1",
    clientDir,
    handlers: {
      api: {
        handler: async () => new Response("ok"),
        dispose: async () => {},
      },
      mcp: {
        handleRequest: async () => new Response("ok"),
        close: async () => {},
      },
    },
  });
  return `http://127.0.0.1:${server.port}`;
};

beforeEach(() => {
  clientDir = mkdtempSync(join(tmpdir(), "exec-local-serve-"));
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
  rmSync(clientDir, { recursive: true, force: true });
});

describe("startServer static/SPA routing", () => {
  it("returns 404 for missing asset-like paths", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/assets/missing.js`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("falls back to index.html for extension-less SPA routes", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/sources/add`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("index-shell");
  });
});

describe("startServer network bind auth", () => {
  it("refuses non-loopback binds without a token or password", async () => {
    await expect(
      startServer({
        port: 0,
        hostname: "0.0.0.0",
        clientDir,
        handlers: {
          api: {
            handler: async () => new Response("ok"),
            dispose: async () => {},
          },
          mcp: {
            handleRequest: async () => new Response("ok"),
            close: async () => {},
          },
        },
      }),
    ).rejects.toThrow("non-loopback host without an auth token or password");
  });

  it("requires the configured token when auth is enabled", async () => {
    server = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      clientDir,
      authToken: "test-token",
      handlers: {
        api: {
          handler: async () => new Response("ok"),
          dispose: async () => {},
        },
        mcp: {
          handleRequest: async () => new Response("ok"),
          close: async () => {},
        },
      },
    });

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const unauthorized = await fetch(`${baseUrl}/api/health`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/api/health`, {
      headers: { authorization: "Bearer test-token" },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.text()).toBe("ok");
  });
});
