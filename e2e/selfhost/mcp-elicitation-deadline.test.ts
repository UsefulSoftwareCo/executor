import { randomBytes } from "node:crypto";
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);
const decodeExecutionId = Schema.decodeUnknownSync(Schema.String);

scenario(
  "MCP · delayed approval preserves the chosen lifetime beyond the active-work deadline",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const slug = IntegrationSlug.make(`deadline_${randomBytes(4).toString("hex")}`);
      const server = yield* serveMcpServer(() => {
        const upstream = new McpServer({ name: "Human approval", version: "1" });
        upstream.registerTool("approve", { inputSchema: {} }, async () => {
          const reply = await upstream.server.elicitInput(
            {
              mode: "form",
              message: "Approve the delayed call?",
              requestedSchema: { type: "object", properties: {} },
              _meta: { persist: ["session", "always"] },
            },
            { timeout: 150_000 },
          );
          return {
            content: [
              { type: "text", text: `decision:${reply.action}:${reply._meta?.persist ?? "once"}` },
            ],
          };
        });
        return upstream;
      });
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Human approval",
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
            integration: slug,
            template: AuthTemplateSlug.make("none"),
            value: "",
          },
        });
        const session = mcp.session(identity, { elicitationMode: "model" });
        yield* session.listTools();
        const paused = yield* session.call("execute", {
          code: `return await tools.${slug}.org.main.approve({});`,
        });
        expect(paused.text).toContain("executionId:");
        // Cross the production 60-second active-work deadline. This is the
        // behavior under test: a human waiting must consume none of that budget.
        yield* Effect.sleep("65 seconds");
        const executionId = decodeExecutionId(/\bexecutionId:\s*(\S+)/.exec(paused.text)?.[1]);
        const completed = yield* session.call("resume", {
          executionId,
          action: "accept",
          persist: "session",
        });
        expect(completed.ok).toBe(true);
        expect(completed.text).toContain("decision:accept:session");
      }).pipe(Effect.ensuring(client.mcp.removeServer({ params: { slug } }).pipe(Effect.orDie)));
    }),
  ),
);
