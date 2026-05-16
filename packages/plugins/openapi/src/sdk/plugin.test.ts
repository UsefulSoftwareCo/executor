import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  createExecutor,
  definePlugin,
  type FumaDb,
  RemoveSecretInput,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  type InvokeOptions,
  type SecretProvider,
} from "@executor-js/sdk";
import { makeTestConfig, memorySecretsPlugin } from "@executor-js/sdk/testing";
import type { ConfigFileSink } from "@executor-js/config";

const TEST_SCOPE = "test-scope";
import { openApiPlugin } from "./plugin";
import { ConfiguredHeaderBinding, OAuth2SourceConfig, OpenApiSourceBindingInput } from "./types";
import {
  addOpenApiTestSource,
  makeOpenApiHttpApiTestSourceConfig,
  serveOpenApiHttpApiTestServer,
} from "../testing";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

type FumaQueryCall = {
  readonly method: "findFirst" | "findMany";
  readonly table: string;
};

const recordFumaQueries = (db: FumaDb, calls: FumaQueryCall[]): FumaDb =>
  new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "findFirst" && prop !== "findMany") return value;
      return (table: string, ...args: readonly unknown[]) => {
        calls.push({ method: prop, table });
        return (value as (tableName: string, ...innerArgs: readonly unknown[]) => unknown).call(
          target,
          table,
          ...args,
        );
      };
    },
  });

// ---------------------------------------------------------------------------
// Define a test API with Effect HttpApi
// ---------------------------------------------------------------------------

const Item = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
});
type Item = typeof Item.Type;

const EchoHeaders = Schema.Struct({
  authorization: Schema.optional(Schema.String),
  "x-static": Schema.optional(Schema.String),
});
type EchoHeaders = typeof EchoHeaders.Type;

class QueryValidationError extends Schema.TaggedErrorClass<QueryValidationError>()(
  "QueryValidationError",
  {
    message: Schema.String,
  },
) {}

const ItemsGroup = HttpApiGroup.make("items")
  .add(HttpApiEndpoint.get("listItems", "/items", { success: Schema.Array(Item) }))
  .add(
    HttpApiEndpoint.get("getItem", "/items/:itemId", {
      params: Schema.Struct({ itemId: Schema.NumberFromString }),
      success: Item,
    }),
  )
  .add(
    HttpApiEndpoint.get("echoHeaders", "/echo-headers", {
      success: EchoHeaders,
    }),
  )
  .add(
    HttpApiEndpoint.get("queryRows", "/records/rows/:entryTypeId", {
      params: Schema.Struct({ entryTypeId: Schema.String }),
      success: Schema.Unknown,
      error: QueryValidationError,
    }),
  );

const TestApi = HttpApi.make("testApi").add(ItemsGroup);

type TestApiSourceOptions = Omit<
  Parameters<typeof makeOpenApiHttpApiTestSourceConfig>[1],
  "scope"
> & {
  readonly scope?: string;
};

const testApiSourceConfig = (options: TestApiSourceOptions = {}) =>
  makeOpenApiHttpApiTestSourceConfig(TestApi, {
    scope: TEST_SCOPE,
    ...options,
  });

const testApiSpec = () => testApiSourceConfig().spec;

// ---------------------------------------------------------------------------
// Implement handlers
// ---------------------------------------------------------------------------

const ITEMS = [
  { id: 1, name: "Widget" },
  { id: 2, name: "Gadget" },
  { id: 3, name: "Doohickey" },
];

const ItemsGroupLive = HttpApiBuilder.group(TestApi, "items", (handlers) =>
  handlers
    .handle("listItems", () => Effect.succeed(ITEMS.map((item) => Item.make(item))))
    .handle("getItem", (req) =>
      Effect.succeed(
        Item.make(
          ITEMS.find((i) => i.id === req.params.itemId) ?? {
            id: 0,
            name: "Unknown",
          },
        ),
      ),
    )
    .handle("echoHeaders", () =>
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        return EchoHeaders.make({
          authorization: req.headers["authorization"],
          "x-static": req.headers["x-static"],
        });
      }),
    )
    .handle("queryRows", () =>
      Effect.fail(
        new QueryValidationError({
          message: 'Field with name "DisplayName" does not exist',
        }),
      ),
    ),
);

const servePluginTestApi = () =>
  serveOpenApiHttpApiTestServer({
    api: TestApi,
    handlersLayer: ItemsGroupLive,
  });

const serveSpecRequiringHeader = () => {
  const state = { requests: 0, lastToken: null as string | null };
  return serveOpenApiHttpApiTestServer({
    api: TestApi,
    handlersLayer: ItemsGroupLive,
    transformSpec: (spec) => {
      const { servers: _servers, ...rest } = spec;
      return rest;
    },
    guardSpecRequest: (request) =>
      Effect.sync(() => {
        state.requests++;
        state.lastToken = request.headers["x-spec-token"] ?? null;
        if (state.lastToken !== "org-token") {
          return HttpServerResponse.jsonUnsafe({ error: "missing token" }, { status: 401 });
        }
        return null;
      }),
  }).pipe(
    Effect.map((server) => ({
      specUrl: server.specUrl,
      requestCount: () => state.requests,
      lastToken: () => state.lastToken,
    })),
  );
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAPI Plugin", () => {
  it.effect("previewSpec returns metadata and header presets", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();

        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({ httpClientLayer: server.httpClientLayer }),
              memorySecretsPlugin(),
            ] as const,
          }),
        );

        const preview = yield* executor.openapi.previewSpec(server.specJson);

        expect(preview.operationCount).toBeGreaterThanOrEqual(2);
        expect(preview.servers).toBeDefined();
      }),
    ),
  );

  it.effect("registers static openapi executor tools", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      const tools = yield* executor.tools.list();
      const ids = tools.map((t) => t.id);
      expect(ids).toContain("executor.openapi.previewSpec");
      expect(ids).toContain("executor.openapi.addSource");
    }),
  );

  it.effect("lists executor as the static runtime source", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      const sources = yield* executor.sources.list();
      expect(sources.find((s) => s.id === "openapi")).toBeUndefined();
      const control = sources.find((s) => s.id === "executor");
      expect(control).toBeDefined();
      expect(control!.runtime).toBe(true);
      expect(control!.canRemove).toBe(false);
    }),
  );

  it.effect("invokes static previewSpec through executor.tools.invoke", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      const result = (yield* executor.tools.invoke(
        "executor.openapi.previewSpec",
        { spec: testApiSpec() },
        autoApprove,
      )) as { operationCount: number };

      expect(result.operationCount).toBeGreaterThanOrEqual(2);
    }),
  );

  it.effect("describes static addSource parameters from Standard Schema", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [openApiPlugin(), memorySecretsPlugin()] as const,
        }),
      );

      const schema = yield* executor.tools.schema("executor.openapi.addSource");

      expect(schema).not.toBeNull();
      expect(schema!.inputTypeScript).toContain("scope: string");
      expect(schema!.inputTypeScript).toContain("spec: string");
      expect(
        (schema!.inputSchema as { properties?: Record<string, unknown> }).properties,
      ).toHaveProperty("credentialTargetScope");
      expect(schema!.inputTypeScript).not.toBe("Record<string, unknown>");
    }),
  );

  it.effect("invokes static addSource through executor.tools.invoke", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;
      const userScope = ScopeId.make("static-user");
      const orgScope = ScopeId.make("static-org");

      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: [
            Scope.make({ id: userScope, name: "user", createdAt: new Date() }),
            Scope.make({ id: orgScope, name: "org", createdAt: new Date() }),
          ],
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      const result = (yield* executor.tools.invoke(
        "executor.openapi.addSource",
        testApiSourceConfig({ scope: String(orgScope), namespace: "runtime" }),
        autoApprove,
      )) as { sourceId: string; toolCount: number };

      expect(result).toEqual({ sourceId: "runtime", toolCount: 4 });
      expect(yield* executor.openapi.getSource("runtime", String(userScope))).toBeNull();
      expect((yield* executor.openapi.getSource("runtime", String(orgScope)))?.scope).toBe(
        orgScope,
      );
      expect((yield* executor.tools.list()).map((t) => t.id)).toContain("runtime.items.listItems");
    }),
  );

  it.effect("requires approval before adding a source through the runtime tool", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [openApiPlugin()] as const }),
      );

      const declined = yield* executor.tools
        .invoke(
          "executor.openapi.addSource",
          testApiSourceConfig({ namespace: "runtime_declined" }),
          {
            onElicitation: () => Effect.succeed({ action: "decline" as const }),
          },
        )
        .pipe(Effect.flip);

      expect(Predicate.isTagged(declined, "ElicitationDeclinedError")).toBe(true);
      expect(yield* executor.openapi.getSource("runtime_declined", TEST_SCOPE)).toBeNull();
      expect((yield* executor.tools.list()).map((t) => t.id)).not.toContain(
        "runtime_declined.items.listItems",
      );
    }),
  );

  it.effect("adds an org source whose direct credentials are owned by the user scope", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;
      const userScope = ScopeId.make("openapi-user");
      const orgScope = ScopeId.make("openapi-org");

      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: [
            Scope.make({
              id: userScope,
              name: "user",
              createdAt: new Date(),
            }),
            Scope.make({ id: orgScope, name: "org", createdAt: new Date() }),
          ],
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("user-query-token"),
          scope: userScope,
          name: "User query token",
          value: "user-token",
        }),
      );

      const input = testApiSourceConfig({
        scope: String(orgScope),
        namespace: "org_direct_user_credential",
        queryParams: { token: { secretId: "user-query-token" } },
        credentialTargetScope: String(userScope),
      });

      yield* executor.openapi.addSpec(input);

      const bindings = yield* executor.openapi.listSourceBindings(
        "org_direct_user_credential",
        String(orgScope),
      );
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        scopeId: userScope,
        slot: "query_param:token",
        value: {
          kind: "secret",
          secretId: SecretId.make("user-query-token"),
        },
      });
    }),
  );

  it.effect("updateSource removes bindings for credential slots no longer present", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("old-token"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "Old token",
          value: "old-secret",
        }),
      );

      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          namespace: "stale_binding",
          baseUrl: "",
          credentialTargetScope: TEST_SCOPE,
          headers: {
            "X-Old": { secretId: "old-token" },
          },
        }),
      );

      yield* executor.openapi.updateSource("stale_binding", TEST_SCOPE, {
        headers: {},
      });

      const bindings = yield* executor.openapi.listSourceBindings("stale_binding", TEST_SCOPE);
      expect(bindings).toEqual([]);
    }),
  );

  it.effect("updateSource removes stale OAuth2 bindings when the OAuth template changes", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("old-client-id"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "Old client ID",
          value: "client-id",
        }),
      );

      const oldOAuth = OAuth2SourceConfig.make({
        kind: "oauth2",
        securitySchemeName: "old",
        flow: "authorizationCode",
        tokenUrl: "https://auth.example.com/token",
        authorizationUrl: "https://auth.example.com/authorize",
        clientIdSlot: "oauth2:old:client-id",
        clientSecretSlot: null,
        connectionSlot: "oauth2:old:connection",
        scopes: ["read"],
      });
      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          namespace: "stale_oauth",
          baseUrl: "",
          oauth2: oldOAuth,
        }),
      );
      yield* executor.openapi.setSourceBinding(
        OpenApiSourceBindingInput.make({
          sourceId: "stale_oauth",
          sourceScope: ScopeId.make(TEST_SCOPE),
          scope: ScopeId.make(TEST_SCOPE),
          slot: oldOAuth.clientIdSlot,
          value: { kind: "secret", secretId: SecretId.make("old-client-id") },
        }),
      );

      yield* executor.openapi.updateSource("stale_oauth", TEST_SCOPE, {
        oauth2: OAuth2SourceConfig.make({
          kind: "oauth2",
          securitySchemeName: "new",
          flow: "authorizationCode",
          tokenUrl: "https://auth.example.com/token",
          authorizationUrl: "https://auth.example.com/authorize",
          clientIdSlot: "oauth2:new:client-id",
          clientSecretSlot: null,
          connectionSlot: "oauth2:new:connection",
          scopes: ["read"],
        }),
      });

      const bindings = yield* executor.openapi.listSourceBindings("stale_oauth", TEST_SCOPE);
      expect(bindings.some((binding) => binding.slot === oldOAuth.clientIdSlot)).toBe(false);
    }),
  );

  it.effect("resolves secret-backed headers at invocation time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const clientLayer = FetchHttpClient.layer;

        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({ httpClientLayer: clientLayer }),
              memorySecretsPlugin(),
            ] as const,
          }),
        );

        yield* executor.secrets.set(
          SetSecretInput.make({
            id: SecretId.make("test-api-token"),
            scope: ScopeId.make(TEST_SCOPE),
            name: "Test API Token",
            value: "secret-value-123",
          }),
        );

        yield* addOpenApiTestSource(executor, server, {
          scope: TEST_SCOPE,
          namespace: "authed",
          credentialTargetScope: TEST_SCOPE,
          headers: {
            Authorization: { secretId: "test-api-token", prefix: "Bearer " },
            "X-Static": "hello",
          },
        });

        const result = (yield* executor.tools.invoke(
          "authed.items.echoHeaders",
          {},
          autoApprove,
        )) as {
          data: { authorization?: string; "x-static"?: string } | null;
          error: unknown;
        };

        expect(result.error).toBeNull();
        const data = result.data!;
        expect(data.authorization).toBe("Bearer secret-value-123");
        expect(data["x-static"]).toBe("hello");
      }),
    ),
  );

  it.effect("addSpec without credentialTargetScope defaults to the source's scope", () =>
    // Regression: config-sync calls addSpec without ever setting
    // credentialTargetScope. Before the fix, any source with a
    // header secret in executor.jsonc errored with
    // "credentialTargetScope is required when adding direct OpenAPI
    // credentials" the moment the daemon started.
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("config-sync-token"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "Config-sync token",
          value: "secret-from-jsonc",
        }),
      );

      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          namespace: "default_target_scope",
          baseUrl: "",
          headers: {
            Authorization: {
              secretId: "config-sync-token",
              prefix: "Bearer ",
            },
          },
        }),
      );

      const bindings = yield* executor.openapi.listSourceBindings(
        "default_target_scope",
        TEST_SCOPE,
      );
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        scopeId: ScopeId.make(TEST_SCOPE),
        slot: "header:authorization",
        value: {
          kind: "secret",
          secretId: SecretId.make("config-sync-token"),
        },
      });
    }),
  );

  it.effect("fails clearly when a secret is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const clientLayer = FetchHttpClient.layer;
        const secretStore = new Map<string, string>();
        const key = (scope: string, id: string) => `${scope}\u0000${id}`;
        const provider: SecretProvider = {
          key: "memory",
          writable: true,
          get: (id, scope) => Effect.sync(() => secretStore.get(key(scope, id)) ?? null),
          set: (id, value, scope) =>
            Effect.sync(() => {
              secretStore.set(key(scope, id), value);
            }),
          delete: (id, scope) => Effect.sync(() => secretStore.delete(key(scope, id))),
        };
        const staleSecretPlugin = definePlugin(() => ({
          id: "stale-secret" as const,
          storage: () => ({}),
          secretProviders: [provider],
        }));

        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({ httpClientLayer: clientLayer }),
              staleSecretPlugin(),
            ] as const,
          }),
        );
        yield* executor.secrets.set(
          SetSecretInput.make({
            id: SecretId.make("missing-token"),
            scope: ScopeId.make(TEST_SCOPE),
            name: "Missing token",
            value: "initial-value",
          }),
        );

        yield* addOpenApiTestSource(executor, server, {
          scope: TEST_SCOPE,
          namespace: "noauth",
          headers: {
            Authorization: ConfiguredHeaderBinding.make({
              kind: "binding",
              slot: "header:authorization",
              prefix: "Bearer ",
            }),
          },
        });
        yield* executor.openapi.setSourceBinding(
          OpenApiSourceBindingInput.make({
            sourceId: "noauth",
            sourceScope: ScopeId.make(TEST_SCOPE),
            scope: ScopeId.make(TEST_SCOPE),
            slot: "header:authorization",
            value: { kind: "secret", secretId: SecretId.make("missing-token") },
          }),
        );
        secretStore.delete(key(TEST_SCOPE, "missing-token"));

        const error = yield* Effect.flip(
          executor.tools.invoke("noauth.items.listItems", {}, autoApprove),
        );

        expect(Predicate.isTagged(error, "ToolInvocationError")).toBe(true);
        expect(error).toMatchObject({
          message: expect.stringContaining("missing-token"),
        });
      }),
    ),
  );

  it.effect("registers tools from an OpenAPI spec", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      const result = yield* executor.openapi.addSpec(
        testApiSourceConfig({
          namespace: "test",
          baseUrl: "",
        }),
      );

      expect(result.toolCount).toBeGreaterThanOrEqual(2);

      const tools = yield* executor.tools.list();
      const names = tools.map((t) => t.name);
      expect(names).toContain("items.listItems");
      expect(names).toContain("items.getItem");
    }),
  );

  it.effect("invokes listItems", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const clientLayer = FetchHttpClient.layer;
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({ httpClientLayer: clientLayer }),
              memorySecretsPlugin(),
            ] as const,
          }),
        );

        yield* addOpenApiTestSource(executor, server, {
          scope: TEST_SCOPE,
          namespace: "test",
        });

        const result = (yield* executor.tools.invoke("test.items.listItems", {}, autoApprove)) as {
          data: unknown;
          error: unknown;
        };
        expect(result.error).toBeNull();
        expect(result.data).toEqual(ITEMS);
      }),
    ),
  );

  it.effect("invokes getItem with path parameter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const clientLayer = FetchHttpClient.layer;
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({ httpClientLayer: clientLayer }),
              memorySecretsPlugin(),
            ] as const,
          }),
        );

        yield* addOpenApiTestSource(executor, server, {
          scope: TEST_SCOPE,
          namespace: "test",
        });

        const result = (yield* executor.tools.invoke(
          "test.items.getItem",
          { itemId: "2" },
          autoApprove,
        )) as { data: unknown; error: unknown };
        expect(result.error).toBeNull();
        expect(result.data).toEqual({ id: 2, name: "Gadget" });
      }),
    ),
  );

  it.effect("surfaces structured validation errors from OpenAPI tool calls", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const clientLayer = FetchHttpClient.layer;
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({ httpClientLayer: clientLayer }),
              memorySecretsPlugin(),
            ] as const,
          }),
        );

        yield* addOpenApiTestSource(executor, server, {
          scope: TEST_SCOPE,
          namespace: "records",
        });

        const result = (yield* executor.tools.invoke(
          "records.items.queryRows",
          {
            entryTypeId: "18538",
            query: JSON.stringify([{ DisplayName: "Example" }]),
            limit: 10,
            skip: 0,
          },
          autoApprove,
        )) as { data: unknown; error: unknown };

        expect(result.data).toBeNull();
        expect(result.error).toEqual(
          expect.objectContaining({
            message: 'Field with name "DisplayName" does not exist',
          }),
        );
      }),
    ),
  );

  it.effect("removeSpec cleans up registered tools", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          namespace: "removable",
          baseUrl: "",
        }),
      );

      expect((yield* executor.tools.list()).length).toBeGreaterThan(2);

      yield* executor.openapi.removeSpec("removable", TEST_SCOPE);

      const remaining = yield* executor.tools.list();
      const ids = remaining.map((t) => t.id).sort();
      expect(ids).toEqual(["executor.openapi.addSource", "executor.openapi.previewSpec"]);
    }),
  );

  it.effect("executor.sources.remove writes back to configFile (engine-level remove)", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;

      const removeCalls: string[] = [];
      const upsertCalls: string[] = [];
      const configFile: ConfigFileSink = {
        upsertSource: (source) =>
          Effect.sync(() => {
            upsertCalls.push(source.namespace ?? "");
          }),
        removeSource: (namespace) =>
          Effect.sync(() => {
            removeCalls.push(namespace);
          }),
      };

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer, configFile }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          namespace: "removable",
          baseUrl: "",
        }),
      );
      expect(upsertCalls).toEqual(["removable"]);

      yield* executor.sources.remove({
        id: "removable",
        targetScope: TEST_SCOPE,
      });

      expect(removeCalls).toEqual(["removable"]);
    }),
  );

  it.effect("listSourceBindings returns [] for a removed source", () =>
    // Regression: the React bindings atom revalidates after a removeSpec
    // (sourceWriteKeys invalidate it) before unmount. The store used to
    // throw StorageError("source does not exist"), which surfaced to the
    // browser as a 500. A removed source has no bindings — return [].
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          namespace: "removable",
          baseUrl: "",
        }),
      );
      yield* executor.openapi.removeSpec("removable", TEST_SCOPE);

      const bindings = yield* executor.openapi.listSourceBindings("removable", TEST_SCOPE);
      expect(bindings).toEqual([]);
    }),
  );

  // -------------------------------------------------------------------------
  // Multi-scope shadowing — regression suite covering the bug class where
  // store reads/writes that don't pin scope_id collapse onto whichever visible
  // row wins first. Each
  // scenario is reproducible against the pre-fix store.
  // -------------------------------------------------------------------------

  const ORG_SCOPE = ScopeId.make("org-scope");
  const USER_SCOPE = ScopeId.make("user-scope");

  const stackedScopes = [
    Scope.make({ id: USER_SCOPE, name: "user", createdAt: new Date() }),
    Scope.make({ id: ORG_SCOPE, name: "org", createdAt: new Date() }),
  ] as const;

  it.effect("shadowed addSpec does not wipe the outer-scope source", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;

      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      // Org-level base source
      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          scope: String(ORG_SCOPE),
          namespace: "shared",
          baseUrl: "",
          name: "Org Source",
        }),
      );

      // Per-user shadow with the same namespace
      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          scope: String(USER_SCOPE),
          namespace: "shared",
          name: "User Source",
        }),
      );

      const userView = yield* executor.openapi.getSource("shared", String(USER_SCOPE));
      const orgView = yield* executor.openapi.getSource("shared", String(ORG_SCOPE));

      // Both rows must coexist — innermost-wins reads come from the
      // executor; the store's scope-pinned getters return the exact row.
      expect(userView?.name).toBe("User Source");
      expect(userView?.scope).toBe(String(USER_SCOPE));
      expect(orgView?.name).toBe("Org Source");
      expect(orgView?.scope).toBe(String(ORG_SCOPE));
    }),
  );

  it.effect("getSource resolves inherited config without listing every OpenAPI source", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;
      const config = makeTestConfig({
        scopes: stackedScopes,
        plugins: [openApiPlugin({ httpClientLayer: clientLayer }), memorySecretsPlugin()] as const,
      });
      const queryCalls: FumaQueryCall[] = [];

      const executor = yield* createExecutor({
        ...config,
        db: recordFumaQueries(config.db, queryCalls),
      });

      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          scope: String(ORG_SCOPE),
          namespace: "shared",
          baseUrl: "https://org.example.com",
          name: "Org Source",
        }),
      );
      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          scope: String(USER_SCOPE),
          namespace: "shared",
          name: "User Source",
        }),
      );

      queryCalls.length = 0;
      const userView = yield* executor.openapi.getSource("shared", String(USER_SCOPE));

      expect(userView?.config.baseUrl).toBe("https://org.example.com");
      expect(
        queryCalls.some((call) => call.method === "findMany" && call.table === "openapi_source"),
      ).toBe(false);
    }),
  );

  it.effect("removeSpec on user shadow leaves the org row intact", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;

      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          scope: String(ORG_SCOPE),
          namespace: "shared",
          baseUrl: "",
          name: "Org Source",
        }),
      );
      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          scope: String(USER_SCOPE),
          namespace: "shared",
          baseUrl: "",
          name: "User Source",
        }),
      );

      yield* executor.openapi.removeSpec("shared", String(USER_SCOPE));

      const userView = yield* executor.openapi.getSource("shared", String(USER_SCOPE));
      const orgView = yield* executor.openapi.getSource("shared", String(ORG_SCOPE));

      expect(userView).toBeNull();
      expect(orgView?.name).toBe("Org Source");
    }),
  );

  it.effect("updateSource on user shadow cannot override the inherited base URL", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;

      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          scope: String(ORG_SCOPE),
          namespace: "shared",
          baseUrl: "https://org.example.com",
          name: "Org Source",
        }),
      );
      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          scope: String(USER_SCOPE),
          namespace: "shared",
          name: "User Source",
        }),
      );

      const updateResult = yield* executor.openapi
        .updateSource("shared", String(USER_SCOPE), {
          name: "User Renamed",
          baseUrl: "https://user-new.example.com",
        })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => null,
          }),
        );

      const userView = yield* executor.openapi.getSource("shared", String(USER_SCOPE));
      const orgView = yield* executor.openapi.getSource("shared", String(ORG_SCOPE));

      expect(updateResult).toMatchObject({ _tag: "OpenApiOAuthError" });
      expect(userView?.name).toBe("User Source");
      expect(userView?.config.baseUrl).toBe("https://org.example.com");
      expect(orgView?.name).toBe("Org Source");
      expect(orgView?.config.baseUrl).toBe("https://org.example.com");
    }),
  );

  it.effect("addSpec on user shadow cannot override the inherited base URL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const executor = yield* createExecutor(
          makeTestConfig({
            scopes: stackedScopes,
            plugins: [
              openApiPlugin({ httpClientLayer: server.httpClientLayer }),
              memorySecretsPlugin(),
            ] as const,
          }),
        );

        yield* executor.secrets.set(
          SetSecretInput.make({
            id: SecretId.make("org-api-token"),
            scope: ORG_SCOPE,
            name: "Org API token",
            value: "org-secret",
          }),
        );

        yield* executor.openapi.addSpec({
          spec: server.specJson,
          scope: String(ORG_SCOPE),
          namespace: "shadow_auth",
          baseUrl: "https://org.example.com",
          credentialTargetScope: String(ORG_SCOPE),
          headers: {
            Authorization: { secretId: "org-api-token", prefix: "Bearer " },
          },
        });

        const addResult = yield* executor.openapi
          .addSpec({
            spec: server.specJson,
            scope: String(USER_SCOPE),
            namespace: "shadow_auth",
            baseUrl: server.baseUrl,
            name: "User Shadow",
          })
          .pipe(
            Effect.match({
              onFailure: (error) => error,
              onSuccess: () => null,
            }),
          );

        expect(addResult).toMatchObject({ _tag: "OpenApiOAuthError" });
      }),
    ),
  );

  it.effect(
    "refreshing a user shadow uses inherited spec-fetch credentials without copying them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveSpecRequiringHeader();
          const config = makeTestConfig({
            scopes: stackedScopes,
            plugins: [openApiPlugin(), memorySecretsPlugin()] as const,
          });
          const executor = yield* createExecutor(config);
          const db = config.db;

          yield* executor.secrets.set(
            SetSecretInput.make({
              id: SecretId.make("org-spec-token"),
              scope: ORG_SCOPE,
              name: "Org spec token",
              value: "org-token",
            }),
          );

          yield* executor.openapi.addSpec({
            spec: server.specUrl,
            scope: String(ORG_SCOPE),
            namespace: "shared_spec_fetch",
            credentialTargetScope: String(ORG_SCOPE),
            specFetchCredentials: {
              headers: {
                "X-Spec-Token": { secretId: "org-spec-token" },
              },
            },
          });
          yield* executor.openapi.addSpec(
            testApiSourceConfig({
              scope: String(USER_SCOPE),
              namespace: "shared_spec_fetch",
              name: "User Shadow",
            }),
          );

          const userRowsBefore = yield* Effect.promise(() =>
            db.findMany("openapi_source_spec_fetch_header", {
              where: (b) =>
                b.and(
                  b("scope_id", "=", String(USER_SCOPE)),
                  b("source_id", "=", "shared_spec_fetch"),
                ),
            }),
          );
          expect(userRowsBefore).toEqual([]);

          const requestsBefore = server.requestCount();
          yield* executor.sources.refresh({
            id: "shared_spec_fetch",
            targetScope: String(USER_SCOPE),
          });

          expect(server.requestCount()).toBeGreaterThan(requestsBefore);
          expect(server.lastToken()).toBe("org-token");
          const orgRowsAfter = yield* Effect.promise(() =>
            db.findMany("openapi_source_spec_fetch_header", {
              where: (b) =>
                b.and(
                  b("scope_id", "=", String(ORG_SCOPE)),
                  b("source_id", "=", "shared_spec_fetch"),
                ),
            }),
          );
          const userRowsAfter = yield* Effect.promise(() =>
            db.findMany("openapi_source_spec_fetch_header", {
              where: (b) =>
                b.and(
                  b("scope_id", "=", String(USER_SCOPE)),
                  b("source_id", "=", "shared_spec_fetch"),
                ),
            }),
          );
          expect(orgRowsAfter).toHaveLength(1);
          expect(userRowsAfter).toEqual([]);
        }),
      ),
  );

  it.effect("addSpec persists OAuth2 source slots with no live connection yet", () =>
    Effect.gen(function* () {
      const clientLayer = FetchHttpClient.layer;

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      // A team-shared client id secret, but no live connection for this
      // scope — the admin is saving the source and deferring sign-in
      // to individual users.
      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("acme-client-id"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "Acme Client ID",
          value: "client-abc",
        }),
      );

      const deferredAuth = OAuth2SourceConfig.make({
        kind: "oauth2",
        securitySchemeName: "oauth2",
        flow: "authorizationCode",
        tokenUrl: "https://auth.example.com/token",
        authorizationUrl: "https://auth.example.com/authorize",
        clientIdSlot: "oauth2:oauth2:client-id",
        clientSecretSlot: null,
        connectionSlot: "oauth2:oauth2:connection",
        scopes: ["read:items"],
      });

      const result = yield* executor.openapi.addSpec(
        testApiSourceConfig({
          namespace: "deferred",
          baseUrl: "https://api.example.com",
          oauth2: deferredAuth,
        }),
      );

      expect(result.toolCount).toBeGreaterThan(0);

      const stored = yield* executor.openapi.getSource("deferred", TEST_SCOPE);
      expect(stored).not.toBeNull();
      expect(stored?.config.oauth2?.flow).toBe("authorizationCode");
      expect(stored?.config.oauth2?.connectionSlot).toBe("oauth2:oauth2:connection");
      expect(stored?.config.oauth2?.clientIdSlot).toBe("oauth2:oauth2:client-id");

      yield* executor.openapi.setSourceBinding(
        OpenApiSourceBindingInput.make({
          sourceId: "deferred",
          sourceScope: ScopeId.make(TEST_SCOPE),
          scope: ScopeId.make(TEST_SCOPE),
          slot: stored!.config.oauth2!.clientIdSlot,
          value: {
            kind: "secret",
            secretId: SecretId.make("acme-client-id"),
          },
        }),
      );

      const clientIdBinding = yield* executor.openapi
        .listSourceBindings("deferred", TEST_SCOPE)
        .pipe(
          Effect.map(
            (bindings) =>
              bindings.find((binding) => binding.slot === stored!.config.oauth2!.clientIdSlot) ??
              null,
          ),
        );
      expect(clientIdBinding?.value).toEqual({
        kind: "secret",
        secretId: SecretId.make("acme-client-id"),
        secretScopeId: ScopeId.make(TEST_SCOPE),
      });

      const connectionBinding = yield* executor.openapi
        .listSourceBindings("deferred", TEST_SCOPE)
        .pipe(
          Effect.map(
            (bindings) =>
              bindings.find((binding) => binding.slot === stored!.config.oauth2!.connectionSlot) ??
              null,
          ),
        );
      expect(connectionBinding).toBeNull();

      // Tools should be listed even without a live connection; invocation
      // is what requires the token, not registration.
      const tools = yield* executor.tools.list();
      expect(tools.some((t) => t.id.startsWith("deferred."))).toBe(true);
    }),
  );

  // -------------------------------------------------------------------------
  // Usage tracking — OpenAPI credential slots are core credential_binding
  // rows, so usages/removal restrictions come from one shared path.
  // -------------------------------------------------------------------------

  it.effect("usagesForSecret aggregates header and query-param slot bindings", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), openApiPlugin()] as const,
        }),
      );

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("api-key"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "API Key",
          value: "abc123",
          provider: "memory",
        }),
      );

      // Add a source whose query params are canonicalized to a credential slot.
      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          namespace: "with_secret",
          baseUrl: "http://example.com",
          credentialTargetScope: TEST_SCOPE,
          queryParams: { token: { secretId: "api-key" } },
        }),
      );

      // Configure a slot binding pointing at the same secret.
      yield* executor.openapi.setSourceBinding(
        OpenApiSourceBindingInput.make({
          sourceId: "with_secret",
          sourceScope: ScopeId.make(TEST_SCOPE),
          scope: ScopeId.make(TEST_SCOPE),
          slot: "header:authorization",
          value: { kind: "secret", secretId: SecretId.make("api-key") },
        }),
      );

      const usages = yield* executor.secrets.usages(SecretId.make("api-key"));
      expect(usages.length).toBe(2);
      const slots = usages.map((u) => u.slot).sort();
      expect(slots).toEqual(["header:authorization", "query_param:token"]);
      expect(usages.every((u) => u.pluginId === "openapi")).toBe(true);
    }),
  );

  it.effect("secrets.remove refuses while an openapi binding still uses it", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), openApiPlugin()] as const,
        }),
      );
      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("locked"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "Locked",
          value: "v",
          provider: "memory",
        }),
      );

      yield* executor.openapi.addSpec(
        testApiSourceConfig({
          namespace: "ref",
          baseUrl: "http://example.com",
        }),
      );
      yield* executor.openapi.setSourceBinding(
        OpenApiSourceBindingInput.make({
          sourceId: "ref",
          sourceScope: ScopeId.make(TEST_SCOPE),
          scope: ScopeId.make(TEST_SCOPE),
          slot: "header:authorization",
          value: { kind: "secret", secretId: SecretId.make("locked") },
        }),
      );

      const failure = yield* executor.secrets
        .remove(
          RemoveSecretInput.make({
            id: SecretId.make("locked"),
            targetScope: ScopeId.make(TEST_SCOPE),
          }),
        )
        .pipe(Effect.flip);
      expect(Predicate.isTagged(failure, "SecretInUseError")).toBe(true);

      // Detach the binding, then remove succeeds.
      yield* executor.openapi.removeSourceBinding(
        "ref",
        ScopeId.make(TEST_SCOPE),
        "header:authorization",
        ScopeId.make(TEST_SCOPE),
      );
      yield* executor.secrets.remove(
        RemoveSecretInput.make({
          id: SecretId.make("locked"),
          targetScope: ScopeId.make(TEST_SCOPE),
        }),
      );
    }),
  );
});
