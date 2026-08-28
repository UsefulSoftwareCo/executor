// Cross-target: registering an OpenAPI spec turns its operations into tools —
// the core "bring your own API" promise. Entirely through the typed client:
// the openapi plugin group (addSpec) composed onto the core API, then a
// connection via a `from` provider reference (no vault round-trip, so it works
// against the cloud stub), then the operation shows up in the tool catalog.
//
// Registration never calls the spec's server, so none is started here —
// actually invoking the tool against a live server is the follow-up scenario.
import { randomBytes, randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

/** OpenAPI 3 spec with a single GET /greet operation. */
const greetSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Greet API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/greet": {
        get: {
          operationId: "getGreeting",
          summary: "Return a greeting message",
          responses: { "200": { description: "A greeting" } },
        },
      },
    },
  });

scenario(
  "OpenAPI · registering a spec exposes its operations as tools",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const identity = yield* target.newIdentity();
    const apiClient = yield* client(api, identity);

    // Unique slug per run: selfhost shares the bootstrap-admin identity, so
    // the prefix keeps parallel/repeated runs out of each other's catalogs.
    const slug = `openapi-scn-greet-${randomBytes(4).toString("hex")}`;
    const specBaseUrl = "http://127.0.0.1:59999"; // never contacted during registration

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const added = yield* apiClient.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: greetSpec(specBaseUrl) },
            slug,
            baseUrl: specBaseUrl,
            authenticationTemplate: [
              {
                slug: "apiKey",
                type: "apiKey",
                headers: { "x-api-key": [{ type: "variable", name: "token" }] },
              },
            ],
          },
        });
        expect(added.toolCount, "the spec's operations were extracted as tools").toBeGreaterThan(0);
        expect(added.slug, "the integration keeps the requested slug").toBe(slug);

        // The catalog stamps tools once a connection exists; a `from` provider
        // reference avoids any vault round-trip.
        const providers = yield* apiClient.providers.list();
        expect(providers.length, "a credential provider is available").toBeGreaterThan(0);

        yield* apiClient.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("apiKey"),
            from: { provider: providers[0]!, id: ProviderItemId.make(randomUUID()) },
          },
        });

        const tools = yield* apiClient.tools.list({ query: {} });
        const mine = tools.filter((tool) => String(tool.integration) === slug).map((t) => t.name);
        expect(mine.join(", "), "the spec's operation is in the tool catalog").toContain(
          "getGreeting",
        );
      }),
      // Selfhost shares one bootstrap admin, so this scenario must not leak
      // its connection or integration — otherwise a cross-target guarantee
      // like "a fresh identity starts with zero connections" would see it.
      Effect.gen(function* () {
        yield* apiClient.connections
          .remove({
            params: {
              owner: "org",
              integration: IntegrationSlug.make(slug),
              name: ConnectionName.make("main"),
            },
          })
          .pipe(Effect.ignore);
        yield* apiClient.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
      }),
    );
  }),
);
