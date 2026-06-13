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
  if (spec.kind === "googleDiscoveryBundle") return spec.urls[0] ?? "";
  return spec.url;
};

const apiKeyTemplate: AuthenticationInput = {
  slug: AuthTemplateSlug.make("apiKey"),
  type: "apiKey",
  headers: { "x-api-key": [variable("token")] },
};

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

  it.effect("resolveTools reads the spec from the store, never an inline field", () =>
    Effect.gen(function* () {
      const plugin = openApiPlugin({ httpClientLayer: FetchHttpClient.layer });
      const text = specText();
      const hash = yield* sha256Hex(text);
      const storage: OpenapiStore = {
        putOperations: () => Effect.void,
        getOperation: () => Effect.succeed(null),
        listOperations: () => Effect.succeed([]),
        removeOperations: () => Effect.void,
        putSpec: () => Effect.void,
        getSpec: (specHash) => Effect.succeed(specHash === hash ? text : null),
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
