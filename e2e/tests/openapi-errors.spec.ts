import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import {
  openapiErrorUpstream,
  openapiSecretMarker,
  openapiMemoryMessage,
  openapiOAuthMessage,
} from "../support/openapi-error-upstream.ts";

const Failure = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      kind: Schema.String,
      message: Schema.String,
      response: Schema.optional(
        Schema.Struct({ code: Schema.String, status: Schema.Number, message: Schema.String }),
      ),
    }),
  }),
});

layer(HostedLive, { excludeTestServices: true })("OpenAPI errors", (it) => {
  it.effect(scenarios.openapiErrors.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const spec = yield* body(
          Schema.Struct({
            components: Schema.Struct({ schemas: Schema.Record(Schema.String, Schema.Unknown) }),
          }),
          yield* api.request(actors.owner, "GET", "/openapi.json"),
        );
        const memory = spec.components.schemas.BuildMemoryExceededEncoded;
        const oauthFailure = spec.components.schemas.OAuthSetupFailedEncoded;
        if (memory === undefined || oauthFailure === undefined)
          return yield* Effect.die("The public API must declare memory and OAuth failures");
        for (const schema of [memory, oauthFailure]) {
          expect(schema).toMatchObject({ properties: { message: { type: "string" } } });
          expect(schema).toHaveProperty("required", expect.arrayContaining(["_tag", "message"]));
        }
        const origin = yield* openapiErrorUpstream(memory, oauthFailure);
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        // Hosted authorization deliberately hides apps outside the caller's accessible set.
        const denied = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/app_missing-openapi-error-proof`,
        );
        expect(denied.status).toBe(403);
        expect(denied.body).toMatchObject({
          _tag: "OrganizationForbidden",
          message:
            "Your current membership or role does not allow this action in this organization.",
        });
        yield* evidence.json("http-error-message.json", denied.body);
        const imported = yield* api.request(actors.owner, "POST", `${prefix}/import`, {
          source: {
            kind: "openapi",
            name: "OpenAPI error proof",
            url: `${origin}/openapi.json`,
            baseUrl: origin,
          },
        });
        expect(imported.status, JSON.stringify(imported.body)).toBe(200);
        const app = yield* body(App, imported);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorize;
        yield* Effect.addFinalizer(() => oauth.revoke(grant).pipe(Effect.orDie));
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "openapi-errors",
        );
        const invoke = (mode: string) =>
          client.use(`Call ${mode} through OpenAPI and MCP`, (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(app.slug)}].queries.fail({query:{mode:${JSON.stringify(mode)}}});`,
                },
              },
              undefined,
              { signal },
            ),
          );
        const known = yield* invoke("known");
        yield* evidence.json("openapi-memory-error.json", known);
        const error = (yield* Schema.decodeUnknownEffect(Failure)(known.structuredContent))
          .execution.error;
        expect(error.kind).toBe("ToolFailure");
        expect(error.response?.code).toBe("BuildMemoryExceeded");
        expect(error.response?.status).toBe(422);
        expect(error.response?.message).toBe(openapiMemoryMessage);
        expect(error.message).toContain("BuildMemoryExceeded");
        expect(error.message).toContain(openapiMemoryMessage);
        expect(JSON.stringify(known)).not.toContain(openapiSecretMarker);
        const dynamic = yield* invoke("dynamic");
        expect(dynamic.structuredContent).toMatchObject({
          execution: {
            ok: false,
            error: {
              response: {
                code: "OAuthSetupFailed",
                status: 422,
                message: openapiOAuthMessage,
              },
            },
          },
        });
        const extras = yield* invoke("extras");
        expect(extras.structuredContent).toMatchObject({
          execution: {
            ok: false,
            error: {
              response: {
                code: "Conflict",
                status: 422,
                message: "Read the current revision before saving again.",
              },
            },
          },
        });
        expect(JSON.stringify(extras)).not.toContain(openapiSecretMarker);
        // The interpreter only exposes Error.message inside catch; its JSON envelope retains the same fields.
        const caught = yield* client.use(
          "Catch the declared API error in agent code",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `try { await tools[${JSON.stringify(app.slug)}].queries.fail({query:{mode:"known"}}); } catch(error) { return JSON.parse(error.message); }`,
                },
              },
              undefined,
              { signal },
            ),
        );
        expect(caught.structuredContent).toMatchObject({
          execution: {
            ok: true,
            value: { code: "BuildMemoryExceeded", status: 422, message: openapiMemoryMessage },
          },
        });
        for (const [input, expectedBody, contentType] of [
          [
            {
              path: { id: { role: "admin" } },
              cookie: { theme: "dark" },
              body: { ids: ["a", "b"] },
            },
            "ids=a|b",
            "application/x-www-form-urlencoded",
          ],
          [
            {
              path: { id: { role: "admin" } },
              cookie: { theme: "dark" },
              contentType: "application/json",
              body: false,
            },
            "false",
            "application/json",
          ],
        ] as const) {
          const wire = yield* client.use(
            "Call the imported Swagger request through MCP",
            (client, signal) =>
              client.callTool(
                {
                  name: "execute",
                  arguments: {
                    code: `return await tools[${JSON.stringify(app.slug)}].mutations.wire(${JSON.stringify(input)});`,
                  },
                },
                undefined,
                { signal },
              ),
          );
          yield* evidence.json(
            `swagger-${contentType.includes("json") ? "json" : "form"}-wire.json`,
            wire,
          );
          expect(wire.structuredContent, JSON.stringify(wire.structuredContent)).toMatchObject({
            execution: {
              ok: true,
              value: {
                url: "/wire/;role=admin",
                cookie: "theme=dark",
                body: expectedBody,
                contentType,
              },
            },
          });
        }
        for (const mode of [
          "unknown",
          "unsupported",
          "unsupported-response",
          "ref-sibling",
          "constrained",
          "invalid",
          "missing-message",
          "invalid-message",
          "long-message",
          "empty-message",
          "wrong-status",
          "malformed",
          "html",
          "oversized",
          "chunked",
          "slow",
          "unauthorized",
          "forbidden",
          "limited",
        ]) {
          const result = yield* invoke(mode);
          const failure = (yield* Schema.decodeUnknownEffect(Failure)(result.structuredContent))
            .execution.error;
          expect(failure.kind).toBe("ToolFailure");
          expect(failure.response).toBeUndefined();
          expect(failure.message).toBe(
            ["unauthorized", "forbidden", "limited"].includes(mode)
              ? "AppProviderFailed"
              : "ToolCallFailed",
          );
          expect(JSON.stringify(result)).not.toContain(openapiSecretMarker);
          if (["unauthorized", "forbidden", "limited"].includes(mode)) {
            const result = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/${app.id}/tools/call`,
              { tool: "queries.fail", input: { query: { mode } } },
            );
            expect(result.body).toMatchObject({
              _tag: "AppProviderFailed",
              message: expect.any(String),
              reason:
                mode === "unauthorized"
                  ? "unauthorized"
                  : mode === "limited"
                    ? "rate_limited"
                    : "rejected",
            });
          }
        }
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
