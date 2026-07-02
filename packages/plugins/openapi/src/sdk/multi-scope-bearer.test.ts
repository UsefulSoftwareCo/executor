// ---------------------------------------------------------------------------
// Owner-isolation bearer-token auth on the OpenAPI plugin (v2).
//
// v1 modelled a Vercel-style "admin uploads the spec once; each user binds the
// shared Authorization slot to their own per-scope secret" flow through the
// scope-partitioning SecretProvider + credential-binding slots. v2 deletes that
// machinery: a connection IS the credential, owner-scoped (org vs user), and a
// connection's value renders through the integration's `authenticationTemplate`.
//
// The surviving, real behaviour: one integration in the catalog, distinct
// connections per owner, each injecting its own token. The org connection's
// value and a user connection's value are isolated and applied independently.
//
// removed: the per-scope-secret-id, slot-binding, source-shadow, and
// "same secret id distinct value per user scope" cases — those exercised the v1
// scope stack + SecretProvider(scope) + credential_binding model that no longer
// exists.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpServerRequest } from "effect/unstable/http";

import {
  createExecutor,
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import {
  serveOpenApiHttpApiTestServer,
  unwrapInvocation,
} from "@executor-js/plugin-openapi/testing";

import { openApiPlugin } from "./plugin";
import { type AuthenticationInput } from "./types";

// ---------------------------------------------------------------------------
// Test API — a single endpoint that echoes the Authorization header so the
// test can assert which owner's token got injected.
// ---------------------------------------------------------------------------

const EchoHeaders = Schema.Struct({
  authorization: Schema.optional(Schema.String),
});

const ProjectsGroup = HttpApiGroup.make("projects").add(
  HttpApiEndpoint.get("list", "/v9/projects", { success: EchoHeaders }),
);

const VercelApi = HttpApi.make("vercelApi").add(ProjectsGroup);

const ProjectsGroupLive = HttpApiBuilder.group(VercelApi, "projects", (handlers) =>
  handlers.handle("list", () =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      return EchoHeaders.make({
        authorization: req.headers["authorization"],
      });
    }),
  ),
);

const serveVercel = () =>
  serveOpenApiHttpApiTestServer({ api: VercelApi, handlersLayer: ProjectsGroupLive });

// Bearer template: the connection value renders into `Authorization: Bearer …`.
const bearerTemplate: AuthenticationInput = {
  slug: AuthTemplateSlug.make("bearer"),
  type: "apiKey",
  headers: { authorization: ["Bearer ", { type: "variable" as const, name: "token" }] },
};

const testPlugins = () =>
  [openApiPlugin({ httpClientLayer: FetchHttpClient.layer }), memoryCredentialsPlugin()] as const;

const VERCEL = IntegrationSlug.make("vercel");
const TEMPLATE = AuthTemplateSlug.make("bearer");
const LIST = "projects.list";

describe("OpenAPI owner-isolated bearer", () => {
  it.effect("org and user connections each inject their own token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveVercel();
        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

        // Admin uploads the spec once; the integration declares a bearer
        // template but no token value.
        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: server.specJson },
          slug: "vercel",
          baseUrl: server.baseUrl,
          authenticationTemplate: [bearerTemplate],
        });

        // An org-shared connection and a user-owned connection, each with their
        // own token.
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("shared"),
          integration: VERCEL,
          template: TEMPLATE,
          value: "org-token",
        });
        yield* executor.connections.create({
          owner: "user",
          name: ConnectionName.make("alice"),
          integration: VERCEL,
          template: TEMPLATE,
          value: "alice-token",
        });

        const orgResult = unwrapInvocation(
          yield* executor.execute(ToolAddress.make(`tools.vercel.org.shared.${LIST}`), {}),
        ).data as { authorization?: string };
        const userResult = unwrapInvocation(
          yield* executor.execute(ToolAddress.make(`tools.vercel.user.alice.${LIST}`), {}),
        ).data as { authorization?: string };

        expect(orgResult.authorization).toBe("Bearer org-token");
        expect(userResult.authorization).toBe("Bearer alice-token");
      }),
    ),
  );
});
