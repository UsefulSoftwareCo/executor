// ---------------------------------------------------------------------------
// OpenAPI plugin — `configure` (add custom auth method) coverage.
//
// `configure` appends an `APIKeyAuthentication` template to an existing
// integration's opaque config. These tests exercise the extension method
// directly (the same path the HTTP `configure` handler calls):
//   - round-trip: add a custom apiKey method → `getConfig` shows it with the
//     correct header/query placements,
//   - slug generation: a method with no slug is assigned `custom_<id>`,
//   - slug uniqueness/dedupe: a method whose slug matches an existing entry
//     replaces it rather than duplicating, and two slug-less methods in one call
//     get distinct generated slugs,
//   - the merged template renders against a connection value at invoke time.
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
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { openApiPlugin } from "./plugin";
import type { APIKeyAuthentication, Authentication, AuthenticationInput } from "./types";
import { variable } from "@executor-js/sdk/http-auth";
import {
  makeOpenApiHttpApiTestSourceConfig,
  serveOpenApiHttpApiTestServer,
  unwrapInvocation,
} from "../testing";

const testPlugins = (httpClientLayer = FetchHttpClient.layer) =>
  [openApiPlugin({ httpClientLayer }), memoryCredentialsPlugin()] as const;

// A tiny echo-headers spec so a rendered template can be observed end-to-end.
const EchoHeaders = Schema.Struct({
  authorization: Schema.optional(Schema.String),
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
      return EchoHeaders.make({
        authorization: req.headers["authorization"],
        "x-api-key": req.headers["x-api-key"],
      });
    }),
  ),
);

const servePluginTestApi = () =>
  serveOpenApiHttpApiTestServer({ api: TestApi, handlersLayer: EchoGroupLive });

const specText = () => {
  const spec = makeOpenApiHttpApiTestSourceConfig(TestApi, {}).spec;
  if (spec.kind === "blob") return spec.value;
  return spec.url;
};

// A custom apiKey method that places the connection value into `x-api-key`,
// authored request-shaped (the one apikey input dialect).
const customApiKey: AuthenticationInput = {
  slug: "my_custom",
  type: "apiKey",
  headers: { "x-api-key": [variable("token")] },
};

// Build an apiKey method WITHOUT a slug — simulating an untyped JSON caller that
// omits it, which `configure` should backfill with a generated `custom_<id>`.
// The cast is confined to this one boundary helper.
const sluglessApiKey = (
  template: Omit<AuthenticationInput & { type: "apiKey" }, "slug" | "type">,
): AuthenticationInput => ({ type: "apiKey", ...template });

describe("OpenAPI Plugin — configure (custom auth method)", () => {
  it.effect("adds a custom apiKey method and getConfig reflects it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: specText() },
          slug: "cfg_api",
        });

        const merged = yield* executor.openapi.configure("cfg_api", {
          authenticationTemplate: [customApiKey],
        });

        expect(merged).toHaveLength(1);
        expect(String(merged[0]!.slug)).toBe("my_custom");

        const config = yield* executor.openapi.getConfig("cfg_api");
        const template = (config?.authenticationTemplate ?? []) as readonly Authentication[];
        expect(template).toHaveLength(1);
        const entry = template[0] as APIKeyAuthentication;
        expect(entry.kind).toBe("apikey");
        expect(String(entry.slug)).toBe("my_custom");
        // The placement preserves the canonical `token` input (stored absent).
        expect(entry.placements).toEqual([{ carrier: "header", name: "x-api-key" }]);
      }),
    ),
  );

  it.effect("appends to an existing spec-derived template without dropping entries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        const seedTemplate: AuthenticationInput = {
          slug: "seed",
          type: "apiKey",
          headers: { authorization: ["Bearer ", variable("token")] },
        };

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: specText() },
          slug: "cfg_append",
          authenticationTemplate: [seedTemplate],
        });

        const merged = yield* executor.openapi.configure("cfg_append", {
          authenticationTemplate: [customApiKey],
        });

        expect(merged.map((m: Authentication) => String(m.slug))).toEqual(["seed", "my_custom"]);
      }),
    ),
  );

  it.effect("generates a custom_<id> slug for a method submitted without one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: specText() },
          slug: "cfg_genslug",
        });

        const slugless = sluglessApiKey({ headers: { "x-api-key": [variable("token")] } });

        const merged = yield* executor.openapi.configure("cfg_genslug", {
          authenticationTemplate: [slugless],
        });

        expect(merged).toHaveLength(1);
        expect(String(merged[0]!.slug)).toMatch(/^custom_[a-z0-9]+$/);
      }),
    ),
  );

  it.effect("dedupes: a matching slug replaces in place; two slugless get distinct slugs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: specText() },
          slug: "cfg_dedupe",
          authenticationTemplate: [customApiKey],
        });

        // Re-submit the same slug with a different placement → replace in place.
        const replacement: AuthenticationInput = {
          slug: "my_custom",
          type: "apiKey",
          headers: { "x-other": [variable("token")] },
        };
        const slugless = sluglessApiKey({ queryParams: { api_key: [variable("token")] } });
        const slugless2 = sluglessApiKey({ queryParams: { token: [variable("token")] } });

        const merged = yield* executor.openapi.configure("cfg_dedupe", {
          authenticationTemplate: [replacement, slugless, slugless2],
        });

        // my_custom replaced (still one), plus two generated → three total.
        const slugs = merged.map((m: Authentication) => String(m.slug));
        expect(slugs.filter((s: string) => s === "my_custom")).toHaveLength(1);
        expect(merged).toHaveLength(3);
        const generated = slugs.filter((s: string) => s.startsWith("custom_"));
        expect(generated).toHaveLength(2);
        // Generated slugs are distinct.
        expect(new Set(generated).size).toBe(2);
        // The replacement took effect (new header placement).
        const replaced = merged.find(
          (m: Authentication) => String(m.slug) === "my_custom",
        ) as APIKeyAuthentication;
        expect(replaced.placements).toEqual([{ carrier: "header", name: "x-other" }]);
      }),
    ),
  );

  it.effect("replace mode overwrites the auth template array", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        const seedTemplate: AuthenticationInput = {
          slug: "seed",
          type: "apiKey",
          headers: { authorization: ["Bearer ", variable("token")] },
        };

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: specText() },
          slug: "cfg_replace",
          authenticationTemplate: [seedTemplate, customApiKey],
        });

        const merged = yield* executor.openapi.configure("cfg_replace", {
          authenticationTemplate: [seedTemplate],
          mode: "replace",
        });

        expect(merged.map((m: Authentication) => String(m.slug))).toEqual(["seed"]);
      }),
    ),
  );

  it.effect("a configured custom method renders against a connection value at invoke time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: server.specJson },
          slug: "cfg_invoke",
          baseUrl: server.baseUrl,
        });

        yield* executor.openapi.configure("cfg_invoke", {
          authenticationTemplate: [customApiKey],
        });

        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("cfg_invoke"),
          template: AuthTemplateSlug.make("my_custom"),
          value: "configured-secret",
        });

        const result = unwrapInvocation(
          yield* executor.execute(
            ToolAddress.make("tools.cfg_invoke.org.main.items.echoHeaders"),
            {},
          ),
        ).data as { "x-api-key"?: string };

        expect(result["x-api-key"]).toBe("configured-secret");
      }),
    ),
  );

  it.effect("the request-shaped dialect configures a method and renders on the wire", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* servePluginTestApi();
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: server.specJson },
          slug: "cfg_authored",
          baseUrl: server.baseUrl,
        });

        // Authored request-shaped; stored canonical.
        yield* executor.openapi.configure("cfg_authored", {
          authenticationTemplate: [
            {
              slug: "bearer",
              type: "apiKey",
              headers: { authorization: ["Bearer ", variable("token")] },
            },
          ],
        });

        const config = yield* executor.openapi.getConfig("cfg_authored");
        expect(config?.authenticationTemplate?.[0]).toEqual({
          slug: "bearer",
          kind: "apikey",
          placements: [{ carrier: "header", name: "authorization", prefix: "Bearer " }],
        });

        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("cfg_authored"),
          template: AuthTemplateSlug.make("bearer"),
          value: "authored-secret",
        });

        const result = unwrapInvocation(
          yield* executor.execute(
            ToolAddress.make("tools.cfg_authored.org.main.items.echoHeaders"),
            {},
          ),
        ).data as { authorization?: string };
        expect(result.authorization).toBe("Bearer authored-secret");
      }),
    ),
  );

  it.effect("getConfig returns null for an unknown integration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
        expect(yield* executor.openapi.getConfig("nope")).toBeNull();
      }),
    ),
  );
});
