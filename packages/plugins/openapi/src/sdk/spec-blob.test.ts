// ---------------------------------------------------------------------------
// OpenAPI plugin — spec-in-blob storage coverage.
//
// The resolved spec text must live in the plugin blob store (content-addressed
// `spec/<sha256>`), NOT inline in `integration.config`: the catalog row rides
// along on every integrations list, so a multi-MB inline spec turns a
// metadata read into a bulk transfer. These tests pin:
//   - addSpec stores a pointer config (`specHash`, no inline `spec`) and the
//     blob round-trips through the store,
//   - the e2e path (addSpec → connection → invoke) works off the blob,
//   - legacy rows that still inline `spec` resolve tools unchanged,
//   - remove + re-add of the same spec is idempotent over the shared blob.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpServerRequest } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import {
  createExecutor,
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  sha256Hex,
  type IntegrationConfig,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { variable } from "@executor-js/sdk/http-auth";

import { openApiPlugin } from "./plugin";
import type { OpenapiStore } from "./store";
import type { AuthenticationInput } from "./types";
import { defsBlobKey, specBlobKey } from "./store";
import {
  makeOpenApiHttpApiTestSourceConfig,
  serveOpenApiHttpApiTestServer,
  unwrapInvocation,
} from "../testing";

const testPlugins = (httpClientLayer = FetchHttpClient.layer) =>
  [openApiPlugin({ httpClientLayer }), memoryCredentialsPlugin()] as const;

const EchoHeaders = Schema.Struct({
  "x-api-key": Schema.optional(Schema.String),
});

const EchoGroup = HttpApiGroup.make("items").add(
  HttpApiEndpoint.get("echoHeaders", "/echo-headers", { success: EchoHeaders }),
);
const TestApi = HttpApi.make("testApi").add(EchoGroup);

const EchoGroupLive = HttpApiBuilder.group(TestApi, "items", (handlers) =>
  handlers.handle("echoHeaders", () =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      return EchoHeaders.make({ "x-api-key": req.headers["x-api-key"] });
    }),
  ),
);

const specText = () => {
  const spec = makeOpenApiHttpApiTestSourceConfig(TestApi, {}).spec;
  if (spec.kind === "blob") return spec.value;
  return spec.url;
};

const specTextWithDefinition = () =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Catalog", version: "1.0.0" },
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Item" },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Item: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
  });

const apiKeyTemplate: AuthenticationInput = {
  slug: AuthTemplateSlug.make("apiKey"),
  type: "apiKey",
  headers: { "x-api-key": [variable("token")] },
};

const openApiBlobNamespace = "o:test-tenant/openapi";

describe("OpenAPI plugin — spec blob storage", () => {
  it.effect("addSpec stores a content pointer, not the inline spec text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
        const text = specText();

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: text },
          slug: "blob_api",
        });

        const config = yield* executor.openapi.getConfig("blob_api");
        expect(Object.keys(config ?? {})).not.toContain("spec");
        expect(config?.specHash).toBe(yield* sha256Hex(text));
      }),
    ),
  );

  it.effect("invokes a tool end-to-end off the blob-backed spec", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOpenApiHttpApiTestServer({
          api: TestApi,
          handlersLayer: EchoGroupLive,
        });
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: server.specJson },
          slug: "blob_invoke",
          baseUrl: server.baseUrl,
          authenticationTemplate: [apiKeyTemplate],
        });
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("blob_invoke"),
          template: AuthTemplateSlug.make("apiKey"),
          value: "secret-key-123",
        });

        const result = unwrapInvocation(
          yield* executor.execute(
            ToolAddress.make("tools.blob_invoke.org.main.items.echoHeaders"),
            {},
          ),
        ).data as { "x-api-key"?: string };

        expect(result["x-api-key"]).toBe("secret-key-123");
      }),
    ),
  );

  it.effect(
    "stale sync preserves tools and definitions when the spec blob parses to a non-object",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const config = makeTestConfig({ plugins: testPlugins() });
          const executor = yield* createExecutor(config);
          const text = specTextWithDefinition();
          const hash = yield* sha256Hex(text);

          yield* executor.openapi.addSpec({
            spec: { kind: "blob", value: text },
            slug: "corrupt_blob",
          });
          yield* executor.connections.create({
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make("corrupt_blob"),
            template: AuthTemplateSlug.make("none"),
            values: {},
          });

          const beforeTools = yield* executor.tools.list({
            integration: IntegrationSlug.make("corrupt_blob"),
          });
          const beforeDefinitions = yield* Effect.promise(() =>
            config.db.findMany("definition", {
              where: (b) => b("integration", "=", "corrupt_blob"),
            }),
          );
          expect(beforeTools.length).toBeGreaterThan(0);
          expect(beforeDefinitions.length).toBeGreaterThan(0);

          yield* Effect.promise(() =>
            config.db.updateMany("blob", {
              where: (b) =>
                b.and(b("namespace", "=", openApiBlobNamespace), b("key", "=", specBlobKey(hash))),
              set: { value: JSON.stringify("not an object") },
            }),
          );
          yield* Effect.promise(() =>
            config.db.deleteMany("blob", {
              where: (b) =>
                b.and(b("namespace", "=", openApiBlobNamespace), b("key", "=", defsBlobKey(hash))),
            }),
          );
          yield* Effect.promise(() =>
            config.db.updateMany("connection", {
              where: (b) => b.and(b("integration", "=", "corrupt_blob"), b("name", "=", "main")),
              set: { tools_synced_at: null },
            }),
          );

          const afterTools = yield* executor.tools.list({
            integration: IntegrationSlug.make("corrupt_blob"),
          });
          const afterDefinitions = yield* Effect.promise(() =>
            config.db.findMany("definition", {
              where: (b) => b("integration", "=", "corrupt_blob"),
            }),
          );
          const connection = yield* executor.connections.get({
            owner: "org",
            integration: IntegrationSlug.make("corrupt_blob"),
            name: ConnectionName.make("main"),
          });

          expect(afterTools.map((tool) => String(tool.name)).sort()).toEqual(
            beforeTools.map((tool) => String(tool.name)).sort(),
          );
          expect(afterDefinitions).toHaveLength(beforeDefinitions.length);
          // Sync trouble is catalog metadata, not a health verdict.
          expect(connection?.lastHealth ?? null).toBeNull();
          expect(connection?.toolsSyncError).toMatchObject({
            failures: 1,
            reason: expect.stringContaining("OpenAPI spec could not be parsed"),
          });
        }),
      ),
  );

  it.effect("stale sync preserves tools and definitions when the spec blob is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = makeTestConfig({ plugins: testPlugins() });
        const executor = yield* createExecutor(config);
        const text = specTextWithDefinition();
        const hash = yield* sha256Hex(text);

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: text },
          slug: "missing_blob",
        });
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("missing_blob"),
          template: AuthTemplateSlug.make("none"),
          values: {},
        });

        const beforeTools = yield* executor.tools.list({
          integration: IntegrationSlug.make("missing_blob"),
        });
        const beforeDefinitions = yield* Effect.promise(() =>
          config.db.findMany("definition", {
            where: (b) => b("integration", "=", "missing_blob"),
          }),
        );
        expect(beforeTools.length).toBeGreaterThan(0);
        expect(beforeDefinitions.length).toBeGreaterThan(0);

        yield* Effect.promise(() =>
          config.db.deleteMany("blob", {
            where: (b) =>
              b.and(
                b("namespace", "=", openApiBlobNamespace),
                b("key", "in", [specBlobKey(hash), defsBlobKey(hash)]),
              ),
          }),
        );
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b.and(b("integration", "=", "missing_blob"), b("name", "=", "main")),
            set: { tools_synced_at: null },
          }),
        );

        const afterTools = yield* executor.tools.list({
          integration: IntegrationSlug.make("missing_blob"),
        });
        const afterDefinitions = yield* Effect.promise(() =>
          config.db.findMany("definition", {
            where: (b) => b("integration", "=", "missing_blob"),
          }),
        );
        const connection = yield* executor.connections.get({
          owner: "org",
          integration: IntegrationSlug.make("missing_blob"),
          name: ConnectionName.make("main"),
        });

        expect(afterTools.map((tool) => String(tool.name)).sort()).toEqual(
          beforeTools.map((tool) => String(tool.name)).sort(),
        );
        expect(afterDefinitions).toHaveLength(beforeDefinitions.length);
        // Sync trouble is catalog metadata, not a health verdict.
        expect(connection?.lastHealth ?? null).toBeNull();
        expect(connection?.toolsSyncError).toMatchObject({
          failures: 1,
          reason: expect.stringContaining("OpenAPI spec blob could not be loaded"),
        });
      }),
    ),
  );

  it.effect("explicit spec refresh accepts a valid OpenAPI document with zero operations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
        const emptySpec = JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Empty", version: "1.0.0" },
          paths: {},
        });

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: specText() },
          slug: "healthy_zero",
        });
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("healthy_zero"),
          template: AuthTemplateSlug.make("none"),
          values: {},
        });
        expect(
          (yield* executor.tools.list({ integration: IntegrationSlug.make("healthy_zero") }))
            .length,
        ).toBeGreaterThan(0);

        const update = yield* executor.openapi.updateSpec("healthy_zero", {
          spec: { kind: "blob", value: emptySpec },
        });
        const tools = yield* executor.tools.list({
          integration: IntegrationSlug.make("healthy_zero"),
        });

        expect(update.toolCount).toBe(0);
        expect(tools).toEqual([]);
      }),
    ),
  );

  it.effect("resolveTools reads the spec from the store, never an inline field", () =>
    Effect.gen(function* () {
      const plugin = openApiPlugin({ httpClientLayer: FetchHttpClient.layer });
      const text = specText();
      const hash = yield* sha256Hex(text);
      const storage: OpenapiStore = {
        putOperations: () => Effect.void,
        appendOperations: () => Effect.void,
        getOperation: () => Effect.succeed(null),
        listOperations: () => Effect.succeed([]),
        removeOperations: () => Effect.void,
        putSpec: () => Effect.void,
        getSpec: (specHash) => Effect.succeed(specHash === hash ? text : null),
        putDefs: () => Effect.void,
        getDefs: () => Effect.succeed(null),
      };

      const resolve = (config: IntegrationConfig) =>
        plugin.resolveTools!({
          integration: {
            slug: IntegrationSlug.make("pointer_api"),
            name: "pointer",
            description: "pointer",
            kind: "openapi",
            canRemove: true,
            canRefresh: false,
            authMethods: [],
          },
          config,
          connection: {
            owner: "org",
            integration: IntegrationSlug.make("pointer_api"),
            name: ConnectionName.make("main"),
          },
          template: null,
          storage,
          httpClientLayer: FetchHttpClient.layer,
          getValue: () => Effect.succeed(null),
          getValues: () => Effect.succeed({}),
        });

      const fromPointer = yield* resolve({ specHash: hash } as IntegrationConfig);
      expect(fromPointer.tools.map((tool) => String(tool.name))).toContain("items.echoHeaders");

      // A pre-migration row that still inlines `spec` yields no tools: the
      // spec-to-blob migrations rewrite those rows before this code runs, so
      // the runtime carries no inline-read path.
      const fromInline = yield* resolve({ spec: text } as IntegrationConfig);
      expect(fromInline.tools).toHaveLength(0);
    }),
  );

  it.effect("remove + re-add of the same spec is idempotent over the shared blob", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
        const text = specText();

        yield* executor.openapi.addSpec({ spec: { kind: "blob", value: text }, slug: "re_add" });
        yield* executor.openapi.removeSpec("re_add");
        // The blob deliberately survives removal (another integration may share
        // the hash); re-adding must re-point at it without conflict.
        const second = yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: text },
          slug: "re_add",
        });

        expect(second.toolCount).toBeGreaterThan(0);
        const config = yield* executor.openapi.getConfig("re_add");
        expect(config?.specHash).toBe(yield* sha256Hex(text));
      }),
    ),
  );
});
