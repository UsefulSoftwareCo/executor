import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Predicate, Schema } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { HttpClient, HttpRouter, HttpServerRequest } from "effect/unstable/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  createExecutor,
  definePlugin,
  type DBAdapter,
  makeTestConfig,
  RemoveSecretInput,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  type InvokeOptions,
  type SecretProvider,
  type Where,
} from "@executor-js/sdk";
import { memorySecretsPlugin } from "@executor-js/sdk/testing";

const TEST_SCOPE = "test-scope";
import { openApiPlugin } from "./plugin";
import { ConfiguredHeaderBinding, OAuth2SourceConfig, OpenApiSourceBindingInput } from "./types";
import { makeOpenApiTestServer } from "../testing";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

type FindManyCall = {
  readonly model: string;
  readonly where?: readonly Where[];
};

const recordFindMany = (adapter: DBAdapter, calls: FindManyCall[]): DBAdapter => ({
  ...adapter,
  findMany: (data) => {
    calls.push({ model: data.model, where: data.where });
    return adapter.findMany(data);
  },
  transaction: (callback) =>
    adapter.transaction((trx) =>
      callback({
        ...trx,
        findMany: (data) => {
          calls.push({ model: data.model, where: data.where });
          return trx.findMany(data);
        },
      }),
    ),
});

// ---------------------------------------------------------------------------
// Define a test API with Effect HttpApi
// ---------------------------------------------------------------------------

class Item extends Schema.Class<Item>("Item")({
  id: Schema.Number,
  name: Schema.String,
}) {}

class EchoHeaders extends Schema.Class<EchoHeaders>("EchoHeaders")({
  authorization: Schema.optional(Schema.String),
  "x-static": Schema.optional(Schema.String),
}) {}

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
  .add(HttpApiEndpoint.get("echoHeaders", "/echo-headers", { success: EchoHeaders }))
  .add(
    HttpApiEndpoint.get("queryRows", "/records/rows/:entryTypeId", {
      params: Schema.Struct({ entryTypeId: Schema.String }),
      success: Schema.Unknown,
      error: QueryValidationError,
    }),
  );

const TestApi = HttpApi.make("testApi").add(ItemsGroup);

const spec = OpenApi.fromApi(TestApi);
const specJson = JSON.stringify(spec);

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
    .handle("listItems", () => Effect.succeed(ITEMS.map((item) => new Item(item))))
    .handle("getItem", (req) =>
      Effect.succeed(
        new Item(
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
        return new EchoHeaders({
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

// ---------------------------------------------------------------------------
// Test layer: real server on port 0 + HttpClient pointing at it
// ---------------------------------------------------------------------------

const ApiLive = HttpApiBuilder.layer(TestApi).pipe(Layer.provide(ItemsGroupLive));

const TestLayer = HttpRouter.serve(ApiLive, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
);

const serveSpecRequiringHeader = () => {
  const state = { requests: 0, lastToken: null as string | null };
  const server = http.createServer((req, res) => {
    state.requests++;
    state.lastToken = req.headers["x-spec-token"]?.toString() ?? null;
    if (state.lastToken !== "org-token") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing token" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(specJson);
  });

  return new Promise<{
    readonly specUrl: string;
    readonly requestCount: () => number;
    readonly lastToken: () => string | null;
    readonly close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        specUrl: `http://127.0.0.1:${port}/spec.json`,
        requestCount: () => state.requests,
        lastToken: () => state.lastToken,
        close: () =>
          new Promise((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
  });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

layer(TestLayer)("OpenAPI Plugin", (it) => {
  it.effect("previewSpec returns metadata and header presets", () =>
    Effect.gen(function* () {
      const server = yield* makeOpenApiTestServer({ spec });

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
  );

  it.effect("registers static openapi control tools", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

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
      expect(ids).toContain("openapi.previewSpec");
      expect(ids).toContain("openapi.addSource");
    }),
  );

  it.effect("lists openapi as a static runtime source", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      const sources = yield* executor.sources.list();
      const control = sources.find((s) => s.id === "openapi");
      expect(control).toBeDefined();
      expect(control!.runtime).toBe(true);
      expect(control!.canRemove).toBe(false);
    }),
  );

  it.effect("invokes static previewSpec through executor.tools.invoke", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      const result = (yield* executor.tools.invoke(
        "openapi.previewSpec",
        { spec: specJson },
        autoApprove,
      )) as { operationCount: number };

      expect(result.operationCount).toBeGreaterThanOrEqual(2);
    }),
  );

  it.effect("invokes static addSource through executor.tools.invoke", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const userScope = ScopeId.make("static-user");
      const orgScope = ScopeId.make("static-org");

      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: [
            new Scope({ id: userScope, name: "user", createdAt: new Date() }),
            new Scope({ id: orgScope, name: "org", createdAt: new Date() }),
          ],
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      const result = (yield* executor.tools.invoke(
        "openapi.addSource",
        { scope: String(orgScope), spec: specJson, namespace: "runtime" },
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
          "openapi.addSource",
          { scope: TEST_SCOPE, spec: specJson, namespace: "runtime_declined" },
          { onElicitation: () => Effect.succeed({ action: "decline" as const }) },
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
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const userScope = ScopeId.make("openapi-user");
      const orgScope = ScopeId.make("openapi-org");

      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: [
            new Scope({ id: userScope, name: "user", createdAt: new Date() }),
            new Scope({ id: orgScope, name: "org", createdAt: new Date() }),
          ],
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("user-query-token"),
          scope: userScope,
          name: "User query token",
          value: "user-token",
        }),
      );

      const input = {
        spec: specJson,
        scope: String(orgScope),
        namespace: "org_direct_user_credential",
        queryParams: { token: { secretId: "user-query-token" } },
        credentialTargetScope: String(userScope),
      };

      yield* executor.openapi.addSpec(input);

      const bindings = yield* executor.openapi.listSourceBindings(
        "org_direct_user_credential",
        String(orgScope),
      );
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        scopeId: userScope,
        slot: "query_param:token",
        value: { kind: "secret", secretId: SecretId.make("user-query-token") },
      });
    }),
  );

  it.effect("updateSource removes bindings for credential slots no longer present", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("old-token"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "Old token",
          value: "old-secret",
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "stale_binding",
        baseUrl: "",
        credentialTargetScope: TEST_SCOPE,
        headers: {
          "X-Old": { secretId: "old-token" },
        },
      });

      yield* executor.openapi.updateSource("stale_binding", TEST_SCOPE, {
        headers: {},
      });

      const bindings = yield* executor.openapi.listSourceBindings("stale_binding", TEST_SCOPE);
      expect(bindings).toEqual([]);
    }),
  );

  it.effect("updateSource removes stale OAuth2 bindings when the OAuth template changes", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("old-client-id"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "Old client ID",
          value: "client-id",
        }),
      );

      const oldOAuth = new OAuth2SourceConfig({
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
      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "stale_oauth",
        baseUrl: "",
        oauth2: oldOAuth,
      });
      yield* executor.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
          sourceId: "stale_oauth",
          sourceScope: ScopeId.make(TEST_SCOPE),
          scope: ScopeId.make(TEST_SCOPE),
          slot: oldOAuth.clientIdSlot,
          value: { kind: "secret", secretId: SecretId.make("old-client-id") },
        }),
      );

      yield* executor.openapi.updateSource("stale_oauth", TEST_SCOPE, {
        oauth2: new OAuth2SourceConfig({
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
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("test-api-token"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "Test API Token",
          value: "secret-value-123",
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "authed",
        baseUrl: "",
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
      )) as { data: { authorization?: string; "x-static"?: string } | null; error: unknown };

      expect(result.error).toBeNull();
      const data = result.data!;
      expect(data.authorization).toBe("Bearer secret-value-123");
      expect(data["x-static"]).toBe("hello");
    }),
  );

  it.effect("addSpec without credentialTargetScope defaults to the source's scope", () =>
    // Regression: config-sync calls addSpec without ever setting
    // credentialTargetScope. Before the fix, any source with a
    // header secret in executor.jsonc errored with
    // "credentialTargetScope is required when adding direct OpenAPI
    // credentials" the moment the daemon started.
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("config-sync-token"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "Config-sync token",
          value: "secret-from-jsonc",
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "default_target_scope",
        baseUrl: "",
        headers: {
          Authorization: { secretId: "config-sync-token", prefix: "Bearer " },
        },
      });

      const bindings = yield* executor.openapi.listSourceBindings(
        "default_target_scope",
        TEST_SCOPE,
      );
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        scopeId: ScopeId.make(TEST_SCOPE),
        slot: "header:authorization",
        value: { kind: "secret", secretId: SecretId.make("config-sync-token") },
      });
    }),
  );

  it.effect("fails clearly when a secret is missing", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
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
          plugins: [openApiPlugin({ httpClientLayer: clientLayer }), staleSecretPlugin()] as const,
        }),
      );
      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("missing-token"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "Missing token",
          value: "initial-value",
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "noauth",
        baseUrl: "",
        headers: {
          Authorization: new ConfiguredHeaderBinding({
            kind: "binding",
            slot: "header:authorization",
            prefix: "Bearer ",
          }),
        },
      });
      yield* executor.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
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
  );

  it.effect("registers tools from an OpenAPI spec", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      const result = yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "test",
        baseUrl: "",
      });

      expect(result.toolCount).toBeGreaterThanOrEqual(2);

      const tools = yield* executor.tools.list();
      const names = tools.map((t) => t.name);
      expect(names).toContain("items.listItems");
      expect(names).toContain("items.getItem");
    }),
  );

  it.effect("invokes listItems", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "test",
        baseUrl: "",
      });

      const result = (yield* executor.tools.invoke("test.items.listItems", {}, autoApprove)) as {
        data: unknown;
        error: unknown;
      };
      expect(result.error).toBeNull();
      expect(result.data).toEqual(ITEMS);
    }),
  );

  it.effect("invokes getItem with path parameter", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "test",
        baseUrl: "",
      });

      const result = (yield* executor.tools.invoke(
        "test.items.getItem",
        { itemId: "2" },
        autoApprove,
      )) as { data: unknown; error: unknown };
      expect(result.error).toBeNull();
      expect(result.data).toEqual({ id: 2, name: "Gadget" });
    }),
  );

  it.effect("surfaces structured validation errors from OpenAPI tool calls", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "records",
        baseUrl: "",
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
  );

  it.effect("removeSpec cleans up registered tools", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "removable",
        baseUrl: "",
      });

      expect((yield* executor.tools.list()).length).toBeGreaterThan(2);

      yield* executor.openapi.removeSpec("removable", TEST_SCOPE);

      const remaining = yield* executor.tools.list();
      const ids = remaining.map((t) => t.id).sort();
      expect(ids).toEqual(["openapi.addSource", "openapi.previewSpec"]);
    }),
  );

  it.effect("listSourceBindings returns [] for a removed source", () =>
    // Regression: the React bindings atom revalidates after a removeSpec
    // (sourceWriteKeys invalidate it) before unmount. The store used to
    // throw StorageError("source does not exist"), which surfaced to the
    // browser as a 500. A removed source has no bindings — return [].
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "removable",
        baseUrl: "",
      });
      yield* executor.openapi.removeSpec("removable", TEST_SCOPE);

      const bindings = yield* executor.openapi.listSourceBindings("removable", TEST_SCOPE);
      expect(bindings).toEqual([]);
    }),
  );

  // -------------------------------------------------------------------------
  // Multi-scope shadowing — regression suite covering the bug class where
  // store reads/writes that don't pin scope_id collapse onto whichever row
  // the scoped adapter's `scope_id IN (stack)` filter sees first. Each
  // scenario is reproducible against the pre-fix store.
  // -------------------------------------------------------------------------

  const ORG_SCOPE = ScopeId.make("org-scope");
  const USER_SCOPE = ScopeId.make("user-scope");

  const stackedScopes = [
    new Scope({ id: USER_SCOPE, name: "user", createdAt: new Date() }),
    new Scope({ id: ORG_SCOPE, name: "org", createdAt: new Date() }),
  ] as const;

  it.effect("shadowed addSpec does not wipe the outer-scope source", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

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
      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: String(ORG_SCOPE),
        namespace: "shared",
        baseUrl: "",
        name: "Org Source",
      });

      // Per-user shadow with the same namespace
      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: String(USER_SCOPE),
        namespace: "shared",
        name: "User Source",
      });

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
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
      const config = makeTestConfig({
        scopes: stackedScopes,
        plugins: [openApiPlugin({ httpClientLayer: clientLayer }), memorySecretsPlugin()] as const,
      });
      const findManyCalls: FindManyCall[] = [];

      const executor = yield* createExecutor({
        ...config,
        adapter: recordFindMany(config.adapter, findManyCalls),
      });

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: String(ORG_SCOPE),
        namespace: "shared",
        baseUrl: "https://org.example.com",
        name: "Org Source",
      });
      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: String(USER_SCOPE),
        namespace: "shared",
        name: "User Source",
      });

      findManyCalls.length = 0;
      const userView = yield* executor.openapi.getSource("shared", String(USER_SCOPE));

      expect(userView?.config.baseUrl).toBe("https://org.example.com");
      expect(findManyCalls.some((call) => call.model === "openapi_source")).toBe(false);
    }),
  );

  it.effect("removeSpec on user shadow leaves the org row intact", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: String(ORG_SCOPE),
        namespace: "shared",
        baseUrl: "",
        name: "Org Source",
      });
      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: String(USER_SCOPE),
        namespace: "shared",
        baseUrl: "",
        name: "User Source",
      });

      yield* executor.openapi.removeSpec("shared", String(USER_SCOPE));

      const userView = yield* executor.openapi.getSource("shared", String(USER_SCOPE));
      const orgView = yield* executor.openapi.getSource("shared", String(ORG_SCOPE));

      expect(userView).toBeNull();
      expect(orgView?.name).toBe("Org Source");
    }),
  );

  it.effect("updateSource on user shadow cannot override the inherited base URL", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [
            openApiPlugin({ httpClientLayer: clientLayer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: String(ORG_SCOPE),
        namespace: "shared",
        baseUrl: "https://org.example.com",
        name: "Org Source",
      });
      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: String(USER_SCOPE),
        namespace: "shared",
        name: "User Source",
      });

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
    Effect.gen(function* () {
      const server = yield* makeOpenApiTestServer({ spec });
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
        new SetSecretInput({
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
  );

  it.effect(
    "refreshing a user shadow uses inherited spec-fetch credentials without copying them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* Effect.acquireRelease(
            Effect.promise(() => serveSpecRequiringHeader()),
            (server) => Effect.promise(() => server.close()),
          );
          const config = makeTestConfig({
            scopes: stackedScopes,
            plugins: [openApiPlugin(), memorySecretsPlugin()] as const,
          });
          const executor = yield* createExecutor(config);

          yield* executor.secrets.set(
            new SetSecretInput({
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
          yield* executor.openapi.addSpec({
            spec: specJson,
            scope: String(USER_SCOPE),
            namespace: "shared_spec_fetch",
            name: "User Shadow",
          });

          const userRowsBefore = yield* config.adapter.findMany({
            model: "openapi_source_spec_fetch_header",
            where: [
              { field: "scope_id", value: String(USER_SCOPE) },
              { field: "source_id", value: "shared_spec_fetch" },
            ],
          });
          expect(userRowsBefore).toEqual([]);

          const requestsBefore = server.requestCount();
          yield* executor.sources.refresh({
            id: "shared_spec_fetch",
            targetScope: String(USER_SCOPE),
          });

          expect(server.requestCount()).toBeGreaterThan(requestsBefore);
          expect(server.lastToken()).toBe("org-token");
          const orgRowsAfter = yield* config.adapter.findMany({
            model: "openapi_source_spec_fetch_header",
            where: [
              { field: "scope_id", value: String(ORG_SCOPE) },
              { field: "source_id", value: "shared_spec_fetch" },
            ],
          });
          const userRowsAfter = yield* config.adapter.findMany({
            model: "openapi_source_spec_fetch_header",
            where: [
              { field: "scope_id", value: String(USER_SCOPE) },
              { field: "source_id", value: "shared_spec_fetch" },
            ],
          });
          expect(orgRowsAfter).toHaveLength(1);
          expect(userRowsAfter).toEqual([]);
        }),
      ),
  );

  it.effect("addSpec persists OAuth2 source slots with no live connection yet", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);

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
        new SetSecretInput({
          id: SecretId.make("acme-client-id"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "Acme Client ID",
          value: "client-abc",
        }),
      );

      const deferredAuth = new OAuth2SourceConfig({
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

      const result = yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "deferred",
        baseUrl: "https://api.example.com",
        oauth2: deferredAuth,
      });

      expect(result.toolCount).toBeGreaterThan(0);

      const stored = yield* executor.openapi.getSource("deferred", TEST_SCOPE);
      expect(stored).not.toBeNull();
      expect(stored?.config.oauth2?.flow).toBe("authorizationCode");
      expect(stored?.config.oauth2?.connectionSlot).toBe("oauth2:oauth2:connection");
      expect(stored?.config.oauth2?.clientIdSlot).toBe("oauth2:oauth2:client-id");

      yield* executor.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
          sourceId: "deferred",
          sourceScope: ScopeId.make(TEST_SCOPE),
          scope: ScopeId.make(TEST_SCOPE),
          slot: stored!.config.oauth2!.clientIdSlot,
          value: { kind: "secret", secretId: SecretId.make("acme-client-id") },
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
        new SetSecretInput({
          id: SecretId.make("api-key"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "API Key",
          value: "abc123",
          provider: "memory",
        }),
      );

      // Add a source whose query params are canonicalized to a credential slot.
      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "with_secret",
        baseUrl: "http://example.com",
        credentialTargetScope: TEST_SCOPE,
        queryParams: { token: { secretId: "api-key" } },
      });

      // Configure a slot binding pointing at the same secret.
      yield* executor.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
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
        new SetSecretInput({
          id: SecretId.make("locked"),
          scope: ScopeId.make(TEST_SCOPE),
          name: "Locked",
          value: "v",
          provider: "memory",
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "ref",
        baseUrl: "http://example.com",
      });
      yield* executor.openapi.setSourceBinding(
        new OpenApiSourceBindingInput({
          sourceId: "ref",
          sourceScope: ScopeId.make(TEST_SCOPE),
          scope: ScopeId.make(TEST_SCOPE),
          slot: "header:authorization",
          value: { kind: "secret", secretId: SecretId.make("locked") },
        }),
      );

      const failure = yield* executor.secrets
        .remove(
          new RemoveSecretInput({
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
        new RemoveSecretInput({
          id: SecretId.make("locked"),
          targetScope: ScopeId.make(TEST_SCOPE),
        }),
      );
    }),
  );
});
