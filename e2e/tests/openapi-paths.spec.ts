import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { randomUUID } from "node:crypto";
import { openapiAppFiles } from "../support/authored-templates.ts";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { openapiPathUpstream } from "../support/openapi-path-upstream.ts";

layer(HostedLive, { excludeTestServices: true })("OpenAPI paths", (it) => {
  it.effect(scenarios.openapiPaths.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const upstream = yield* openapiPathUpstream;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Restricted path tools",
          files: openapiAppFiles("Restricted path tools", {
            url: `${upstream.origin}/openapi.json`,
            allowedOrigin: upstream.origin,
            baseUrl: `${upstream.origin}/v2/`,
            securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Fixture-Key" } },
            key: "key",
          }),
        });
        expect(imported.status, JSON.stringify(imported.body)).toBe(200);
        const app = yield* body(App, imported),
          path = `${prefix}/apps/${app.id}`;
        const profile = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/profiles`, {
            accounts: { service: [] },
            idempotencyKey: randomUUID(),
          }),
        );
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/connections`, {
            requirement: "service",
            profile: profile.id,
          }),
        );
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          {
            method: "apiKey",
            label: "Synthetic upstream key",
            fields: { token: "synthetic-path-key" },
          },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const account = yield* body(Resource, saved);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", `${path}/profiles/${profile.id}`);
            yield* api.request(actors.owner, "DELETE", path);
            yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`);
          }).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorize;
        yield* Effect.addFinalizer(() => oauth.revoke(grant).pipe(Effect.orDie));
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
            id: grant.grantId,
            policy: {
              kind: "tools",
              approval: "client",
              apps: [
                {
                  app: app.id,
                  tools: {
                    kind: "selected",
                    names: [
                      "mutations.removeKey",
                      "mutations.removeArray",
                      "mutations.removeObject",
                      "mutations.removeLabel",
                    ],
                  },
                },
              ],
            },
          })).status,
        ).toBe(200);
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "restricted-paths",
        );
        const invoke = (tool: string, key: unknown) =>
          client.use(`Invoke ${tool} through the narrowed grant`, (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(profile.id)}].mutations[${JSON.stringify(tool)}](${JSON.stringify({ accountId: account.id, input: { path: { key } } })});`,
                },
              },
              undefined,
              { signal },
            ),
          );
        for (const [tool, key, wire] of [
          ["removeKey", "normal", "keys/normal"],
          ["removeArray", ["a", "b"], "arrays/a,b"],
          ["removeObject", { id: "a" }, "objects/id,a"],
          ["removeLabel", "normal", "labels/.normal"],
          ["removeKey", "%2e%2e", "keys/%252e%252e"],
        ] as const) {
          const result = yield* invoke(tool, key);
          expect(result.structuredContent, JSON.stringify(result)).toMatchObject({
            execution: { ok: true, value: { path: `/v2/projects/p/${wire}`, authenticated: true } },
          });
        }
        const before = yield* upstream.requests;
        for (const [tool, key] of [
          ["removeProject", "irrelevant"],
          ["removeAllKeys", "irrelevant"],
          ["removeKey", "."],
          ["removeKey", ".."],
          ["removeLabel", "."],
          ["removeArray", [".."]],
          ["removeKey", ""],
          ["removeArray", []],
          ["removeArray", [""]],
          ["removeObject", {}],
        ] as const) {
          const result = yield* invoke(tool, key);
          expect(
            result.structuredContent,
            `${tool} ${JSON.stringify(key)}: ${JSON.stringify(result)}`,
          ).toMatchObject({ execution: { ok: false } });
          expect(
            yield* upstream.requests,
            `${tool} ${JSON.stringify(key)} must not reach any upstream endpoint`,
          ).toEqual(before);
        }
        yield* evidence.json("restricted-openapi-requests.json", yield* upstream.requests);
        const after = yield* invoke("removeKey", "still-valid");
        expect(after.structuredContent).toMatchObject({
          execution: {
            ok: true,
            value: { path: "/v2/projects/p/keys/still-valid", authenticated: true },
          },
        });
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
