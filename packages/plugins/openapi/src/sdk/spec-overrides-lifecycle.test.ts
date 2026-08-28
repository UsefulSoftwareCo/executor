import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { createExecutor, sha256Hex } from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { openApiPlugin } from "./plugin";
import { applySpecOverrides, type SpecOverrides } from "./spec-overrides";
import { serveMutableOpenApiSpecTestServer } from "../testing";

const testPlugins = () =>
  [openApiPlugin({ httpClientLayer: FetchHttpClient.layer }), memoryCredentialsPlugin()] as const;

const oauthSpec = {
  openapi: "3.1.0",
  info: { title: "Scoped API", version: "1.0.0" },
  paths: {
    "/me": {
      get: {
        operationId: "getMe",
        security: [{ OAuth2: ["current_user:read"] }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: {
    securitySchemes: {
      OAuth2: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://example.com/oauth/authorize",
            tokenUrl: "https://example.com/oauth/token",
            scopes: {
              "current_user:read": "Read the current user",
              "files:read": "Read files",
              "file_variables:read": "Read variables",
            },
          },
        },
      },
    },
  },
  security: [{ OAuth2: ["current_user:read"] }],
};

const scopeOverrides: SpecOverrides = [
  {
    op: "replace",
    path: "/components/securitySchemes/OAuth2/flows/authorizationCode/scopes",
    value: { "current_user:read": "Read the current user" },
  },
];

const encodeJsonText = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

describe("OpenAPI spec override lifecycle", () => {
  it.effect("applies scope overrides to preview and persists raw and patched hashes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
        const sourceText = encodeJsonText(oauthSpec);

        const preview = yield* executor.openapi.previewSpec({
          spec: sourceText,
          specOverrides: scopeOverrides,
        });
        expect(preview.oauth2Presets).toHaveLength(1);
        expect(preview.oauth2Presets[0]?.scopes).toEqual({
          "current_user:read": "Read the current user",
        });

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: sourceText },
          slug: "scoped_api",
          specOverrides: scopeOverrides,
        });

        const config = yield* executor.openapi.getConfig("scoped_api");
        const patchedDocument = yield* applySpecOverrides(oauthSpec, scopeOverrides);
        const patchedText = encodeJsonText(patchedDocument);
        expect(config?.specOverrides).toEqual(scopeOverrides);
        expect(config?.sourceSpecHash).toBe(yield* sha256Hex(sourceText));
        expect(config?.specHash).toBe(yield* sha256Hex(patchedText));
        const oauth = config?.authenticationTemplate?.find((method) => method.kind === "oauth2");
        expect(oauth).toMatchObject({ kind: "oauth2", scopes: ["current_user:read"] });
      }),
    ),
  );

  it.effect("changes and clears overrides for an inline spec without repasting the source", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
        const sourceText = encodeJsonText(oauthSpec);
        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: sourceText },
          slug: "inline_overrides",
          specOverrides: scopeOverrides,
        });

        const titleOverrides: SpecOverrides = [
          { op: "replace", path: "/info/title", value: "Renamed API" },
        ];
        yield* executor.openapi.updateSpec("inline_overrides", {
          specOverrides: titleOverrides,
        });
        const renamed = yield* executor.openapi.getConfig("inline_overrides");
        const renamedDocument = yield* applySpecOverrides(oauthSpec, titleOverrides);
        expect(renamed?.specOverrides).toEqual(titleOverrides);
        expect(renamed?.specHash).toBe(yield* sha256Hex(encodeJsonText(renamedDocument)));
        expect(renamed?.sourceSpecHash).toBe(yield* sha256Hex(sourceText));

        yield* executor.openapi.updateSpec("inline_overrides", { specOverrides: [] });
        const cleared = yield* executor.openapi.getConfig("inline_overrides");
        expect(cleared?.specOverrides).toBeUndefined();
        expect(cleared?.sourceSpecHash).toBeUndefined();
        expect(cleared?.specHash).toBe(yield* sha256Hex(sourceText));
      }),
    ),
  );

  it.effect("reapplies overrides when a URL-hosted spec changes upstream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const Items = HttpApiGroup.make("items")
          .add(HttpApiEndpoint.get("list", "/items", { success: Schema.Array(Schema.String) }))
          .add(HttpApiEndpoint.post("create", "/items", { success: Schema.String }));
        const InitialApi = HttpApi.make("initial").add(Items);
        const server = yield* serveMutableOpenApiSpecTestServer({ initialApi: InitialApi });
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
        const removeList: SpecOverrides = [{ op: "remove", path: "/paths/~1items/get" }];

        yield* executor.openapi.addSpec({
          spec: { kind: "url", url: server.specUrl },
          slug: "refresh_overrides",
          specOverrides: removeList,
        });
        const initialPreview = yield* executor.openapi.previewSpec({
          spec: server.specUrl,
          specOverrides: removeList,
        });
        expect(initialPreview.operations.map((operation) => operation.operationId)).not.toContain(
          "items.list",
        );

        const Widgets = HttpApiGroup.make("widgets").add(
          HttpApiEndpoint.get("list", "/widgets", { success: Schema.Array(Schema.String) }),
        );
        const EvolvedApi = HttpApi.make("evolved").add(Items).add(Widgets);
        yield* server.setApi(EvolvedApi);

        const updated = yield* executor.openapi.updateSpec("refresh_overrides");
        expect(updated.addedTools).toEqual(["widgets.list"]);
        expect(updated.removedTools).toEqual([]);
        const config = yield* executor.openapi.getConfig("refresh_overrides");
        expect(config?.specOverrides).toEqual(removeList);
        expect(Option.isSome(initialPreview.title)).toBe(true);
      }),
    ),
  );
});
