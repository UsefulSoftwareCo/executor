import { randomUUID } from "node:crypto";
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import {
  makeGreetingGraphqlSchema,
  serveGraphqlTestServer,
} from "@executor-js/plugin-graphql/testing";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";
import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([graphqlHttpPlugin()] as const);

scenario(
  "GraphQL · sandbox calls preserve default and custom request headers",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveGraphqlTestServer({ schema: makeGreetingGraphqlSchema() });

      for (const custom of [false, true]) {
        const slug = IntegrationSlug.make(`graphql_headers_${randomUUID().replaceAll("-", "")}`);
        yield* Effect.gen(function* () {
          yield* client.graphql.addIntegration({
            payload: {
              endpoint: upstream.endpoint,
              slug,
              headers: {
                "X-API-Version": "1",
                ...(custom ? { "uSeR-aGeNt": "example-client/2.0" } : {}),
              },
            },
          });
          yield* client.connections.create({
            payload: {
              owner: "org",
              integration: slug,
              name: ConnectionName.make("main"),
              template: AuthTemplateSlug.make("none"),
              value: "",
            },
          });
          const executed = yield* client.executions.execute({
            payload: {
              code: `return await tools.${slug}.org.main.query.hello({name: "Ada"});`,
              autoApprove: true,
            },
          });
          expect(executed.status).toBe("completed");
          expect(JSON.parse(executed.text)).toEqual({ ok: true, data: { hello: "Hello Ada" } });
          const requests = yield* upstream.requests;
          expect(requests.some((request) => request.payload.query?.includes("__schema"))).toBe(
            true,
          );
          expect(requests.some((request) => request.payload.query?.startsWith("query Hello"))).toBe(
            true,
          );
          for (const request of requests) {
            expect(request.headers["user-agent"]).toBe(
              custom ? "example-client/2.0" : "executor-graphql",
            );
            expect(request.headers["x-api-version"]).toBe("1");
          }
        }).pipe(
          Effect.ensuring(client.integrations.remove({ params: { slug } }).pipe(Effect.ignore)),
        );
        yield* upstream.clearRequests;
      }
    }),
  ),
);
