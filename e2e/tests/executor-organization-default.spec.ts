/** The default Executor app targets its managed key's organization when agents omit it. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { managementApp } from "../support/management-app.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { scenarios } from "../test-plan.ts";

const Organization = Schema.Struct({
  type: Schema.Literal("string"),
  description: Schema.String,
  default: Schema.String,
});
const ListTool = Schema.Struct({
  inputSchema: Schema.Struct({
    required: Schema.optional(Schema.Array(Schema.String)),
    properties: Schema.Struct({
      path: Schema.Struct({
        required: Schema.Array(Schema.String),
        properties: Schema.Struct({ organization: Schema.Unknown }),
      }),
    }),
  }),
});

layer(HostedLive, { excludeTestServices: true })("Executor organization default", (it) => {
  it.effect(scenarios.executorOrganizationDefault.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const { app, profile } = yield* managementApp(actors.owner);
        const path = `/api/organizations/${actors.organization.id}/apps/${app.id}`;

        const tool = yield* body(
          ListTool,
          yield* api.request(
            actors.owner,
            "GET",
            `${path}/tools/queries.appManagement_list?profile=${profile.id}`,
          ),
        );
        expect(tool.inputSchema.required ?? []).not.toContain("path");
        expect(tool.inputSchema.properties.path.required).not.toContain("organization");
        const organization = yield* Schema.decodeUnknownEffect(Organization)(
          tool.inputSchema.properties.path.properties.organization,
        ).pipe(Effect.orElseSucceed(() => undefined));
        expect(organization?.default).toBe(actors.organization.id);
        expect(organization?.description).toContain("context_get");

        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorize;
        yield* Effect.addFinalizer(() => oauth.revoke(grant).pipe(Effect.orDie));
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "executor-organization-default",
        );
        const called = yield* client.use(
          "List apps through the Executor app without an organization",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(profile.id)}].queries.appManagement_list({});`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Literal("completed"),
            execution: Schema.Struct({
              ok: Schema.Literal(true),
              value: Schema.Array(Schema.Struct({ id: Schema.String })),
            }),
          }),
        )(called.structuredContent).pipe(
          Effect.mapError(
            (error) => new Error(`${error.message}\n${JSON.stringify(called.structuredContent)}`),
          ),
        );
        expect(result.execution.value.map((item) => item.id)).toContain(app.id);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
