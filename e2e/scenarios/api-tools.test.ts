// Cross-target: the typed API surface, exactly as a consumer uses it. Every
// target serves the composed Executor API under /api, so one scenario runs
// against all of them.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "API Tools Scenario", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        responses: { "200": { description: "pong" } },
      },
    },
  },
});

scenario(
  "API · typed client lists the available tools",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const identity = yield* target.newIdentity();
    const typedClient = yield* client(api, identity);
    const tools = yield* typedClient.tools.list({ query: {} });
    expect(tools.length, "at least one tool is exposed").toBeGreaterThan(0);
  }),
);

scenario(
  "API · the typed client lists the connection it created",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const identity = yield* target.newIdentity();
    const typedClient = yield* client(api, identity);
    const integration = IntegrationSlug.make(`api-tools-${randomBytes(4).toString("hex")}`);
    const name = ConnectionName.make(`api${randomBytes(4).toString("hex")}`);
    const template = AuthTemplateSlug.make("apiKey");

    yield* Effect.gen(function* () {
      yield* typedClient.openapi.addSpec({
        payload: {
          spec: { kind: "blob", value: pingSpec },
          slug: integration,
          baseUrl: "http://127.0.0.1:59999",
          authenticationTemplate: [
            {
              slug: template,
              type: "apiKey",
              headers: {
                authorization: ["Bearer ", { type: "variable", name: "token" }],
              },
            },
          ],
        },
      });
      yield* typedClient.connections.create({
        payload: {
          owner: "org",
          integration,
          name,
          template,
          value: "scenario-local-token",
        },
      });

      const connections = yield* typedClient.connections.list({ query: { integration } });
      expect(
        connections.map((connection) => ({
          integration: connection.integration,
          name: connection.name,
          owner: connection.owner,
        })),
        "the list contains exactly the connection created by this scenario",
      ).toEqual([{ integration, name, owner: "org" }]);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* typedClient.connections
            .remove({ params: { owner: "org", integration, name } })
            .pipe(Effect.ignore);
          yield* typedClient.openapi
            .removeSpec({ params: { slug: integration } })
            .pipe(Effect.ignore);
        }),
      ),
    );
  }),
);
