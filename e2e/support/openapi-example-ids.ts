/**
 * A loopback API whose schemas carry examples that repeat the same `id`, as generated API
 * descriptions often do, imported as a public live OpenAPI app.
 */
import { expect } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Actors } from "./actors.ts";
import { Api, body } from "./api.ts";
import { App } from "./contracts.ts";
import { appsManifest } from "./apps-release.ts";

/**
 * Both schemas hold an `x-examples` object with `id: "string"`, as PagerDuty's description does.
 * Extension values are data, not schemas, and name no schema resource.
 */
const document = (origin: string) => ({
  openapi: "3.0.3",
  info: { title: "Alerts", version: "1" },
  servers: [{ url: origin }],
  components: {
    schemas: {
      IncidentReference: {
        type: "string",
        "x-examples": { "Example 1": { id: "string", type: "incident_reference" } },
      },
      AlertFilter: {
        type: "string",
        "x-examples": { "Example 1": { incident: { id: "string", type: "incident_reference" } } },
      },
    },
  },
  paths: {
    "/alerts": {
      get: {
        operationId: "listAlerts",
        tags: ["alerts"],
        parameters: [
          {
            name: "incident",
            in: "query",
            required: true,
            schema: { $ref: "#/components/schemas/IncidentReference" },
          },
          { name: "filter", in: "query", schema: { $ref: "#/components/schemas/AlertFilter" } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
});

export const openapiExampleIdsFixture = Effect.gen(function* () {
  let origin = "";
  let calls = 0;
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/openapi.json",
      Effect.suspend(() => HttpServerResponse.json(document(origin))),
    ),
    HttpRouter.add(
      "GET",
      "/alerts",
      Effect.gen(function* () {
        calls++;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const query = new URL(request.url, origin).searchParams;
        return yield* HttpServerResponse.json({
          incident: query.get("incident"),
          filter: query.get("filter"),
        });
      }),
    ),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Expected TCP fixture");
  origin = `http://127.0.0.1:${server.address.port}`;
  const api = yield* Api;
  const actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}/apps`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
    name: `Example ids ${randomUUID().slice(0, 8)}`,
    files: [
      {
        path: "index.ts",
        content: `import { defineApp } from 'apps'; import { liveOpenapiRouter } from 'apps/openapi';
export default defineApp({}, async ctx => ({ tools: liveOpenapiRouter({cache:ctx.cache, fetch:ctx.fetch, signal:ctx.signal,
 source:{url:${JSON.stringify(`${origin}/openapi.json`)}}, allowedOrigin:${JSON.stringify(origin)},
 securitySchemes:{}, methods:{}, oauth:[]
}) }));`,
      },
      appsManifest,
    ],
  });
  expect(deployed.status).toBe(200);
  const path = `${prefix}/${(yield* body(App, deployed)).id}`;
  yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
  // The app needs no account, so its tools run without any linked.
  return {
    tools: api.request(actors.owner, "GET", `${path}/tools`),
    call: (query: Readonly<Record<string, string>>) =>
      api.request(actors.owner, "POST", `${path}/tools/call`, {
        tool: "alerts.listAlerts",
        kind: "query",
        input: { query },
      }),
    calls: Effect.sync(() => calls),
  };
});
