import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "@effect/vitest";
import { Schema } from "effect";

const dir = mkdtempSync(join(tmpdir(), "executor-usage-http-"));
process.env.EXECUTOR_DATA_DIR = dir;
process.env.BETTER_AUTH_SECRET = "usage-test-secret-0123456789-abcdefghij-klmnop";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@usage.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

const decodeResponse = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeSummary = Schema.decodeUnknownSync(
  Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({ mcp_tool: Schema.String, calls: Schema.Number, blocked: Schema.Number }),
    ),
    losses: Schema.Struct({ dropped_events: Schema.Number }),
  }),
);

it("records authenticated HTTP passthrough calls and exposes a read-only CLI summary", async () => {
  const { makeSelfHostApiHandler } = await import("../app");
  const app = await makeSelfHostApiHandler({ dbPath: join(dir, "usage.db") });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: always close the full app before reading its SQLite file
  try {
    const login = await app.handler(
      new Request("http://localhost:4788/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@usage.test", password: "admin-pass-123456" }),
      }),
    );
    expect(login.status).toBe(200);
    const token = login.headers.get("set-auth-token")!;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const init = await app.handler(
      new Request("http://localhost:4788/mcp?mode=passthrough&artifacts=0", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "usage-test", version: "1" },
          },
        }),
      }),
    );
    expect(init.status).toBe(200);
    await init.text();
    const sessionHeaders = { ...headers, "mcp-session-id": init.headers.get("mcp-session-id")! };
    const call = async (id: number, name: string, args: object) => {
      const response = await app.handler(
        new Request("http://localhost:4788/mcp", {
          method: "POST",
          headers: sessionHeaders,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
      );
      expect(response.status).toBe(200);
      return decodeResponse(await response.json());
    };
    await call(2, "search", { query: "argument-secret" });
    await call(3, "search", { query: "argument-secret" });
    const denied = await call(4, "invoke", {
      tool: "tools.sample.org.test.read",
      arguments: { secret: "invoke-secret" },
    });
    expect(JSON.stringify(denied)).toContain("Tool not found or blocked by policy");
    await call(5, "integrations", {});
    await call(6, "skills", {});
  } finally {
    await app.dispose();
  }
  const output = execFileSync(
    "bun",
    ["run", resolve("scripts/tool-usage-summary.ts"), "--db", join(dir, "usage.db")],
    { encoding: "utf8" },
  );
  const summary = decodeJson(output);
  const decoded = decodeSummary(summary);
  expect(decoded.tools.find((tool) => tool.mcp_tool === "search")!.calls).toBe(2);
  expect(decoded.tools.find((tool) => tool.mcp_tool === "invoke")!.blocked).toBe(1);
  expect(decoded.tools.reduce((count, tool) => count + tool.calls, 0)).toBe(5);
  expect(decoded.losses.dropped_events).toBe(0);
  expect(output).not.toMatch(/argument-secret|invoke-secret|admin@usage.test|admin-pass/);
  rmSync(dir, { recursive: true, force: true });
});
