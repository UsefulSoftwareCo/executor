/** An agent adding an MCP server learns safely when it must write the app itself. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { frameworkSession } from "../support/framework.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";

const Failure = Schema.Struct({
  _tag: Schema.Literal("CatalogImportFailed"),
  code: Schema.String,
  reason: Schema.String,
});

layer(HostedLive, { excludeTestServices: true })("Import diagnostics", (it) => {
  it.effect(scenarios.importDiagnostics.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          issuer = yield* oauthSetupIssuer;
        // The server rejects anonymous use and advertises no OAuth: an API key or other setup.
        yield* issuer.configure({ challenge: false, postChallenge: true, discovery: "missing" });
        const url = `${issuer.origin}/mcp`;
        const path = `/api/organizations/${actors.organization.id}/apps/import`;
        const response = yield* api.request(actors.owner, "POST", path, {
          source: { kind: "mcp", name: "Import diagnostics", url },
        });
        expect(response.status).toBe(422);
        expect(JSON.stringify(response.body)).not.toContain(issuer.origin);
        const failure = yield* body(Failure, response);
        expect(failure.code).toBe("agent_setup_required");
        expect(failure.reason).toContain("add it with your agent");

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
          await ${tool.path}(${JSON.stringify({ path: { organization: actors.organization.id }, body: { source: { kind: "mcp", name: "MCP import diagnostics", url } } })});
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
        expect(outcome.message).toContain("agent_setup_required");
        expect(outcome.message).toContain("add it with your agent");
        expect(outcome.message).not.toContain(issuer.origin);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
