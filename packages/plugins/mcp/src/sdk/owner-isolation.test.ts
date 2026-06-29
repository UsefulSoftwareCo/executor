// ---------------------------------------------------------------------------
// MCP owner isolation (v2)
//
// Replaces the v1 scope-stack per-user / cross-user isolation suites. v2 has no
// scope stack: an org connection and a user connection on the same integration
// produce DISTINCT tool addresses (`tools.<int>.org.<conn>.<tool>` vs
// `tools.<int>.user.<conn>.<tool>`) and resolve to DISTINCT credential values.
// This test pins that each address dials the server with its own connection's
// value applied through the integration's header auth template.
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
import { makeEchoMcpServer, serveMcpServer } from "../testing";

const INTEG = IntegrationSlug.make("iso_mcp");
const TEMPLATE = AuthTemplateSlug.make("bearer");

const createAuthRecordingMcpServer = () =>
  makeEchoMcpServer({
    name: "iso-test",
    toolName: "whoami",
    toolDescription: "Echoes a marker so the test can prove the invoke reached the server",
    inputName: "marker",
    text: (marker) => `ok:${marker}`,
  });

const serveAuthRecordingMcpServer = serveMcpServer(createAuthRecordingMcpServer);

describe("MCP owner isolation", () => {
  it.effect("org and user connections resolve distinct values through the header template", () =>
    Effect.gen(function* () {
      const server = yield* serveAuthRecordingMcpServer;
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
      );

      // One integration with a Bearer header auth template; the connection's
      // value is rendered as `Authorization: Bearer <value>`.
      yield* executor.mcp.addServer({
        name: "Shared MCP",
        endpoint: server.url,
        slug: String(INTEG),
        auth: { kind: "header", headerName: "Authorization", prefix: "Bearer " },
      });

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("shared"),
        integration: INTEG,
        template: TEMPLATE,
        value: "token-org",
      });
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("mine"),
        integration: INTEG,
        template: TEMPLATE,
        value: "token-user",
      });

      // Both connections produced their own tool rows under distinct owners.
      const tools = yield* executor.tools.list();
      const orgTool = tools.find((t) => String(t.address) === "tools.iso_mcp.org.shared.whoami");
      const userTool = tools.find((t) => String(t.address) === "tools.iso_mcp.user.mine.whoami");
      expect(orgTool).toBeDefined();
      expect(userTool).toBeDefined();

      // Invoking the org address reaches the server with the org token.
      const beforeOrg = (yield* server.requests).length;
      const orgResult = yield* executor.execute(
        ToolAddress.make("tools.iso_mcp.org.shared.whoami"),
        { marker: "from-org" },
        { onElicitation: "accept-all" },
      );
      expect(orgResult).toMatchObject({
        ok: true,
        data: { content: [{ type: "text", text: "ok:from-org" }] },
      });
      expect(
        (yield* server.requests)
          .slice(beforeOrg)
          .some((request) => request.authorization === "Bearer token-org"),
      ).toBe(true);

      // Invoking the user address reaches the server with the user token —
      // never the org token.
      const beforeUser = (yield* server.requests).length;
      const userResult = yield* executor.execute(
        ToolAddress.make("tools.iso_mcp.user.mine.whoami"),
        { marker: "from-user" },
        { onElicitation: "accept-all" },
      );
      expect(userResult).toMatchObject({
        ok: true,
        data: { content: [{ type: "text", text: "ok:from-user" }] },
      });
      const userRequests = (yield* server.requests).slice(beforeUser);
      expect(userRequests.some((request) => request.authorization === "Bearer token-user")).toBe(
        true,
      );
      expect(userRequests.every((request) => request.authorization !== "Bearer token-org")).toBe(
        true,
      );
    }),
  );
});
