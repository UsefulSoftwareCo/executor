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
  SetSourceCredentialBindingInput,
  RemoveSourceCredentialBindingInput,
  type InvokeOptions,
  type SecretProvider,
} from "@executor-js/sdk";
import {
  makeTestConfig,
  memorySecretsPlugin,
  typeCheckOutputTypeScript,
} from "@executor-js/sdk/testing";
import type { ConfigFileSink } from "@executor-js/config";

const TEST_SCOPE = "test-scope";
import { openApiPlugin } from "./plugin";
import { ConfiguredHeaderBinding, OAuth2SourceConfig } from "./types";
import {
  addOpenApiTestSource,
  makeOpenApiHttpApiTestSourceConfig,
  serveOpenApiHttpApiTestServer,
  unwrapInvocation,
} from "../testing";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };
const TOOL_ERROR_TYPESCRIPT =
  "{ code: string; message: string; status?: number; details?: unknown; retryable?: boolean }";

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

const testApiSpec = () => {
  const spec = testApiSourceConfig().spec;
  return spec.kind === "blob" ? spec.value : spec.url;
};

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
        if (state.requests === 1) {
          return null;
        }
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
      expect(ids).toContain("executor.openapi.getSource");
      expect(ids).toContain("executor.openapi.addSource");
      expect(ids).toContain("executor.openapi.configureSource");
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

      const preview = unwrapInvocation(
        yield* executor.tools.invoke(
          "executor.openapi.previewSpec",
          { spec: testApiSpec() },
          autoApprove,
        ),
      ).data as { operationCount: number; operations?: unknown };

      expect(preview.operationCount).toBeGreaterThanOrEqual(2);
      expect(preview.operations).toBeUndefined();
    }),
  );

  it.effect("describes static previewSpec output from Standard Schema", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [openApiPlugin(), memorySecretsPlugin()] as const,
        }),
      );

      const schema = yield* executor.tools.schema("executor.openapi.previewSpec");

      expect(schema).not.toBeNull();
      expect(schema!.outputTypeScript).toContain("servers:");
      expect(schema!.outputTypeScript).toContain("securitySchemes:");
      expect(schema!.outputTypeScript).toContain("oauth2Presets:");
      expect(schema!.outputTypeScript).toContain("title: string | null");
      expect(schema!.outputTypeScript).not.toContain("operations:");
      expect(schema!.outputTypeScript).not.toContain("_tag");
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
      expect(schema!.inputTypeScript).not.toContain("scope: string");
      expect(schema!.inputTypeScript).toContain('kind: "url"');
      expect(
        (schema!.inputSchema as { properties?: Record<string, unknown> }).properties,
      ).not.toHaveProperty("credentialTargetScope");
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

      const result = unwrapInvocation(
        yield* executor.tools.invoke(
          "executor.openapi.addSource",
          (({ scope: _scope, ...input }) => input)(
            testApiSourceConfig({ scope: "org", namespace: "runtime" }),
          ),
          autoApprove,
        ),
      ).data as { sourceId: string; source: { id: string; scope: string }; toolCount: number };

      expect(result).toEqual({
        sourceId: "runtime",
        source: { id: "runtime", scope: String(orgScope) },
        toolCount: 4,
      });
      expect(yield* executor.openapi.getSource("runtime", String(userScope))).toBeNull();
      expect((yield* executor.openapi.getSource("runtime", String(orgScope)))?.scope).toBe(
        orgScope,
      );
      const inspected = unwrapInvocation(
        yield* executor.tools.invoke(
          "executor.openapi.getSource",
          { namespace: "runtime", scope: "org" },
          autoApprove,
        ),
      ).data as { source: { namespace: string; scope: string } | null };
      expect(inspected.source).toMatchObject({ namespace: "runtime", scope: String(orgScope) });
      expect((yield* executor.tools.list()).map((t) => t.id)).toContain("runtime.items.listItems");
    }),
  );

  it.effect("static previewSpec returns actionable tool failures", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({ plugins: [openApiPlugin()] as const });
      const executor = yield* createExecutor(config);

      const result = yield* executor.tools.invoke("executor.openapi.previewSpec", {
        spec: "not openapi",
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "openapi_parse_failed",
        },
      });

      yield* executor.close();
      yield* Effect.promise(() => config.testDb.close());
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
          (({ scope: _scope, ...input }) => input)(
            testApiSourceConfig({ namespace: "runtime_declined" }),
          ),
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
        queryParams: { token: { kind: "secret" } },
      });

      yield* executor.openapi.addSpec(input);

      const bindings = yield* executor.sources.listBindings({
        source: { id: "org_direct_user_credential", scope: orgScope },
      });
      expect(bindings).toEqual([]);
    }),
  );

  it.effect("sources.configure removes bindings for credential slots no longer present", () =>
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
          headers: {
            "X-Old": { kind: "secret" },
          },
        }),
      );
      yield* executor.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "stale_binding", scope: ScopeId.make(TEST_SCOPE) },
          scope: ScopeId.make(TEST_SCOPE),
          slotKey: "header:x-old",
          value: { kind: "secret", secretId: SecretId.make("old-token") },
        }),
      );

      yield* executor.sources.configure({
        source: { id: "stale_binding", scope: ScopeId.make(TEST_SCOPE) },
        scope: ScopeId.make(TEST_SCOPE),
        type: "openapi",
        config: { scope: TEST_SCOPE, headers: {} },
      });

      const bindings = yield* executor.sources.listBindings({
        source: { id: "stale_binding", scope: ScopeId.make(TEST_SCOPE) },
      });
      expect(bindings).toEqual([]);
    }),
  );

  it.effect("sources.configure removes stale OAuth2 bindings when the OAuth template changes", () =>
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
      yield* executor.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "stale_oauth", scope: ScopeId.make(TEST_SCOPE) },
          scope: ScopeId.make(TEST_SCOPE),
          slotKey: oldOAuth.clientIdSlot,
          value: { kind: "secret", secretId: SecretId.make("old-client-id") },
        }),
      );

      yield* executor.sources.configure({
        source: { id: "stale_oauth", scope: ScopeId.make(TEST_SCOPE) },
        scope: ScopeId.make(TEST_SCOPE),
        type: "openapi",
        config: {
          scope: TEST_SCOPE,
          oauth2: {
            clientId: { kind: "secret", secretId: "old-client-id" },
          },
          oauth2Source: OAuth2SourceConfig.make({
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
        },
      });

      const bindings = yield* executor.sources.listBindings({
        source: { id: "stale_oauth", scope: ScopeId.make(TEST_SCOPE) },
      });
      expect(bindings.some((binding) => binding.slotKey === oldOAuth.clientIdSlot)).toBe(false);
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
          headers: {
            "X-Static": "hello",
          },
        });
        const configured = yield* executor.openapi.configure(
          { id: "authed", scope: TEST_SCOPE },
          {
            scope: ScopeId.make(TEST_SCOPE),
            headers: {
              Authorization: {
                kind: "secret",
                secretId: "test-api-token",
                prefix: "Bearer ",
              },
            },
          },
        );

        const result = unwrapInvocation(
          yield* executor.tools.invoke("authed.items.echoHeaders", {}, autoApprove),
        );

        expect(configured.map((binding) => binding.slotKey)).toEqual(["header:authorization"]);
        expect(result.error).toBeNull();
        const data = result.data as { authorization?: string; "x-static"?: string };
        expect(data.authorization).toBe("Bearer secret-value-123");
        expect(data["x-static"]).toBe("hello");
      }),
    ),
  );

  it.effect("addSpec declares secret-backed header shape without a credential value", () =>
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
              kind: "secret",
              prefix: "Bearer ",
            },
          },
        }),
      );

      const bindings = yield* executor.sources.listBindings({
        source: { id: "default_target_scope", scope: ScopeId.make(TEST_SCOPE) },
      });
      expect(bindings).toEqual([]);
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
        yield* executor.sources.setBinding(
          SetSourceCredentialBindingInput.make({
            source: { id: "noauth", scope: ScopeId.make(TEST_SCOPE) },
            scope: ScopeId.make(TEST_SCOPE),
            slotKey: "header:authorization",
            value: { kind: "secret", secretId: SecretId.make("missing-token") },
          }),
        );
        secretStore.delete(key(TEST_SCOPE, "missing-token"));

        const result = yield* executor.tools.invoke("noauth.items.listItems", {}, autoApprove);

        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "credential_secret_missing",
            message: expect.stringContaining("missing-token"),
            details: {
              category: "authentication",
              recovery: {
                createSecretTool: "executor.coreTools.secrets.create",
                secretsUrl: "https://executor.sh/secrets",
              },
            },
          },
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

        const result = unwrapInvocation(
          yield* executor.tools.invoke("test.items.listItems", {}, autoApprove),
        );
        expect(result.error).toBeNull();
        expect(result.data).toEqual(ITEMS);
      }),
    ),
  );

  it.effect("describes OpenAPI invocation results with the transport envelope", () =>
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

        const schema = yield* executor.tools.schema("test.items.listItems");
        expect(schema?.outputTypeScript).toContain("status: number");
        expect(schema?.outputTypeScript).toContain("headers:");
        expect(schema?.outputTypeScript).toContain("data:");

        const result = yield* executor.tools.invoke("test.items.listItems", {}, autoApprove);
        const diagnostics = typeCheckOutputTypeScript(
          {
            outputTypeScript: `{ ok: true; data: ${schema?.outputTypeScript ?? "unknown"} } | { ok: false; error: ToolError }`,
            typeScriptDefinitions: {
              ...(schema?.typeScriptDefinitions ?? {}),
              ToolError: TOOL_ERROR_TYPESCRIPT,
            },
          },
          result,
          {
            consumerSource: [
              "if (invokedOutput.ok) {",
              "  const status: number = invokedOutput.data.status;",
              "  const items = invokedOutput.data.data;",
              "  items.map((item) => item.name);",
              "}",
            ].join("\n"),
          },
        );

        expect(diagnostics).toEqual([]);
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

        const result = unwrapInvocation(
          yield* executor.tools.invoke("test.items.getItem", { itemId: "2" }, autoApprove),
        );
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

        const result = unwrapInvocation(
          yield* executor.tools.invoke(
            "records.items.queryRows",
            {
              entryTypeId: "18538",
              query: JSON.stringify([{ DisplayName: "Example" }]),
              limit: 10,
              skip: 0,
            },
            autoApprove,
          ),
        );

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
      expect(ids).toEqual([
        "executor.openapi.addSource",
        "executor.openapi.configureSource",
        "executor.openapi.getSource",
        "executor.openapi.previewSpec",
      ]);
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

  it.effect("source bindings list returns [] for a removed source", () =>
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

      const bindings = yield* executor.sources.listBindings({
        source: { id: "removable", scope: ScopeId.make(TEST_SCOPE) },
      });
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
          baseUrl: null,
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
          baseUrl: null,
          name: "User Source",
        }),
      );

      queryCalls.length = 0;
      const userView = yield* executor.openapi.getSource("shared", String(USER_SCOPE));

      expect(userView?.config.baseUrl).toBe("https://org.example.com");
      expect(
        queryCalls.some((call) => call.method === "findMany" && call.table === "plugin_storage"),
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
          baseUrl: null,
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

  it.effect("sources.configure on user shadow cannot override the inherited base URL", () =>
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
          baseUrl: null,
          name: "User Source",
        }),
      );

      const updateResult = yield* executor.sources
        .configure({
          source: { id: "shared", scope: USER_SCOPE },
          scope: USER_SCOPE,
          type: "openapi",
          config: {
            scope: String(USER_SCOPE),
            name: "User Renamed",
            baseUrl: "https://user-new.example.com",
          },
        })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => null,
          }),
        );

      const userView = yield* executor.openapi.getSource("shared", String(USER_SCOPE));
      const orgView = yield* executor.openapi.getSource("shared", String(ORG_SCOPE));

      expect(updateResult).toMatchObject({ _tag: "StorageError" });
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
          spec: { kind: "blob", value: server.specJson },
          scope: String(ORG_SCOPE),
          name: "Shadow Auth",
          namespace: "shadow_auth",
          baseUrl: "https://org.example.com",
          headers: {
            Authorization: { kind: "secret", prefix: "Bearer " },
          },
        });

        const addResult = yield* executor.openapi
          .addSpec({
            spec: { kind: "blob", value: server.specJson },
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
            spec: { kind: "url", url: server.specUrl },
            scope: String(ORG_SCOPE),
            name: "Shared Spec Fetch",
            namespace: "shared_spec_fetch",
            baseUrl: "https://api.example.test",
            specFetchCredentials: {
              headers: {
                "X-Spec-Token": { kind: "secret" },
              },
            },
          });
          yield* executor.sources.setBinding(
            SetSourceCredentialBindingInput.make({
              source: { id: "shared_spec_fetch", scope: ORG_SCOPE },
              scope: ORG_SCOPE,
              slotKey: "spec_fetch_header:x-spec-token",
              value: { kind: "secret", secretId: SecretId.make("org-spec-token") },
            }),
          );
          yield* executor.openapi.addSpec(
            testApiSourceConfig({
              scope: String(USER_SCOPE),
              namespace: "shared_spec_fetch",
              baseUrl: null,
              name: "User Shadow",
            }),
          );

          const userRowsBefore = yield* Effect.promise(() =>
            db.findMany("plugin_storage", {
              where: (b) =>
                b.and(
                  b("scope_id", "=", String(USER_SCOPE)),
                  b("plugin_id", "=", "openapi"),
                  b("collection", "=", "source"),
                  b("key", "=", "shared_spec_fetch"),
                ),
            }),
          );
          const userConfigBefore = userRowsBefore[0]?.data as
            | { readonly config?: { readonly specFetchCredentials?: unknown } }
            | undefined;
          expect(userConfigBefore?.config?.specFetchCredentials).toBeUndefined();

          const requestsBefore = server.requestCount();
          yield* executor.sources.refresh({
            id: "shared_spec_fetch",
            targetScope: String(USER_SCOPE),
          });

          expect(server.requestCount()).toBeGreaterThan(requestsBefore);
          expect(server.lastToken()).toBe("org-token");
          const orgRowsAfter = yield* Effect.promise(() =>
            db.findMany("plugin_storage", {
              where: (b) =>
                b.and(
                  b("scope_id", "=", String(ORG_SCOPE)),
                  b("plugin_id", "=", "openapi"),
                  b("collection", "=", "source"),
                  b("key", "=", "shared_spec_fetch"),
                ),
            }),
          );
          const userRowsAfter = yield* Effect.promise(() =>
            db.findMany("plugin_storage", {
              where: (b) =>
                b.and(
                  b("scope_id", "=", String(USER_SCOPE)),
                  b("plugin_id", "=", "openapi"),
                  b("collection", "=", "source"),
                  b("key", "=", "shared_spec_fetch"),
                ),
            }),
          );
          const orgConfigAfter = orgRowsAfter[0]?.data as
            | {
                readonly config?: {
                  readonly specFetchCredentials?: {
                    readonly headers?: Readonly<Record<string, unknown>>;
                  };
                };
              }
            | undefined;
          const userConfigAfter = userRowsAfter[0]?.data as
            | { readonly config?: { readonly specFetchCredentials?: unknown } }
            | undefined;
          expect(orgConfigAfter?.config?.specFetchCredentials?.headers).toHaveProperty(
            "X-Spec-Token",
          );
          expect(userConfigAfter?.config?.specFetchCredentials).toBeUndefined();
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

      yield* executor.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "deferred", scope: ScopeId.make(TEST_SCOPE) },
          scope: ScopeId.make(TEST_SCOPE),
          slotKey: stored!.config.oauth2!.clientIdSlot,
          value: {
            kind: "secret",
            secretId: SecretId.make("acme-client-id"),
          },
        }),
      );

      const clientIdBinding = yield* executor.sources
        .listBindings({ source: { id: "deferred", scope: ScopeId.make(TEST_SCOPE) } })
        .pipe(
          Effect.map(
            (bindings) =>
              bindings.find((binding) => binding.slotKey === stored!.config.oauth2!.clientIdSlot) ??
              null,
          ),
        );
      expect(clientIdBinding?.value).toEqual({
        kind: "secret",
        secretId: SecretId.make("acme-client-id"),
        secretScopeId: ScopeId.make(TEST_SCOPE),
      });

      const connectionBinding = yield* executor.sources
        .listBindings({ source: { id: "deferred", scope: ScopeId.make(TEST_SCOPE) } })
        .pipe(
          Effect.map(
            (bindings) =>
              bindings.find(
                (binding) => binding.slotKey === stored!.config.oauth2!.connectionSlot,
              ) ?? null,
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
          queryParams: { token: { kind: "secret" } },
        }),
      );
      yield* executor.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "with_secret", scope: ScopeId.make(TEST_SCOPE) },
          scope: ScopeId.make(TEST_SCOPE),
          slotKey: "query_param:token",
          value: { kind: "secret", secretId: SecretId.make("api-key") },
        }),
      );

      // Configure a slot binding pointing at the same secret.
      yield* executor.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "with_secret", scope: ScopeId.make(TEST_SCOPE) },
          scope: ScopeId.make(TEST_SCOPE),
          slotKey: "header:authorization",
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
      yield* executor.sources.setBinding(
        SetSourceCredentialBindingInput.make({
          source: { id: "ref", scope: ScopeId.make(TEST_SCOPE) },
          scope: ScopeId.make(TEST_SCOPE),
          slotKey: "header:authorization",
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
      yield* executor.sources.removeBinding(
        RemoveSourceCredentialBindingInput.make({
          source: { id: "ref", scope: ScopeId.make(TEST_SCOPE) },
          slotKey: "header:authorization",
          scope: ScopeId.make(TEST_SCOPE),
        }),
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
