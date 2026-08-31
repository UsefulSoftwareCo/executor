import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createMcpConnector } from "./connection";
import { discoverTools } from "./discover";
import { serveMcpServer } from "../testing";

// ---------------------------------------------------------------------------
// Discovery-path elicitation. The connection advertises the elicitation
// capability, so a server may elicit during `tools/list` (the Codex desktop
// plugins do this for first-use approvals). Discovery has no user surface, so
// `discoverTools` must answer with a decline — not leave the request to fail
// as method-not-found — and the listing must still complete.
// ---------------------------------------------------------------------------

describe("discoverTools elicitation", () => {
  it.effect("declines an elicitation raised during tools/list and completes discovery", () =>
    Effect.gen(function* () {
      const elicitActions: string[] = [];

      const makeServer = () => {
        const server = new McpServer(
          { name: "elicit-on-list", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        server.server.setRequestHandler(ListToolsRequestSchema, async () => {
          const response = await server.server.elicitInput({
            mode: "form",
            message: "Allow listing tools?",
            requestedSchema: {
              type: "object",
              properties: { approved: { type: "boolean", title: "Approve" } },
              required: ["approved"],
            },
          });
          elicitActions.push(response.action);
          // The server still lists what it allows unapproved.
          return {
            tools: [
              {
                name: "gated_tool",
                description: "Listed even when the approval is declined",
                inputSchema: { type: "object" as const },
              },
            ],
          };
        });
        return server;
      };

      const server = yield* serveMcpServer(makeServer);
      const manifest = yield* discoverTools(
        createMcpConnector({
          transport: "remote",
          endpoint: server.url,
          remoteTransport: "streamable-http",
        }),
      );

      expect(elicitActions).toEqual(["decline"]);
      expect(manifest.tools.map((tool) => tool.toolName)).toEqual(["gated_tool"]);
    }),
  );
});
