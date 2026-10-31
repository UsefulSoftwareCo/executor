/** Empty MCP searches use the hosted analytics sink without exporting the query. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { awaitAnalytics } from "../support/instance-analytics.ts";
import { McpClient } from "../support/mcp-client.ts";
import { appsManifest } from "../support/apps-release.ts";

const Page = Schema.Struct({ items: Schema.Array(Schema.Unknown) });
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Page }),
});

layer(HostedLive, { excludeTestServices: true })("MCP search analytics", (it) => {
  it.effect(scenarios.mcpSearchAnalytics.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Search analytics",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: "Search analytics",
            files: [
              appsManifest,
              {
                path: "index.ts",
                content: `import { defineApp, query, object, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
  echo: query({ input: object({}) }, async () => "echo"),
}) }));`,
              },
            ],
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "search-analytics", {
          organization: actors.organization.id,
        });
        const call = (name: string, args: Record<string, unknown>) =>
          client.use(`MCP ${name}`, (client, signal) =>
            client.callTool({ name, arguments: args }, undefined, { signal }),
          );
        const search = (args: Record<string, unknown>) =>
          call("search", { namespace: app.slug, ...args }).pipe(
            Effect.flatMap((result) => Schema.decodeUnknownEffect(Page)(result.structuredContent)),
          );
        // Browsing, matches and pagination are not new unmet searches.
        expect((yield* search({})).items).toHaveLength(1);
        expect((yield* search({ query: "   " })).items).toHaveLength(1);
        expect((yield* search({ query: "echo" })).items).toHaveLength(1);
        expect((yield* search({ query: "echo", offset: 50 })).items).toEqual([]);
        const query = "PRIVATE_QUOKKAZEBRANOMATCH_CANARY";
        expect((yield* search({ query })).items).toEqual([]);
        const nested = yield* call("execute", {
          code: `return await tools.search(${JSON.stringify({ namespace: app.slug, query })});`,
        });
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(nested.structuredContent)).execution.value
            .items,
        ).toEqual([]);
        // A later operation fences delivery of the searches, including the absence checks.
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/feedback`, {
            message: "Search analytics delivery fence",
          })).status,
        ).toBe(200);
        const { text, events } = yield* awaitAnalytics((events) =>
          events.some(
            (event) =>
              event.event === "product_operation_completed" && event.properties.area === "feedback",
          ),
        );
        const empty = events.filter((event) => event.event === "tool_search_empty");
        expect(empty).toHaveLength(2);
        for (const event of empty)
          expect(event.properties).toMatchObject({
            source: "mcp",
            client_name: "executor-e2e",
            result_count: 0,
          });
        expect(text).not.toContain(query);
        expect(text).not.toContain("QUOKKAZEBRANOMATCH");
        expect(text).not.toContain(app.id);
        expect(text).not.toContain(actors.organization.id);
        yield* (yield* Evidence).json("empty-search-events.json", empty);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
