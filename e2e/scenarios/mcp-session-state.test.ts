// Cross-target: downstream MCP session continuity — the "an agent can use a
// stateful MCP server" promise. Servers like Render's MCP key state by
// Mcp-Session-Id (select_workspace, then every later call reads the
// selection). If executor dials a fresh downstream connection per tool call,
// every call lands in a brand-new session: select_workspace succeeds, and the
// very next call reports no workspace selected. This scenario drives that
// journey against a session-stateful MCP fixture and asserts state set by one
// tool call is visible to the next call in the same execution.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);

const freshSlug = (prefix: string): string => `${prefix}_${randomBytes(4).toString("hex")}`;

// A session-stateful MCP server, shaped like Render's workspace selection:
// `select_workspace` stores the choice in the session (each MCP session gets
// its own server instance from the factory, exactly like state keyed by
// Mcp-Session-Id), and `get_workspace` answers from that same session state.
const makeSessionStatefulMcpServer = () => () => {
  const server = new McpServer(
    { name: "session-stateful-test-server", version: "1.0.0" },
    { capabilities: {} },
  );
  // Per-session: lives in this server instance, created per MCP session.
  let selected: string | null = null;

  server.registerTool(
    "select_workspace",
    {
      description: "Selects the workspace for this MCP session",
      inputSchema: {},
    },
    async () => {
      selected = "ws-e2e";
      return { content: [{ type: "text" as const, text: "selected:ws-e2e" }] };
    },
  );

  server.registerTool(
    "get_workspace",
    {
      description: "Returns the workspace selected earlier in this MCP session",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: selected === null ? "no workspace selected" : `workspace:${selected}`,
        },
      ],
    }),
  );

  return server;
};

// One sandbox execution, two dependent tool calls — the smallest agent journey
// that relies on downstream session state.
const selectThenReadCode = (slug: string) => `
const selected = await tools.${slug}.org.main.select_workspace({});
const read = await tools.${slug}.org.main.get_workspace({});
return JSON.stringify({ selected, read });
`;

scenario(
  "MCP · session state set by one tool call is visible to the next call",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const slug = freshSlug("mcp_state");

      const server = yield* serveMcpServer(makeSessionStatefulMcpServer());

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Session-stateful MCP",
          endpoint: server.url,
          slug,
          remoteTransport: "streamable-http",
        },
      });

      yield* Effect.gen(function* () {
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("none"),
            value: "",
          },
        });

        // Only observe the execution's own traffic, not discovery's.
        yield* server.clearRequests;

        const executed = yield* client.executions.execute({
          payload: { code: selectThenReadCode(slug), autoApprove: true },
        });
        expect(executed.status, "the two-call execution completed").toBe("completed");

        // THE promise: the selection made by the first call is what the second
        // call reads. A per-call connection lands the second call in a fresh
        // downstream session, which answers "no workspace selected".
        expect(executed.text, "the first call selected the workspace").toContain("selected:ws-e2e");
        expect(executed.text, "the second call sees the same session's selection").toContain(
          "workspace:ws-e2e",
        );

        // Wire-level corroboration from the fixture's request ledger: every
        // session-bound request of this execution carried ONE Mcp-Session-Id.
        const sessionIds = new Set(
          (yield* server.requests)
            .map((request) => request.sessionId)
            .filter(Predicate.isNotUndefined),
        );
        expect([...sessionIds].length, "both tool calls rode a single downstream MCP session").toBe(
          1,
        );
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* client.connections
              .remove({
                params: {
                  owner: "org",
                  integration: IntegrationSlug.make(slug),
                  name: ConnectionName.make("main"),
                },
              })
              .pipe(Effect.ignore);
            yield* client.mcp
              .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
              .pipe(Effect.ignore);
          }),
        ),
      );
    }),
  ),
);
