/** Import diagnostics through the real hosted route and a synthetic definition host. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { importUpstream } from "../support/import-upstream.ts";
import { frameworkSession } from "../support/framework.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { scenarios } from "../test-plan.ts";

const Failure = Schema.Struct({
  _tag: Schema.Literal("CatalogImportFailed"),
  code: Schema.String,
  reason: Schema.String,
  httpStatus: Schema.optional(Schema.Int),
});

layer(HostedLive, { excludeTestServices: true })("Import diagnostics", (it) => {
  it.effect(scenarios.importDiagnostics.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          origin = yield* importUpstream;
        const path = `/api/organizations/${actors.organization.id}/apps/import`;
        const rejected = (endpoint: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", path, {
              source: {
                kind: "openapi",
                name: "Import diagnostics",
                url: `${origin}/${endpoint}`,
              },
            });
            expect(response.status).toBe(422);
            const encoded = JSON.stringify(response.body);
            expect(encoded).not.toContain("PRIVATE_");
            expect(encoded).not.toContain(origin);
            return yield* body(Failure, response);
          });
        for (const [status, action] of [
          [401, "without signing in"],
          [403, "without signing in"],
          [404, "Check the definition URL"],
          [429, "Wait before importing again"],
          [503, "Try again later"],
        ] as const) {
          const failure = yield* rejected(`status/${status}`);
          expect(failure.code).toBe("document_http");
          expect(failure.httpStatus).toBe(status);
          expect(failure.reason).toContain(action);
        }
        for (const [endpoint, code] of [
          ["json", "document_json"],
          ["yaml", "document_yaml"],
          ["version", "openapi_version"],
          ["redirect", "document_redirect"],
          ["missing-location", "document_redirect"],
          ["blocked", "destination_blocked"],
        ] as const) {
          const failure = yield* rejected(endpoint);
          expect(failure.code).toBe(code);
          expect(failure.httpStatus).toBeUndefined();
        }
        const { execute, profile } = yield* frameworkSession;
        const discovered = yield* execute(
          'return await tools.search({query: "importCustom", limit: 10});',
        ).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                items: Schema.Array(Schema.Struct({ path: Schema.String })),
              }),
            ),
          ),
        );
        const tool = discovered.items.find(
          ({ path }) => path.includes(profile.id) && path.endsWith(".mutations.apps_importCustom"),
        );
        if (tool === undefined) return yield* Effect.die("Management import tool missing");
        const outcome = yield* execute(`try {
          await ${tool.path}(${JSON.stringify({ path: { organization: actors.organization.id }, body: { source: { kind: "openapi", name: "MCP import diagnostics", url: `${origin}/status/401` } } })});
          return { unexpectedSuccess: true };
        } catch (error) { return JSON.parse(error.message); }`).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                code: Schema.Literal("CatalogImportFailed"),
                status: Schema.Literal(422),
                message: Schema.String,
              }),
            ),
          ),
        );
        expect(outcome.message).toContain("without signing in");
        expect(outcome.message).toContain("document_http");
        expect(outcome.message).toContain("HTTP 401");
        expect(outcome.message).not.toContain("PRIVATE_");
        expect(outcome.message).not.toContain(origin);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
