import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { serveModernOnlyMcp } from "../src/fixtures/modern-only-mcp";
import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);
const LEGACY_PROTOCOL_VERSION = "2025-03-26";

const legacyInitialize = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "executor-e2e-negative-control", version: "1.0.0" },
  },
};

scenario(
  "MCP outbound · Executor discovers and invokes a modern-only server that rejects legacy",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const fixture = yield* serveModernOnlyMcp();
      const slug = IntegrationSlug.make(`modern_only_${randomBytes(4).toString("hex")}`);
      const connectionName = ConnectionName.make("main");

      const legacy = yield* Effect.promise(() =>
        fetch(fixture.url, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify(legacyInitialize),
        }),
      );
      expect(legacy.status, "the fixture rejects the legacy handshake on the wire").toBe(400);
      expect(
        yield* Effect.promise(() => legacy.json()),
        "the negative control is the SDK's unsupported-version error",
      ).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32022,
          message: `Unsupported protocol version: ${LEGACY_PROTOCOL_VERSION}`,
          data: {
            requested: LEGACY_PROTOCOL_VERSION,
            supported: ["2026-07-28"],
          },
        },
      });

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Modern-only MCP",
          endpoint: fixture.url,
          slug: String(slug),
          remoteTransport: "streamable-http",
        },
      });

      yield* Effect.gen(function* () {
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: connectionName,
            integration: slug,
            template: AuthTemplateSlug.make("none"),
            value: "",
          },
        });

        const catalog = yield* client.tools.list({ query: { integration: slug } });
        expect(
          catalog.map((tool) => String(tool.name)).sort(),
          "catalog sync discovered both modern-only tools",
        ).toEqual(["modern_identity", "modern_ping"]);

        const executed = yield* client.executions.execute({
          payload: {
            code: `
const result = await tools.${String(slug)}.org.main.modern_ping({});
return { ok: result.ok, value: result.ok ? result.data : result.error };
`,
            autoApprove: true,
          },
        });
        expect(executed.status, "the invocation completed through Executor").toBe("completed");
        const outcome = JSON.parse(executed.text) as {
          readonly ok?: boolean;
          readonly value?: unknown;
        };
        expect(outcome.ok, `modern-only invocation result: ${executed.text}`).toBe(true);
        expect(
          JSON.stringify(outcome.value),
          "the modern-only server's tool result returns through the sandbox",
        ).toContain("pong-modern");
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* client.connections
              .remove({
                params: {
                  owner: "org",
                  integration: slug,
                  name: connectionName,
                },
              })
              .pipe(Effect.ignore);
            yield* client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore);
          }),
        ),
      );
    }),
  ),
);
