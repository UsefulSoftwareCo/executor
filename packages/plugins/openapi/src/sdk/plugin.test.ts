// ---------------------------------------------------------------------------
// OpenAPI plugin — v2 behaviour.
//
// Ported from the v1 suite to the v2 data model. The v1-only coverage (scope
// shadowing, secret-backed credential slots, sources.configure binding
// lifecycle, OAuth2 source-config slots, usagesForSecret, configFile mirroring)
// is removed — those surfaces no longer exist in v2. See the inline
// `// removed:` notes. The behaviours that survive (preview, static control
// tools, addSpec → per-connection tools, invoke + transport envelope, auth
// template rendering, removeSpec) are exercised against the v2 surface:
// addSpec registers an integration, a connection produces the tools, and the
// full `tools.<integration>.<owner>.<connection>.<tool>` address is executed.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpServerRequest } from "effect/unstable/http";

import {
  createExecutor,
  AuthTemplateSlug,
  ConnectionName,
  IntegrationAlreadyExistsError,
  IntegrationSlug,
  ToolAddress,
} from "@executor-js/sdk";
import {
  makeTestConfig,
  memoryCredentialsPlugin,
  typeCheckOutputTypeScript,
} from "@executor-js/sdk/testing";

import { openApiPlugin } from "./plugin";
import { type AuthenticationInput } from "./types";
import {
  addOpenApiTestConnection,
  makeOpenApiHttpApiTestSourceConfig,
  serveOpenApiHttpApiTestServer,
  unwrapInvocation,
} from "../testing";

const TOOL_ERROR_TYPESCRIPT =
  "{ code: string; message: string; status?: number; details?: unknown; retryable?: boolean }";

const testPlugins = (httpClientLayer = FetchHttpClient.layer) =>
  [openApiPlugin({ httpClientLayer }), memoryCredentialsPlugin()] as const;

// ---------------------------------------------------------------------------
// Define a test API with Effect HttpApi
// ---------------------------------------------------------------------------

const Item = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
});

const EchoHeaders = Schema.Struct({
  authorization: Schema.optional(Schema.String),
  "x-api-key": Schema.optional(Schema.String),
});

class QueryValidationError extends Schema.TaggedErrorClass<QueryValidationError>()(
  "QueryValidationError",
  {
    message: Schema.String,
  },
) {}

const ItemsGroup = HttpApiGroup.make("items")
  .add(HttpApiEndpoint.get("listItems", "/items", { success: Schema.Array(Item) }))
  .add(
    HttpApiEndpoint.post("createItem", "/items", {
      payload: Schema.Struct({ name: Schema.String }),
      success: Item,
    }),
  )
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

const testApiSpecText = () => {
  const spec = makeOpenApiHttpApiTestSourceConfig(TestApi, {}).spec;
  if (spec.kind === "blob") return spec.value;
  if (spec.kind === "googleDiscoveryBundle") return spec.urls[0] ?? "";
  return spec.url;
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
    .handle("createItem", (req) =>
      Effect.succeed(Item.make({ id: ITEMS.length + 1, name: req.payload.name })),
    )
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
          "x-api-key": req.headers["x-api-key"],
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

// An apiKey auth template that places the connection value into `x-api-key`.
const apiKeyTemplate: AuthenticationInput = {
  slug: AuthTemplateSlug.make("apiKey"),
  type: "apiKey",
  headers: { "x-api-key": [{ type: "variable" as const, name: "token" }] },
};

// An oauth template — the connection value renders as a bearer token.
const oauthTemplate: AuthenticationInput = {
  slug: AuthTemplateSlug.make("oauth"),
  kind: "oauth2",
  authorizationUrl: "https://auth.example.test/authorize",
  tokenUrl: "https://auth.example.test/token",
  scopes: ["read"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAPI Plugin", () => {
  it.effect("previewSpec returns metadata and header presets", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();

        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        const preview = yield* executor.openapi.previewSpec(server.specJson);

        expect(preview.operationCount).toBeGreaterThanOrEqual(2);
        expect(preview.servers).toBeDefined();
      }),
    ),
  );

  it.effect("exposes static openapi executor control tools via execute", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      // v2: static control tools are NOT part of `tools.list()` (that's the
      // persisted per-connection catalog) and aren't `tools.schema()`-resolvable;
      // they're dispatched by `execute`. Their presence is observable by a
      // successful invocation rather than a catalog listing.
      // removed: tools.list() / getSource / configureSource assertions — those
      // listed v1 static source rows and credential-slot control tools.
      const preview = yield* executor.execute(ToolAddress.make("executor.openapi.previewSpec"), {
        spec: testApiSpecText(),
      });
      expect(preview).toMatchObject({ ok: true });
    }),
  );

  it.effect("invokes static previewSpec through executor.execute", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const preview = unwrapInvocation(
        yield* executor.execute(ToolAddress.make("executor.openapi.previewSpec"), {
          spec: testApiSpecText(),
        }),
      ).data as { operationCount: number; operations?: unknown };

      expect(preview.operationCount).toBeGreaterThanOrEqual(2);
      expect(preview.operations).toBeUndefined();
    }),
  );

  // removed: "describes static previewSpec / addSpec output from Standard Schema"
  // — `tools.schema(address)` only resolves persisted per-connection tool rows
  // in v2 (the address must parse to the 5-segment
  // `tools.<integration>.<owner>.<connection>.<tool>` form). Static control
  // tools live outside the catalog and have no schema-view surface, so these
  // schema-introspection assertions no longer apply.

  it.effect("invokes static addSpec through executor.execute", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const result = unwrapInvocation(
        yield* executor.execute(ToolAddress.make("executor.openapi.addSpec"), {
          spec: { kind: "blob", value: testApiSpecText() },
          slug: "runtime",
        }),
      ).data as { slug: string; toolCount: number };

      expect(result.slug).toBe("runtime");
      expect(result.toolCount).toBeGreaterThanOrEqual(2);

      const integration = yield* executor.openapi.getIntegration("runtime");
      expect(integration?.slug).toBe(IntegrationSlug.make("runtime"));
      expect((yield* executor.integrations.list()).map((i) => String(i.slug))).toContain("runtime");
    }),
  );

  it.effect("static previewSpec returns actionable tool failures", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({ plugins: [openApiPlugin()] as const });
      const executor = yield* createExecutor(config);

      const result = yield* executor.execute(ToolAddress.make("executor.openapi.previewSpec"), {
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

  it.effect("requires approval before adding an integration through the runtime tool", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [openApiPlugin()] as const }),
      );

      const declined = yield* executor
        .execute(
          ToolAddress.make("executor.openapi.addSpec"),
          { spec: { kind: "blob", value: testApiSpecText() }, slug: "runtime_declined" },
          { onElicitation: () => Effect.succeed({ action: "decline" as const }) },
        )
        .pipe(Effect.flip);

      expect(Predicate.isTagged(declined, "ElicitationDeclinedError")).toBe(true);
      expect(yield* executor.openapi.getIntegration("runtime_declined")).toBeNull();
    }),
  );

  it.effect("registers tools from an OpenAPI spec on connection create", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        const conn = yield* addOpenApiTestConnection(executor, server, { slug: "test" });

        const tools = yield* executor.tools.list();
        const names = tools.map((t) => String(t.name));
        // dots in the structured path flatten to `__` in the address segment.
        expect(names).toContain("items.listItems");
        expect(names).toContain("items.getItem");
        expect(String(conn.address("items.listItems"))).toBe("tools.test.org.main.items.listItems");
      }),
    ),
  );

  it.effect("invokes listItems", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        const conn = yield* addOpenApiTestConnection(executor, server, { slug: "test" });

        const result = unwrapInvocation(
          yield* executor.execute(conn.address("items.listItems"), {}),
        );
        expect(result.error).toBeNull();
        expect(result.data).toEqual(ITEMS);
      }),
    ),
  );

  it.effect("requires approval for POST operation annotations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        const conn = yield* addOpenApiTestConnection(executor, server, { slug: "test" });
        const calls = { count: 0 };
        const result = unwrapInvocation(
          yield* executor.execute(
            conn.address("items.createItem"),
            { body: { name: "New item" } },
            {
              onElicitation: () =>
                Effect.sync(() => {
                  calls.count++;
                  return { action: "accept" as const, content: {} };
                }),
            },
          ),
        );

        expect(calls.count).toBe(1);
        expect(result.error).toBeNull();
        expect(result.data).toEqual({ id: 4, name: "New item" });
      }),
    ),
  );

  it.effect("describes OpenAPI invocation results with the transport envelope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        const conn = yield* addOpenApiTestConnection(executor, server, { slug: "test" });

        const schema = yield* executor.tools.schema(conn.address("items.listItems"));
        expect(schema?.outputTypeScript).toContain("status: number");
        expect(schema?.outputTypeScript).toContain("headers:");
        expect(schema?.outputTypeScript).toContain("data:");

        const result = yield* executor.execute(conn.address("items.listItems"), {});
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
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        const conn = yield* addOpenApiTestConnection(executor, server, { slug: "test" });

        const result = unwrapInvocation(
          yield* executor.execute(conn.address("items.getItem"), { itemId: "2" }),
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
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        const conn = yield* addOpenApiTestConnection(executor, server, { slug: "records" });

        const result = unwrapInvocation(
          yield* executor.execute(conn.address("items.queryRows"), {
            entryTypeId: "18538",
            query: JSON.stringify([{ DisplayName: "Example" }]),
            limit: 10,
            skip: 0,
          }),
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

  // -------------------------------------------------------------------------
  // Auth template rendering (D11): the resolved connection value renders into
  // the integration's auth template — apiKey into a header, oauth as a bearer.
  // -------------------------------------------------------------------------

  it.effect("applies an apiKey auth template to the outbound request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: server.specJson },
          slug: "auth_api",
          baseUrl: server.baseUrl,
          authenticationTemplate: [apiKeyTemplate],
        });
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("auth_api"),
          template: AuthTemplateSlug.make("apiKey"),
          value: "secret-key-123",
        });

        const result = unwrapInvocation(
          yield* executor.execute(
            ToolAddress.make("tools.auth_api.org.main.items.echoHeaders"),
            {},
          ),
        ).data as { "x-api-key"?: string };

        expect(result["x-api-key"]).toBe("secret-key-123");
      }),
    ),
  );

  it.effect("applies an oauth auth template as a bearer Authorization header", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: server.specJson },
          slug: "oauth_api",
          baseUrl: server.baseUrl,
          authenticationTemplate: [oauthTemplate],
        });
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("oauth_api"),
          template: AuthTemplateSlug.make("oauth"),
          value: "access-token-abc",
        });

        const result = unwrapInvocation(
          yield* executor.execute(
            ToolAddress.make("tools.oauth_api.org.main.items.echoHeaders"),
            {},
          ),
        ).data as { authorization?: string };

        expect(result.authorization).toBe("Bearer access-token-abc");
      }),
    ),
  );

  it.effect("removeSpec cleans up the integration and its tools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        yield* addOpenApiTestConnection(executor, server, { slug: "removable" });
        expect((yield* executor.tools.list()).map((t) => String(t.name))).toContain(
          "items.listItems",
        );

        yield* executor.openapi.removeSpec("removable");

        expect(yield* executor.openapi.getIntegration("removable")).toBeNull();
        // The persisted per-connection tool catalog is now empty; static control
        // tools still appear in the merged tool list.
        const remaining = (yield* executor.tools.list())
          .map((t) => String(t.address))
          .filter((address) => address.startsWith("tools.removable."));
        expect(remaining).toEqual([]);
      }),
    ),
  );

  it.effect("addSpec blocks re-adding an existing slug with IntegrationAlreadyExistsError", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        // First add carries an apiKey auth template + a distinctive description.
        // A silent upsert on re-add would clobber both.
        const first = yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: server.specJson },
          slug: "dup_api",
          baseUrl: server.baseUrl,
          description: "original",
          authenticationTemplate: [apiKeyTemplate],
        });
        expect(String(first.slug)).toBe("dup_api");

        // Re-adding the same slug must FAIL, not silently upsert/clobber. The
        // re-add intentionally drops the auth template and changes the
        // description so a clobber would be observable below.
        const error = yield* executor.openapi
          .addSpec({
            spec: { kind: "blob", value: server.specJson },
            slug: "dup_api",
            baseUrl: server.baseUrl,
            description: "clobbered",
          })
          .pipe(Effect.flip);

        expect(Predicate.isTagged(error, "IntegrationAlreadyExistsError")).toBe(true);
        expect(String((error as IntegrationAlreadyExistsError).slug)).toBe("dup_api");

        // The original integration must be untouched: same description, same
        // tool count, and the apiKey auth template still present (not clobbered
        // by the rejected re-add's empty template).
        const integration = yield* executor.openapi.getIntegration("dup_api");
        expect(integration?.description).toBe("original");

        const config = yield* executor.openapi.getConfig("dup_api");
        expect(config?.authenticationTemplate?.map((a) => String(a.slug))).toEqual(["apiKey"]);

        // A connection still produces the original tools (proves putOperations
        // was not re-run / the operation rows survive).
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("dup_api"),
          template: AuthTemplateSlug.make("apiKey"),
          value: "secret-key-123",
        });
        const tools = (yield* executor.tools.list()).filter(
          (t) => String(t.address).split(".")[1] === "dup_api",
        );
        expect(tools.length).toBe(first.toolCount);
      }),
    ),
  );

  // removed: the v1-only behaviours below have no v2 equivalent —
  //  - "adds an org source whose direct credentials are owned by the user scope"
  //  - "sources.configure removes bindings for credential slots no longer present"
  //  - "sources.configure removes stale OAuth2 bindings when the OAuth template changes"
  //  - "resolves secret-backed headers at invocation time"
  //  - "addSpec declares secret-backed header shape without a credential value"
  //  - "fails clearly when a secret is missing"
  //  - "executor.sources.remove writes back to configFile"
  //  - "source bindings list returns [] for a removed source"
  //  - "shadowed addSpec does not wipe the outer-scope source"
  //  - "getSource resolves inherited config without listing every OpenAPI source"
  //  - "removeSpec on user shadow leaves the org row intact"
  //  - "sources.configure / addSpec on user shadow cannot override inherited base URL"
  //  - "addSpec persists OAuth2 source slots with no live connection yet"
  //  - "usagesForSecret aggregates header and query-param slot bindings"
  //  - "secrets.remove refuses while an openapi binding still uses it"
  // These all exercised the scope stack + secret/credential-binding/StoredSource
  // credential machinery that the v2 model deletes: secrets are gone, a
  // connection IS the credential, sources became integrations with an opaque
  // config, and the scope stack collapsed to a single owner. Auth is now applied
  // through the integration's `authenticationTemplate` (covered above).
});
