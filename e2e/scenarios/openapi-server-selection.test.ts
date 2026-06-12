// Cross-target: when a spec declares more than one server, per-call server
// selection becomes a first-class tool input. The generated tool advertises an
// optional `server` selector — a `url` enum over the declared servers plus the
// `{variables}` drawn from the templated one — so an agent can choose where each
// call goes. Adding the spec with NO baseUrl also proves the base URL is now an
// optional override: the host is resolved per call from the spec's servers.
//
// Entirely through the typed client: addSpec → connection (via a `from` provider
// reference, so no vault round-trip — works against the cloud stub) → read the
// tool's schema and assert the `server` input this feature introduces.
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

// The operation inherits two document-level servers: a fixed production URL and
// a templated regional sandbox whose `{region}` is a per-call variable.
const PROD_SERVER = "https://api.example.test/v1";
const SANDBOX_SERVER = "https://{region}.sandbox.example.test/v1";

const multiServerSpec = (): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Regions API", version: "1.0.0" },
    servers: [
      { url: PROD_SERVER, description: "Production" },
      {
        url: SANDBOX_SERVER,
        description: "Regional sandbox",
        variables: {
          region: { default: "us", enum: ["us", "eu", "ap"], description: "Sandbox region" },
        },
      },
    ],
    paths: {
      "/ping": {
        get: {
          operationId: "ping",
          summary: "Health check",
          responses: { "200": { description: "pong" } },
        },
      },
    },
  });

// Minimal structural view of the JSON Schema we assert against.
type ServerInputSchema = {
  readonly properties?: {
    readonly server?: {
      readonly properties?: {
        readonly url?: { readonly enum?: readonly unknown[]; readonly default?: unknown };
        readonly variables?: {
          readonly properties?: Record<
            string,
            { readonly enum?: readonly unknown[]; readonly default?: unknown }
          >;
        };
      };
    };
  };
};

scenario(
  "OpenAPI · a multi-server spec advertises a per-call server selector on its tools",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const identity = yield* target.newIdentity();
    const apiClient = yield* client(api, identity);

    // Unique slug per run: selfhost shares the bootstrap-admin identity, so the
    // prefix keeps parallel/repeated runs out of each other's catalogs.
    const slug = `openapi-scn-servers-${randomBytes(4).toString("hex")}`;

    yield* Effect.ensuring(
      Effect.gen(function* () {
        // Add the spec with NO baseUrl — the host is resolved per call from the
        // spec's servers, so a base URL is purely an optional override now.
        const added = yield* apiClient.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: multiServerSpec() },
            slug,
            authenticationTemplate: [
              {
                slug: "apiKey",
                type: "apiKey",
                headers: { "x-api-key": [{ type: "variable", name: "token" }] },
              },
            ],
          },
        });
        expect(added.toolCount, "the spec's operation became a tool").toBeGreaterThan(0);

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

        // Locate the generated tool and read its full input schema.
        const tools = yield* apiClient.tools.list({ query: {} });
        const ping = tools.find(
          (tool) => String(tool.integration) === slug && String(tool.name).includes("ping"),
        );
        expect(ping?.address, "the ping tool is in the catalog").toBeDefined();

        const view = yield* apiClient.tools.schema({ query: { address: ping!.address } });
        const input = view.inputSchema as ServerInputSchema;
        const serverInput = input.properties?.server?.properties;

        // The per-call `server` input exists: `url` is an enum over BOTH declared
        // servers (raw templates), defaulting to the first.
        expect(serverInput?.url?.enum, "server.url enumerates the declared servers").toEqual([
          PROD_SERVER,
          SANDBOX_SERVER,
        ]);
        expect(serverInput?.url?.default, "server.url defaults to the first server").toBe(
          PROD_SERVER,
        );

        // …and the templated server's `{region}` surfaces as a per-call variable
        // carrying its spec enum and default.
        const region = serverInput?.variables?.properties?.region;
        expect(region?.enum, "server.variables.region carries the spec enum").toEqual([
          "us",
          "eu",
          "ap",
        ]);
        expect(region?.default, "server.variables.region keeps the spec default").toBe("us");
      }),
      // Selfhost shares one bootstrap admin, so this scenario must not leak its
      // connection or integration into other scenarios' zero-state assertions.
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
