/** Outbound app MCP clients negotiate against real independent servers. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { withApps, mcpDependencies } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { mcpProtocolUpstream } from "../support/mcp-protocol-upstream.ts";
import { createProfile } from "../support/profiles.ts";

const deploy = Effect.fn("McpProtocol.deploy")(function* (url: string, timeoutMs = 10_000) {
  const api = yield* Api;
  const actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}/apps`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
    name: `MCP protocol ${randomUUID().slice(0, 8)}`,
    files: [
      {
        path: "package.json",
        content: JSON.stringify({
          dependencies: withApps(mcpDependencies),
        }),
      },
      {
        path: "index.ts",
        content: `import { defineApp } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({ accounts: {} }, async ({ signal }) => ({
  tools: await mcpRouter({ url: ${JSON.stringify(url)}, timeoutMs: ${timeoutMs}, signal }),
}));`,
      },
    ],
  });
  expect(deployed.status).toBe(200);
  const app = yield* body(App, deployed);
  const path = `${prefix}/${app.id}`;
  yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
  const profile = yield* createProfile(actors.owner, path);
  return { api, actors, app, path, profile };
});

layer(HostedLive, { excludeTestServices: true })("MCP protocol compatibility", (it) => {
  for (const [scenario, transport] of [
    [scenarios.mcpModernProtocol, "modern"],
    [scenarios.mcpLegacyProtocol, "legacy"],
    [scenarios.mcpLegacySseProtocol, "sse"],
  ] as const) {
    it.effect(scenario.title, (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const evidence = yield* Evidence;
          const upstream = yield* mcpProtocolUpstream();
          const { api, actors, path, profile } = yield* deploy(`${upstream.origin}/${transport}`);
          const listed = yield* api.request(
            actors.owner,
            "GET",
            `${path}/tools?profile=${profile.id}`,
          );
          yield* evidence.json("protocol-catalog.json", listed.body);
          expect(listed.status).toBe(200);
          const catalog = yield* body(
            Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) }),
            listed,
          );
          expect(catalog.items.map((tool) => tool.name)).toContain("echo");
          const called = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            profile: profile.id,
            tool: "echo",
            kind: "mutation",
            input: { value: transport },
          });
          yield* evidence.json("protocol-call.json", called.body);
          yield* evidence.json("protocol-requests.json", upstream.requests);
          expect(called.status).toBe(200);
          expect(called.body).toMatchObject({ structuredContent: { value: transport } });
          expect(
            upstream.requests.filter((request) => request.method === "tools/call"),
          ).toHaveLength(1);
          if (transport === "modern") {
            expect(upstream.requests.some((request) => request.method === "server/discover")).toBe(
              true,
            );
            expect(upstream.requests.some((request) => request.method === "initialize")).toBe(
              false,
            );
            expect(upstream.requests.every((request) => request.protocol === "2026-07-28")).toBe(
              true,
            );
            expect(new Set(upstream.requests.map((request) => request.runtime)).size).toBe(2);
          } else {
            expect(upstream.requests.some((request) => request.method === "initialize")).toBe(true);
            if (transport === "sse")
              expect(upstream.requests.some((request) => request.method === "GET")).toBe(true);
          }
        }),
      ),
    );
  }
  for (const [scenario, route] of [
    [scenarios.mcpNegotiationTimeout, "stall"],
    [scenarios.mcpFallbackTimeout, "fallback-stall"],
  ] as const) {
    it.effect(scenario.title, (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const upstream = yield* mcpProtocolUpstream();
          const evidence = yield* Evidence;
          const { api, actors, path, profile } = yield* deploy(`${upstream.origin}/${route}`, 500);
          const listed = yield* api.request(
            actors.owner,
            "GET",
            `${path}/tools?profile=${profile.id}`,
          );
          yield* evidence.json("timed-out-catalog.json", listed.body);
          expect(listed.status).toBe(502);
          const presented = JSON.stringify(listed.body);
          if (route === "fallback-stall") {
            expect(presented).toContain("HTTP 404");
            expect(presented).toContain("Legacy SSE fallback also failed because it timed out");
          } else {
            expect(presented).toContain("did not respond");
          }
          yield* Effect.sync(() => upstream.stalled.active).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 millis"),
              until: (active) => active === 0,
            }),
            Effect.timeout("2 seconds"),
          );
          expect(upstream.stalled.closed).toBeGreaterThan(0);
          expect(upstream.stalled.active).toBe(0);
          yield* evidence.json("closed-probes.json", upstream.stalled);
        }),
      ),
    );
  }
  it.effect(scenarios.mcpModernElicitation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const upstream = yield* mcpProtocolUpstream();
        const evidence = yield* Evidence;
        const mcp = yield* McpClient;
        const { api, actors, app, profile } = yield* deploy(`${upstream.origin}/modern`);
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Modern elicitation",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "modern-elicitation", {
          organization: actors.organization.id,
          mode: "native",
        });
        const result = yield* client.use("Complete a modern upstream form", (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `return await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(profile.id)}].confirm({});`,
              },
            },
            undefined,
            { signal },
          ),
        );
        yield* evidence.json("modern-elicitation.json", result.structuredContent);
        yield* evidence.json("elicitation-requests.json", upstream.requests);
        expect(result.structuredContent).toMatchObject({
          execution: { ok: true, value: { structuredContent: { value: "accepted" } } },
        });
        expect(yield* client.elicitationCount).toBe(1);
        expect(upstream.requests.filter((request) => request.method === "tools/call")).toHaveLength(
          2,
        );
        expect(upstream.requests.some((request) => request.method === "initialize")).toBe(false);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
