import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { deployMcpApp } from "../support/mcp-app.ts";
import { McpClient } from "../support/mcp-client.ts";
import { serverControl } from "../support/server-control.ts";

const Key = Schema.Struct({
  id: Schema.String,
  key: Schema.RedactedFromValue(Schema.NonEmptyString),
  metadata: Schema.Struct({ organization: Schema.String, scope: Schema.optional(Schema.String) }),
});
const Execution = Schema.Struct({
  execution: Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
    Schema.Struct({ ok: Schema.Literal(false) }),
  ]),
});

layer(HostedLive, { excludeTestServices: true })("Tools-only keys", (it) => {
  it.effect(scenarios.toolsOnlyApiKeys.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const anonymous = yield* api.session();
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const lifecycle = "/api/auth/api-key";
        const { app, receipt } = yield* deployMcpApp;
        const keys: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            keys,
            (keyId) => api.request(actors.owner, "POST", `${lifecycle}/delete`, { keyId }),
            { discard: true },
          ).pipe(Effect.orDie),
        );
        const create = (tools: boolean) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${lifecycle}/create`, {
              name: tools ? "Tools-only client" : "Existing client",
              metadata: { organization, ...(tools ? { scope: "tools" } : {}) },
            });
            expect(response.status).toBe(200);
            const key = yield* body(Key, response);
            keys.push(key.id);
            return key;
          });
        const scoped = yield* create(true);
        const legacy = yield* create(false);
        expect(scoped.metadata).toEqual({ organization, scope: "tools" });
        expect(Redacted.value(scoped.key).startsWith("ext_")).toBe(true);
        expect(Redacted.value(legacy.key).startsWith("exp_")).toBe(true);
        const headers = (key: typeof Key.Type) => ({
          authorization: `Bearer ${Redacted.value(key.key)}`,
        });
        const call = (key: typeof Key.Type) =>
          api.request(
            anonymous,
            "POST",
            `${prefix}/apps/${app.id}/tools/call`,
            { tool: "echo", kind: "mutation", input: { message: "scoped client" } },
            headers(key),
          );
        yield* evidence.step(
          "A tools-only key discovers and executes while refusing administration",
          Effect.gen(function* () {
            expect(
              (yield* api.request(
                anonymous,
                "GET",
                `${prefix}/inventory`,
                undefined,
                headers(scoped),
              )).status,
            ).toBe(200);
            expect((yield* call(scoped)).body).toEqual({ message: "scoped client", receipt });
            for (const suffix of [
              `/apps/${app.id}/source`,
              `/apps/${app.id}/versions`,
              `/apps/${app.id}/workspace`,
            ]) {
              expect(
                (yield* api.request(
                  anonymous,
                  "GET",
                  `${prefix}${suffix}`,
                  undefined,
                  headers(scoped),
                )).status,
              ).toBe(403);
            }
            expect(
              (yield* api.request(
                anonymous,
                "DELETE",
                `${prefix}/apps/${app.id}`,
                undefined,
                headers(scoped),
              )).status,
            ).toBe(403);
            expect(
              (yield* api.request(
                anonymous,
                "POST",
                `${lifecycle}/create`,
                { name: "Must not widen" },
                headers(scoped),
              )).status,
            ).toBe(403);
            expect(
              (yield* api.request(
                anonymous,
                "GET",
                "/api/organizations/another-organization/inventory",
                undefined,
                headers(scoped),
              )).status,
            ).toBe(403);
            expect(
              (yield* api.request(
                anonymous,
                "GET",
                `${prefix}/apps/${app.id}/source`,
                undefined,
                headers(legacy),
              )).status,
            ).toBe(200);
            expect(
              (yield* api.request(actors.owner, "POST", `${lifecycle}/create`, {
                name: "Invalid scope",
                metadata: { organization, scope: "manage" },
              })).status,
            ).toBe(400);
          }),
        );
        const client = yield* mcp.connect(scoped.key, "tools-only-key");
        const execute = (code: string) =>
          client.use("Call tools using the scoped key", (client, signal) =>
            client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
          );
        yield* evidence.step(
          "The same key executes over MCP and refuses a revoked active connection",
          Effect.gen(function* () {
            const result = yield* execute(
              `return await tools[${JSON.stringify(app.slug)}].echo({ message: "scoped client" })`,
            );
            expect(
              (yield* Schema.decodeUnknownEffect(Execution)(result.structuredContent)).execution,
            ).toEqual({ ok: true, value: { message: "scoped client", receipt } });
            expect(
              (yield* api.request(actors.owner, "POST", `${lifecycle}/delete`, {
                keyId: scoped.id,
              })).status,
            ).toBe(200);
            expect((yield* call(scoped)).status).toBe(401);
            const denied = yield* Effect.result(
              execute(
                `return await tools[${JSON.stringify(app.slug)}].echo({ message: "revoked" })`,
              ),
            );
            expect(denied._tag).toBe("Failure");
            expect((yield* call(legacy)).status).toBe(200);
          }),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolsOnlyApiKeyRestart.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const anonymous = yield* api.session();
        const organization = actors.organization.id;
        const lifecycle = "/api/auth/api-key";
        const created = yield* api.request(actors.owner, "POST", `${lifecycle}/create`, {
          name: "Expiring tools client",
          expiresIn: 60,
          metadata: { organization, scope: "tools" },
        });
        expect(created.status).toBe(200);
        const key = yield* body(Key, created);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", `${lifecycle}/delete`, { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const inventory = api.request(
          anonymous,
          "GET",
          `/api/organizations/${organization}/inventory`,
          undefined,
          { authorization: `Bearer ${Redacted.value(key.key)}` },
        );
        expect((yield* inventory).status).toBe(200);
        yield* serverControl("restart");
        expect((yield* inventory).status).toBe(200);
        yield* serverControl("stop");
        yield* serverControl("clock/advance", 200, { milliseconds: 61_000 });
        yield* serverControl("start");
        expect((yield* inventory).status).toBe(401);
      }),
    ),
  );
});
