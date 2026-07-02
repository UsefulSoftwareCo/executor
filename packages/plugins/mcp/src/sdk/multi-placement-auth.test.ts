// ---------------------------------------------------------------------------
// MCP multi-placement auth (wire-level)
//
// The extreme case the unified model exists for: ONE auth method that mixes a
// bearer HEADER and a team-id QUERY PARAM, each rendered from its own
// credential input — plus the single-placement query case (servers like ui.sh
// authenticate via `?token=`), and the explicit failure when an input is
// missing. Methods are authored request-shaped (the one input dialect); assertions are
// made against what the server actually RECEIVED.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { mcpPlugin } from "./plugin";
import { variable } from "@executor-js/sdk/http-auth";
import { makeEchoMcpServer, serveMcpServer } from "../testing";

const serveRecordingServer = serveMcpServer(() =>
  makeEchoMcpServer({
    name: "multi-auth-test",
    toolName: "whoami",
    toolDescription: "Echoes a marker so the test can prove the invoke reached the server",
    inputName: "marker",
    text: (marker) => `ok:${marker}`,
  }),
);

describe("MCP multi-placement auth", () => {
  it.effect("one method renders a bearer header AND a team-id query param", () =>
    Effect.gen(function* () {
      const server = yield* serveRecordingServer;
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
      );

      yield* executor.mcp.addServer({
        name: "Mixed MCP",
        endpoint: server.url,
        slug: "mixed_mcp",
        authenticationTemplate: [
          {
            slug: "token_and_team",
            type: "apiKey",
            headers: { Authorization: ["Bearer ", variable("api_token")] },
            queryParams: { team_id: [variable("team_id")] },
          },
        ],
      });

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("mixed_mcp"),
        template: AuthTemplateSlug.make("token_and_team"),
        values: { api_token: "tok_A", team_id: "team_B" },
      });

      const before = (yield* server.requests).length;
      const result = yield* executor.execute(
        ToolAddress.make("tools.mixed_mcp.org.main.whoami"),
        { marker: "mixed" },
        { onElicitation: "accept-all" },
      );
      expect(result).toMatchObject({
        ok: true,
        data: { content: [{ type: "text", text: "ok:mixed" }] },
      });

      const requests = (yield* server.requests).slice(before);
      expect(requests.length).toBeGreaterThan(0);
      // BOTH carriers rendered, each from its own credential input.
      expect(requests.every((request) => request.authorization === "Bearer tok_A")).toBe(true);
      expect(requests.every((request) => request.url.includes("team_id=team_B"))).toBe(true);
    }),
  );

  it.effect("a query-only method renders ?token= and no Authorization header (ui.sh)", () =>
    Effect.gen(function* () {
      const server = yield* serveRecordingServer;
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
      );

      yield* executor.mcp.addServer({
        name: "Query MCP",
        endpoint: server.url,
        slug: "query_mcp",
        authenticationTemplate: [{ type: "apiKey", queryParams: { token: [variable("token")] } }],
      });

      // Slug-less single-query-placement methods get the `query` slug.
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("query_mcp"),
        template: AuthTemplateSlug.make("query"),
        value: "tok_secret_123",
      });

      const before = (yield* server.requests).length;
      const result = yield* executor.execute(
        ToolAddress.make("tools.query_mcp.org.main.whoami"),
        { marker: "qconn" },
        { onElicitation: "accept-all" },
      );
      expect(result).toMatchObject({ ok: true });

      const requests = (yield* server.requests).slice(before);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((request) => request.url.includes("token=tok_secret_123"))).toBe(true);
      expect(requests.every((request) => request.authorization === undefined)).toBe(true);
    }),
  );

  it.effect("a connection binding one method does not leak into another method's shape", () =>
    Effect.gen(function* () {
      const server = yield* serveRecordingServer;
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
      );

      // Two declared methods; each connection picks one by template slug.
      yield* executor.mcp.addServer({
        name: "Multi MCP",
        endpoint: server.url,
        slug: "multi_mcp",
        authenticationTemplate: [
          {
            slug: "bearer",
            type: "apiKey",
            headers: { Authorization: ["Bearer ", variable("token")] },
          },
          {
            slug: "query_token",
            type: "apiKey",
            queryParams: { auth_token: [variable("token")] },
          },
        ],
      });

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("hconn"),
        integration: IntegrationSlug.make("multi_mcp"),
        template: AuthTemplateSlug.make("bearer"),
        value: "header-secret",
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("qconn"),
        integration: IntegrationSlug.make("multi_mcp"),
        template: AuthTemplateSlug.make("query_token"),
        value: "query-secret",
      });

      const beforeHeader = (yield* server.requests).length;
      yield* executor.execute(
        ToolAddress.make("tools.multi_mcp.org.hconn.whoami"),
        { marker: "h" },
        { onElicitation: "accept-all" },
      );
      const headerRequests = (yield* server.requests).slice(beforeHeader);
      expect(headerRequests.every((r) => r.authorization === "Bearer header-secret")).toBe(true);
      expect(headerRequests.every((r) => !r.url.includes("auth_token="))).toBe(true);

      const beforeQuery = (yield* server.requests).length;
      yield* executor.execute(
        ToolAddress.make("tools.multi_mcp.org.qconn.whoami"),
        { marker: "q" },
        { onElicitation: "accept-all" },
      );
      const queryRequests = (yield* server.requests).slice(beforeQuery);
      expect(queryRequests.every((r) => r.url.includes("auth_token=query-secret"))).toBe(true);
      expect(queryRequests.every((r) => r.authorization === undefined)).toBe(true);
    }),
  );

  it.effect("invoking with a missing credential input fails explicitly, not silently", () =>
    Effect.gen(function* () {
      const server = yield* serveRecordingServer;
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
      );

      yield* executor.mcp.addServer({
        name: "Strict MCP",
        endpoint: server.url,
        slug: "strict_mcp",
        authenticationTemplate: [
          {
            slug: "two_inputs",
            type: "apiKey",
            headers: { Authorization: ["Bearer ", variable("a")] },
            queryParams: { team_id: [variable("b")] },
          },
        ],
      });

      // Only one of the two inputs is supplied.
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("half"),
        integration: IntegrationSlug.make("strict_mcp"),
        template: AuthTemplateSlug.make("two_inputs"),
        values: { a: "tok_A" },
      });

      const result = (yield* executor.execute(
        ToolAddress.make("tools.strict_mcp.org.half.whoami"),
        { marker: "x" },
        { onElicitation: "accept-all" },
      )) as { ok: boolean; error?: { code?: string; message?: string } };
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({ code: "connection_value_missing" });
      expect(String(result.error?.message ?? "")).toContain("b");
    }),
  );
});
