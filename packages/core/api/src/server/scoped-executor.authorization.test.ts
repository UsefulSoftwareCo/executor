import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import {
  collectTables,
  definePlugin,
  tool,
  ToolAddress,
  type AuthorizationProvider,
  type AuthorizationRequest,
} from "@executor-js/sdk";
import { createSqliteTestFumaDb } from "@executor-js/sdk/testing";

import { DbProvider } from "./executor-fuma-db";
import { HostConfig, makeScopedExecutor, PluginsProvider } from "./scoped-executor";

describe("scoped executor authorization composition", () => {
  it.effect("threads HostConfig authorizationProvider into the real scoped executor", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
      (db) =>
        Effect.gen(function* () {
          const seen: AuthorizationRequest[] = [];
          const provider: AuthorizationProvider = {
            authorize: (request) =>
              Effect.sync(() => {
                seen.push(request);
                return {
                  outcome: "allow" as const,
                  decisionId: "host-composition-allow",
                  policyRevision: "host-composition-v1",
                  reason: "test",
                };
              }),
          };
          const plugin = definePlugin(() => ({
            id: "host-authz-fixture" as const,
            storage: () => ({}),
            staticIntegrations: () => [
              {
                id: "host-authz-fixture.control",
                kind: "control" as const,
                name: "Host authz fixture",
                tools: [
                  tool({
                    name: "ping",
                    description: "ping",
                    inputSchema: Schema.toStandardSchemaV1(
                      Schema.toStandardJSONSchemaV1(Schema.Struct({})),
                    ),
                    execute: () => Effect.succeed("pong"),
                  }),
                ],
              },
            ],
          }))();

          const seams = Layer.mergeAll(
            Layer.succeed(DbProvider)(db),
            Layer.succeed(PluginsProvider)({ plugins: () => [plugin] }),
            Layer.succeed(HostConfig)({
              allowLocalNetwork: false,
              oauthCallbackPath: "/api/oauth/callback",
              authorizationProvider: provider,
            }),
          );
          const executor = yield* makeScopedExecutor("subject-1", "tenant-1", "Tenant One").pipe(
            Effect.provide(seams),
          );

          const result = yield* executor
            .execute(ToolAddress.make("host-authz-fixture.control.ping"), {})
            .pipe(Effect.ensuring(executor.close().pipe(Effect.ignore)));
          expect(result).toBe("pong");
          expect(seen).toHaveLength(1);
          expect(String(seen[0]!.identity.tenant)).toBe("tenant-1");
          expect(String(seen[0]!.identity.subject)).toBe("subject-1");
          expect(seen[0]!.operation).toBe("tool.execute");
          expect(seen[0]!.tool.address).toBe("host-authz-fixture.control.ping");
        }),
      (db) => Effect.promise(() => db.close()),
    ),
  );
});
