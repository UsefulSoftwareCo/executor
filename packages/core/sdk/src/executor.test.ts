import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Predicate, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { scopedExecutorTable, textColumn } from "./core-schema";
import { ElicitationResponse } from "./elicitation";
import { ToolNotFoundError } from "./errors";
import { createExecutor } from "./executor";
import { ScopeId, SecretId } from "./ids";
import { definePlugin } from "./plugin";
import { Scope } from "./scope";
import { SourceDetectionResult } from "./types";
import {
  makeTestConfig,
  makeTestExecutor,
  memorySecretsPlugin,
  serveOAuthTestServer,
} from "./testing";

class TestPluginError extends Data.TaggedError("TestPluginError")<{
  readonly message: string;
}> {}

const testScope = Scope.make({
  id: ScopeId.make("test-scope"),
  name: "test",
  createdAt: new Date(),
});

const txSchema = {
  executor_tx_item: scopedExecutorTable("executor_tx_item", {
    value: textColumn("value"),
  }),
};

type TxItemRow = {
  readonly id: string;
  readonly scope_id: string;
  readonly value: string;
};

const txPlugin = definePlugin(() => ({
  id: "tx" as const,
  schema: txSchema,
  storage: ({ fuma }) => ({
    create: (row: TxItemRow) =>
      fuma.use("tx.item.create", (db) => db.create("executor_tx_item", row)).pipe(Effect.asVoid),
    list: () =>
      fuma.use("tx.item.list", (db) =>
        db.findMany("executor_tx_item", {
          select: ["id", "scope_id", "value"],
          orderBy: ["id", "asc"],
        }),
      ),
  }),
  extension: (ctx) => ({
    seed: (id: string, value: string, scope = String(ctx.scopes[0]!.id)) =>
      ctx.storage.create({ id, scope_id: scope, value }),
    list: () => ctx.storage.list(),
    failAfterPluginAndCoreWrites: () =>
      ctx.transaction(
        Effect.gen(function* () {
          const scope = String(ctx.scopes[0]!.id);
          yield* ctx.storage.create({
            id: "tx-row",
            scope_id: scope,
            value: "created-before-failure",
          });
          yield* ctx.core.sources.register({
            id: "tx-source",
            scope,
            kind: "test",
            name: "Tx Source",
            tools: [{ name: "run", description: "run" }],
          });
          return yield* new TestPluginError({ message: "rollback" });
        }),
      ),
    catchDuplicateCreate: () =>
      Effect.gen(function* () {
        const scope = String(ctx.scopes[0]!.id);
        yield* ctx.storage.create({ id: "dup", scope_id: scope, value: "first" });
        return yield* ctx.storage.create({ id: "dup", scope_id: scope, value: "second" }).pipe(
          Effect.as({ caught: false as const, model: null as string | null }),
          Effect.catchTag("UniqueViolationError", (error) =>
            Effect.succeed({ caught: true as const, model: error.model ?? null }),
          ),
        );
      }),
  }),
}))();

const detector = (id: string, confidence: SourceDetectionResult["confidence"]) =>
  definePlugin(() => ({
    id,
    storage: () => ({}),
    detect: () =>
      Effect.succeed(
        SourceDetectionResult.make({
          kind: id,
          confidence,
          endpoint: `https://example.com/${id}`,
          name: id,
          namespace: id,
        }),
      ),
  }))();

const schemaProbePlugin = definePlugin(() => ({
  id: "schemaProbe" as const,
  storage: () => ({}),
  extension: (ctx) => ({
    registerSource: () =>
      ctx.transaction(
        Effect.gen(function* () {
          const scope = String(ctx.scopes[0]!.id);
          yield* ctx.core.sources.register({
            id: "schema-source",
            scope,
            kind: "schema",
            name: "Schema Source",
            tools: [
              {
                name: "inspect",
                description: "inspect",
                inputSchema: {
                  type: "object",
                  properties: {
                    pet: { $ref: "#/$defs/Pet" },
                  },
                  required: ["pet"],
                },
                outputSchema: { $ref: "#/$defs/Owner" },
              },
            ],
          });
          yield* ctx.core.definitions.register({
            sourceId: "schema-source",
            scope,
            definitions: {
              Pet: {
                anyOf: [{ $ref: "#/$defs/Dog" }, { $ref: "#/$defs/Cat" }],
              },
              Dog: {
                type: "object",
                properties: {
                  collar: { $ref: "#/$defs/Collar" },
                },
              },
              Cat: {
                type: "object",
                properties: {
                  lives: { type: "number" },
                },
              },
              Collar: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
              },
              Owner: {
                type: "object",
                properties: {
                  pet: { $ref: "#/$defs/Pet" },
                },
              },
              Unused: {
                type: "object",
                properties: {
                  value: { type: "string" },
                },
              },
            },
          });
        }),
      ),
  }),
}))();

const caseSensitiveDynamicPlugin = definePlugin(() => ({
  id: "caseDynamic" as const,
  storage: () => ({}),
  extension: (ctx) => ({
    registerSource: () =>
      ctx.core.sources.register({
        id: "case_source",
        scope: String(ctx.scopes[0]!.id),
        kind: "case",
        name: "Case Source",
        tools: [{ name: "listdashboards", description: "list dashboards" }],
      }),
  }),
  invokeTool: ({ toolRow }) => Effect.succeed({ invokedToolId: toolRow.id }),
}))();

const configurableSourcePlugin = definePlugin(() => ({
  id: "configurable" as const,
  sourcePresets: [
    {
      id: "configurable-demo",
      name: "Configurable Demo",
      summary: "Demo source preset for agent and web discovery.",
      url: "https://example.com/configurable.json",
      featured: true,
    },
  ],
  storage: ({ pluginStorage }) => ({
    get: (scope: string, sourceId = "configured-source") =>
      pluginStorage.getAtScope<{ readonly header: string; readonly sourceScope: string }>({
        scope,
        collection: "source-config",
        key: sourceId,
      }),
    visible: (sourceId = "configured-source") =>
      pluginStorage.get<{ readonly header: string; readonly sourceScope: string }>({
        collection: "source-config",
        key: sourceId,
      }),
  }),
  extension: (ctx) => ({
    registerSource: (scope: string) =>
      ctx.core.sources.register({
        id: "configured-source",
        scope,
        kind: "configurable",
        name: "Configurable Source",
        canRemove: true,
        tools: [{ name: "run", description: "run configurable source" }],
      }),
    getConfigAtScope: (scope: string) => ctx.storage.get(scope),
    getVisibleConfig: () => ctx.storage.visible(),
  }),
  sourceConfigure: {
    type: "configurable",
    schema: Schema.Struct({ header: Schema.String }),
    configure: ({ ctx, sourceId, sourceScope, targetScope, config }) =>
      ctx.pluginStorage.put({
        scope: targetScope,
        collection: "source-config",
        key: sourceId,
        data: {
          ...(config as { readonly header: string }),
          sourceScope,
        },
      }),
  },
}))();

describe("createExecutor", () => {
  it.effect("rolls back plugin and core writes from ctx.transaction failures", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [txPlugin] as const });

      const error = yield* executor.tx.failAfterPluginAndCoreWrites().pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "TestPluginError", message: "rollback" });
      expect(yield* executor.tx.list()).toEqual([]);
      expect(yield* executor.sources.list()).toEqual([]);
      expect(yield* executor.tools.list()).toEqual([]);
    }),
  );

  it.effect("keeps FumaDB unique violations catchable inside plugin code", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [txPlugin] as const });

      const result = yield* executor.tx.catchDuplicateCreate();

      expect(result.caught).toBe(true);
      expect(result.model).toContain("tx.item.create");
    }),
  );

  it.effect("runs plugin and database close hooks", () =>
    Effect.gen(function* () {
      let pluginClosed = false;
      let dbClosed = false;
      const closablePlugin = definePlugin(() => ({
        id: "closable" as const,
        storage: () => ({}),
        close: () =>
          Effect.sync(() => {
            pluginClosed = true;
          }),
      }));
      const config = makeTestConfig({ plugins: [closablePlugin()] as const });
      const executor = yield* createExecutor({
        ...config,
        db: {
          db: config.db,
          close: () =>
            Effect.sync(() => {
              dbClosed = true;
            }),
        },
        onElicitation: "accept-all",
      });

      yield* executor.close();

      expect(pluginClosed).toBe(true);
      expect(dbClosed).toBe(true);
      yield* Effect.promise(() => config.testDb.close());
    }),
  );

  it.effect("orders source detection results by confidence and applies configured bounds", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor({
        ...makeTestConfig({
          plugins: [detector("low", "low"), detector("high", "high"), detector("medium", "medium")],
        }),
        sourceDetection: { maxDetectors: 2, maxResults: 1 },
        onElicitation: "accept-all",
      });

      const results = yield* executor.sources.detect("https://example.com/source");

      expect(results.map((result) => result.kind)).toEqual(["high"]);
    }),
  );

  it.effect("applies hosted outbound policy before source detection plugins run", () =>
    Effect.gen(function* () {
      let called = false;
      const hostedDetector = definePlugin(() => ({
        id: "hosted-detector" as const,
        storage: () => ({}),
        detect: () =>
          Effect.sync(() => {
            called = true;
            return SourceDetectionResult.make({
              kind: "hosted-detector",
              confidence: "high",
              endpoint: "http://127.0.0.1/source",
              name: "hosted detector",
              namespace: "hosted_detector",
            });
          }),
      }));
      const executor = yield* createExecutor({
        scopes: [testScope],
        plugins: [hostedDetector()] as const,
        httpClientLayer: FetchHttpClient.layer,
        onElicitation: "accept-all",
      });

      const results = yield* executor.sources.detect("http://127.0.0.1/source");

      expect(results).toEqual([]);
      expect(called).toBe(false);
    }),
  );

  it.effect("returns schema roots with shared reachable definitions", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [schemaProbePlugin] as const });

      yield* executor.schemaProbe.registerSource();

      const schema = yield* executor.tools.schema("schema-source.inspect");

      expect(schema?.inputSchema).toEqual({
        type: "object",
        properties: {
          pet: { $ref: "#/$defs/Pet" },
        },
        required: ["pet"],
      });
      expect(schema?.outputSchema).toEqual({ $ref: "#/$defs/Owner" });
      expect(schema?.schemaDefinitions).toEqual({
        Cat: expect.any(Object),
        Collar: expect.any(Object),
        Dog: expect.any(Object),
        Owner: expect.any(Object),
        Pet: expect.any(Object),
      });
      expect(schema?.schemaDefinitions).not.toHaveProperty("Unused");
      expect(schema?.inputTypeScript).toContain("pet: Pet");
      expect(schema?.outputTypeScript).toBe("Owner");
      expect(schema?.typeScriptDefinitions).toEqual(
        expect.objectContaining({
          Pet: expect.any(String),
          Owner: expect.any(String),
        }),
      );
    }),
  );

  it.effect("resolves dynamic tool ids case-insensitively before invoking plugins", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [caseSensitiveDynamicPlugin] as const,
      });
      yield* executor.caseDynamic.registerSource();

      const result = yield* executor.tools.invoke("case_source.listDashboards", {});

      expect(result).toEqual({ invokedToolId: "case_source.listdashboards" });
    }),
  );

  it.effect("applies policies after case-insensitive dynamic tool id resolution", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [caseSensitiveDynamicPlugin] as const,
      });
      yield* executor.caseDynamic.registerSource();
      yield* executor.policies.create({
        targetScope: "test-scope",
        pattern: "case_source.listdashboards",
        action: "require_approval",
      });
      const calls = { count: 0 };

      const result = yield* executor.tools.invoke(
        "case_source.listDashboards",
        {},
        {
          onElicitation: () =>
            Effect.sync(() => {
              calls.count += 1;
              return ElicitationResponse.make({ action: "accept" });
            }),
        },
      );

      expect(result).toEqual({ invokedToolId: "case_source.listdashboards" });
      expect(calls.count).toBe(1);
    }),
  );

  it.effect("suggests visible tools for missing dynamic tool ids", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [caseSensitiveDynamicPlugin] as const,
      });
      yield* executor.caseDynamic.registerSource();

      const error = yield* executor.tools
        .invoke("case_source.listDashboardsWRONG", {})
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(ToolNotFoundError);
      if (!Predicate.isTagged("ToolNotFoundError")(error)) return;
      expect(error.suggestions).toEqual(["case_source.listdashboards"]);
    }),
  );

  it.effect("dispatches source.configure through the owning plugin with explicit scopes", () =>
    Effect.gen(function* () {
      const orgScope = Scope.make({
        id: ScopeId.make("org"),
        name: "Org",
        createdAt: new Date(),
      });
      const userScope = Scope.make({
        id: ScopeId.make("user"),
        name: "User",
        createdAt: new Date(),
      });
      const executor = yield* createExecutor({
        scopes: [userScope, orgScope],
        plugins: [configurableSourcePlugin] as const,
        onElicitation: "accept-all",
      });

      yield* executor.configurable.registerSource("org");
      yield* executor.sources.configure({
        source: { id: "configured-source", scope: "org" },
        scope: "org",
        type: "configurable",
        config: { header: "org-token" },
      });
      yield* executor.sources.configure({
        source: { id: "configured-source", scope: "org" },
        scope: "user",
        type: "configurable",
        config: { header: "user-token" },
      });

      const orgConfig = yield* executor.configurable.getConfigAtScope("org");
      const visibleConfig = yield* executor.configurable.getVisibleConfig();

      expect(orgConfig?.data).toEqual({ header: "org-token", sourceScope: "org" });
      expect(visibleConfig?.data).toEqual({ header: "user-token", sourceScope: "org" });
    }),
  );

  it.effect("core tools configure sources through agent-visible tool calls", () =>
    Effect.gen(function* () {
      const orgScope = Scope.make({
        id: ScopeId.make("org"),
        name: "Org",
        createdAt: new Date(),
      });
      const userScope = Scope.make({
        id: ScopeId.make("user"),
        name: "User",
        createdAt: new Date(),
      });
      const config = makeTestConfig({
        scopes: [userScope, orgScope],
        plugins: [configurableSourcePlugin] as const,
      });
      const executor = yield* createExecutor({
        ...config,
        coreTools: { webBaseUrl: "http://executor.test" },
      });

      yield* executor.configurable.registerSource("org");

      expect((yield* executor.tools.list()).map((tool) => tool.id)).not.toContain(
        "executor.coreTools.sources.configureSchemas",
      );
      const presets = yield* executor.tools.invoke("executor.coreTools.sources.presets", {
        query: "demo",
      });
      expect(presets).toMatchObject({
        presets: [
          expect.objectContaining({
            pluginId: "configurable",
            id: "configurable-demo",
            name: "Configurable Demo",
            url: "https://example.com/configurable.json",
            featured: true,
          }),
        ],
      });

      yield* executor.tools.invoke("executor.coreTools.sources.configure", {
        source: { id: "configured-source", scope: "org" },
        scope: "user",
        type: "configurable",
        config: { header: "agent-token" },
      });

      const visibleConfig = yield* executor.configurable.getVisibleConfig();
      expect(visibleConfig?.data).toEqual({ header: "agent-token", sourceScope: "org" });

      yield* executor.close();
      yield* Effect.promise(() => config.testDb.close());
    }),
  );

  it.effect("core tools generate browser handoff URLs for secret values", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({ plugins: [memorySecretsPlugin()] as const });
      const executor = yield* createExecutor({
        ...config,
        coreTools: { webBaseUrl: "http://executor.test" },
      });

      const result = yield* executor.tools.invoke("executor.coreTools.secrets.create", {
        name: "api-token",
        provider: "memory",
      });

      expect(result).toMatchObject({
        id: expect.any(String),
        url: expect.any(String),
        instructions: expect.stringContaining("placeholder"),
      });
      const url = new URL((result as { readonly url: string }).url);
      expect(url.origin).toBe("http://executor.test");
      expect(url.pathname).toBe("/secrets");
      expect(url.searchParams.get("scope")).toBe("test-scope");
      expect(url.searchParams.get("name")).toBe("api-token");
      expect(url.searchParams.get("provider")).toBe("memory");
      expect(url.searchParams.get("secretId")).toBe((result as { readonly id: string }).id);

      const idResult = yield* executor.tools.invoke("executor.coreTools.secrets.create", {
        scope: "test-scope",
        name: "api-token-by-id",
        provider: "memory",
      });
      const idUrl = new URL((idResult as { readonly url: string }).url);
      expect(idUrl.searchParams.get("scope")).toBe("test-scope");
      expect(idUrl.searchParams.get("name")).toBe("api-token-by-id");

      const invalidProvider = yield* executor.tools.invoke("executor.coreTools.secrets.create", {
        name: "api-token-invalid-provider",
        provider: "vercel",
      });
      expect(invalidProvider).toMatchObject({
        ok: false,
        error: {
          code: "secret_provider_not_found",
          message:
            'Unknown secret storage provider "vercel". Omit provider unless the user chose one from secrets.providers.',
          details: { providers: ["memory"] },
        },
      });

      yield* executor.close();
      yield* Effect.promise(() => config.testDb.close());
    }),
  );

  it.effect("core tools require an explicit secret scope when multiple scopes are visible", () =>
    Effect.gen(function* () {
      const orgScope = Scope.make({
        id: ScopeId.make("org"),
        name: "Org",
        createdAt: new Date(),
      });
      const userScope = Scope.make({
        id: ScopeId.make("user"),
        name: "User",
        createdAt: new Date(),
      });
      const config = makeTestConfig({
        scopes: [userScope, orgScope],
        plugins: [memorySecretsPlugin()] as const,
      });
      const executor = yield* createExecutor({
        ...config,
        coreTools: { webBaseUrl: "http://executor.test" },
      });

      const result = yield* executor.tools.invoke("executor.coreTools.secrets.create", {
        name: "api-token",
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "scope_not_found",
          message:
            "Multiple scopes are visible. Call scopes.list and pass the target scope id or name.",
        },
      });

      yield* executor.close();
      yield* Effect.promise(() => config.testDb.close());
    }),
  );

  it.effect("core tools cover web UI source secret and policy management flows", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        plugins: [memorySecretsPlugin(), configurableSourcePlugin] as const,
      });
      const executor = yield* createExecutor({
        ...config,
        coreTools: { webBaseUrl: "http://executor.test" },
      });

      yield* executor.configurable.registerSource("test-scope");
      yield* executor.secrets.set({
        id: SecretId.make("agent-secret"),
        name: "Agent secret",
        value: "secret-value",
        scope: ScopeId.make("test-scope"),
        provider: "memory",
      });

      expect(
        yield* executor.tools.invoke("executor.coreTools.secrets.providers", {}),
      ).toMatchObject({
        providers: expect.arrayContaining(["memory"]),
      });
      expect(
        yield* executor.tools.invoke("executor.coreTools.secrets.status", {
          id: "agent-secret",
        }),
      ).toEqual({ id: "agent-secret", status: "resolved" });
      expect(
        yield* executor.tools.invoke("executor.coreTools.secrets.usages", {
          id: "agent-secret",
        }),
      ).toEqual({ usages: [] });

      const createdPolicy = yield* executor.tools.invoke("executor.coreTools.policies.create", {
        targetScope: "test-scope",
        pattern: "configured-source.*",
        action: "require_approval",
      });
      const policyId = (createdPolicy as { readonly policy: { readonly id: string } }).policy.id;
      expect(createdPolicy).toMatchObject({
        policy: {
          id: expect.any(String),
          scopeId: "test-scope",
          pattern: "configured-source.*",
          action: "require_approval",
        },
      });
      expect(yield* executor.tools.invoke("executor.coreTools.policies.list", {})).toMatchObject({
        policies: [expect.objectContaining({ id: policyId })],
      });
      expect(
        yield* executor.tools.invoke("executor.coreTools.policies.update", {
          id: policyId,
          targetScope: "test-scope",
          action: "approve",
        }),
      ).toMatchObject({ policy: { id: policyId, action: "approve" } });
      yield* executor.tools.invoke("executor.coreTools.policies.remove", {
        id: policyId,
        targetScope: "test-scope",
      });
      expect(yield* executor.policies.list()).toEqual([]);

      yield* executor.tools.invoke("executor.coreTools.sources.refresh", {
        id: "configured-source",
        targetScope: "test-scope",
      });
      yield* executor.tools.invoke("executor.coreTools.sources.remove", {
        id: "configured-source",
        targetScope: "test-scope",
      });
      expect((yield* executor.sources.list()).map((source) => source.id)).not.toContain(
        "configured-source",
      );

      yield* executor.tools.invoke("executor.coreTools.secrets.remove", {
        id: "agent-secret",
        targetScope: "test-scope",
      });
      expect(yield* executor.secrets.list()).toEqual([]);

      yield* executor.close();
      yield* Effect.promise(() => config.testDb.close());
    }),
  );

  it.effect("core tools start OAuth and expose completed connections", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const oauthServer = yield* serveOAuthTestServer();
        const config = makeTestConfig({ plugins: [memorySecretsPlugin()] as const });
        const executor = yield* createExecutor({
          ...config,
          coreTools: { webBaseUrl: "http://executor.test" },
          oauthEndpointUrlPolicy: { allowHttp: true },
        });

        yield* executor.secrets.set({
          id: SecretId.make("client-id"),
          name: "OAuth client id",
          value: "test-client",
          scope: ScopeId.make("test-scope"),
          provider: "memory",
        });
        yield* executor.secrets.set({
          id: SecretId.make("client-secret"),
          name: "OAuth client secret",
          value: "test-secret",
          scope: ScopeId.make("test-scope"),
          provider: "memory",
        });

        const schema = yield* executor.tools.schema("executor.coreTools.oauth.start");
        expect(schema?.inputTypeScript).toContain("credentialScope?: string");
        expect(schema?.inputTypeScript).not.toContain("scope: string; endpoint");

        const started = yield* executor.tools.invoke("executor.coreTools.oauth.start", {
          credentialScope: "test-scope",
          endpoint: oauthServer.resourceUrl,
          connectionId: "agent-oauth",
          pluginId: "test-plugin",
          strategy: {
            kind: "client-credentials",
            tokenEndpoint: oauthServer.tokenEndpoint,
            clientIdSecretId: "client-id",
            clientSecretSecretId: "client-secret",
            scopes: ["read"],
          },
        });

        expect(started).toMatchObject({
          authorizationUrl: null,
          completedConnection: { connectionId: "agent-oauth" },
          instructions: expect.stringContaining("completed without a browser handoff"),
        });

        const listed = yield* executor.tools.invoke("executor.coreTools.connections.list", {});
        expect(listed).toMatchObject({
          connections: [expect.objectContaining({ id: "agent-oauth", provider: "oauth2" })],
        });
        expect(
          yield* executor.tools.invoke("executor.coreTools.connections.providers", {}),
        ).toMatchObject({
          providers: expect.arrayContaining(["oauth2"]),
        });
        expect(
          yield* executor.tools.invoke("executor.coreTools.connections.usages", {
            id: "agent-oauth",
          }),
        ).toEqual({ usages: [] });
        yield* executor.tools.invoke("executor.coreTools.connections.remove", {
          id: "agent-oauth",
          targetScope: "test-scope",
        });
        expect(yield* executor.connections.list()).toEqual([]);

        yield* executor.close();
        yield* Effect.promise(() => config.testDb.close());
      }),
    ),
  );

  it.effect("core OAuth tools return actionable tool failures for expected errors", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({ plugins: [memorySecretsPlugin()] as const });
      const executor = yield* createExecutor({
        ...config,
        coreTools: { webBaseUrl: "http://executor.test" },
        oauthEndpointUrlPolicy: { allowHttp: true },
      });

      const result = yield* executor.tools.invoke("executor.coreTools.oauth.probe", {
        endpoint: "http://127.0.0.1:1/mcp",
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "oauth_probe_failed",
        },
      });

      yield* executor.close();
      yield* Effect.promise(() => config.testDb.close());
    }),
  );

  it.effect("core tools start browser OAuth and expose the completed connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const oauthServer = yield* serveOAuthTestServer();
        const config = makeTestConfig({ plugins: [memorySecretsPlugin()] as const });
        const executor = yield* createExecutor({
          ...config,
          coreTools: { webBaseUrl: "http://executor.test" },
          oauthEndpointUrlPolicy: { allowHttp: true },
        });

        yield* executor.secrets.set({
          id: SecretId.make("browser-client-id"),
          name: "OAuth client id",
          value: "test-client",
          scope: ScopeId.make("test-scope"),
          provider: "memory",
        });
        yield* executor.secrets.set({
          id: SecretId.make("browser-client-secret"),
          name: "OAuth client secret",
          value: "test-secret",
          scope: ScopeId.make("test-scope"),
          provider: "memory",
        });

        const started = yield* executor.tools.invoke("executor.coreTools.oauth.start", {
          credentialScope: "test",
          endpoint: oauthServer.resourceUrl,
          connectionId: "agent-browser-oauth",
          pluginId: "test-plugin",
          strategy: {
            kind: "authorization-code",
            authorizationEndpoint: oauthServer.authorizationEndpoint,
            tokenEndpoint: oauthServer.tokenEndpoint,
            clientIdSecretId: "browser-client-id",
            clientSecretSecretId: "browser-client-secret",
            scopes: ["read"],
          },
        });
        expect(started).toMatchObject({
          authorizationUrl: expect.stringContaining(oauthServer.authorizationEndpoint),
          completedConnection: null,
          instructions: expect.stringContaining("open this authorization URL"),
        });

        const authorizationUrl = (started as { authorizationUrl: string }).authorizationUrl;
        const callback = yield* oauthServer.completeAuthorizationCodeFlow({ authorizationUrl });
        const completed = yield* executor.oauth.complete({
          state: callback.state,
          code: callback.code,
        });
        expect(completed.connectionId).toBe("agent-browser-oauth");

        const listed = yield* executor.tools.invoke("executor.coreTools.connections.list", {});
        expect(listed).toMatchObject({
          connections: [expect.objectContaining({ id: "agent-browser-oauth", provider: "oauth2" })],
        });

        yield* executor.close();
        yield* Effect.promise(() => config.testDb.close());
      }),
    ),
  );
});
