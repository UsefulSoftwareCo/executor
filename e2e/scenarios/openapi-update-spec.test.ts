// Cross-target: updating an OpenAPI spec IN PLACE — the "our API changed,
// don't make me remove/re-add the integration" promise. A real 127.0.0.1
// server serves the spec; after registration + connection the spec evolves
// (one operation removed, one added) and `openapi.updateSpec` re-fetches it.
// The tool catalog follows, the response reports the diff, and everything
// user-curated (connection, description, auth template) survives.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

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

const specV1 = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Evolving API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "Return a pong",
        responses: { "200": { description: "pong" } },
      },
    },
    "/legacy": {
      get: {
        operationId: "legacyOp",
        summary: "Soon to be removed",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const specV2 = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Evolving API", version: "2.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "Return a pong",
        responses: { "200": { description: "pong" } },
      },
    },
    "/widgets": {
      get: {
        operationId: "listWidgets",
        summary: "List widgets",
        responses: { "200": { description: "widgets" } },
      },
    },
  },
});

/** A real 127.0.0.1 server whose served spec can be swapped mid-scenario. */
const serveMutableSpec = (initial: string) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string;
      readonly setBody: (body: string) => void;
      readonly close: () => void;
    }>((resume) => {
      let body = initial;
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}/spec.json`,
            setBody: (next: string) => {
              body = next;
            },
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(server.close),
  );

scenario(
  "OpenAPI · updating the spec rebuilds tools without re-adding the integration",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client } = yield* Api;
      const identity = yield* target.newIdentity();
      const apiClient = yield* client(api, identity);

      const slug = `update-spec-${randomBytes(4).toString("hex")}`;
      const specServer = yield* serveMutableSpec(specV1);

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const added = yield* apiClient.openapi.addSpec({
            payload: {
              spec: { kind: "url", url: specServer.url },
              slug,
              baseUrl: "http://127.0.0.1:59999", // tools are never invoked here
              description: "Curated description that must survive the update.",
              authenticationTemplate: [
                {
                  slug: "apiKey",
                  type: "apiKey",
                  headers: { "x-api-key": [{ type: "variable", name: "token" }] },
                },
              ],
            },
          });
          expect(added.toolCount, "v1 spec has two operations").toBe(2);

          const providers = yield* apiClient.providers.list();
          yield* apiClient.connections.create({
            payload: {
              owner: "org",
              name: ConnectionName.make("main"),
              integration: IntegrationSlug.make(slug),
              template: AuthTemplateSlug.make("apiKey"),
              from: { provider: providers[0]!, id: ProviderItemId.make(randomUUID()) },
            },
          });
          const toolNames = (filter: { integration: string }) =>
            Effect.map(
              apiClient.tools.list({
                query: { integration: IntegrationSlug.make(filter.integration) },
              }),
              (tools) => tools.map((tool) => tool.name).sort(),
            );
          expect(yield* toolNames({ integration: slug }), "v1 tools are live").toEqual([
            "legacy.legacyOp",
            "ping.getOperation",
          ]);

          // The upstream API ships v2: legacyOp is gone, listWidgets appears.
          specServer.setBody(specV2);
          const updated = yield* apiClient.openapi.updateSpec({
            params: { slug },
            payload: {},
          });

          expect(updated.addedTools, "the diff names the new tool").toEqual([
            "widgets.listWidgets",
          ]);
          expect(updated.removedTools, "the diff names the removed tool").toEqual([
            "legacy.legacyOp",
          ]);

          // The connection's catalog follows the new spec — same connection,
          // no re-add.
          expect(yield* toolNames({ integration: slug }), "v2 tools are live").toEqual([
            "ping.getOperation",
            "widgets.listWidgets",
          ]);
          const connections = yield* apiClient.connections.list({
            query: { integration: IntegrationSlug.make(slug) },
          });
          expect(
            connections.map((connection) => String(connection.name)),
            "the connection survived",
          ).toEqual(["main"]);
          const integration = yield* apiClient.integrations.get({
            params: { slug: IntegrationSlug.make(slug) },
          });
          expect(integration.description, "the curated description survived").toBe(
            "Curated description that must survive the update.",
          );
        }),
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
  ),
);
