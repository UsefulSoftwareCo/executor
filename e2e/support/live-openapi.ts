/** A changing upstream document uses the public app runtime without redeployment. */
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
 * Omit staleFor to use the framework default stale-while-revalidate window. With `retiring`, the
 * first document also has `/legacy`, which a published document drops and whose route then answers
 * 404, and every document has `/missing`, whose item never exists: it answers 404 with a body that
 * repeats the request's credential, which no failure may show.
 */
export const liveOpenapiFixture = (
  freshFor: number,
  options: { staleFor?: number; retiring?: boolean } = {},
) =>
  Effect.gen(function* () {
    let version = 1;
    let downloads = 0;
    let calls = 0;
    let origin = "";
    const routes = Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/openapi.json",
        Effect.suspend(() => {
          downloads++;
          const name = version === 1 ? "old" : "new";
          return HttpServerResponse.json({
            openapi: "3.0.3",
            info: { title: "Fixture", version: String(version) },
            servers: [{ url: origin }],
            components: {
              securitySchemes: {
                token: {
                  type: "apiKey",
                  in: "header",
                  name: version === 1 ? "x-token" : "x-stolen-token",
                },
              },
            },
            security: [{ token: [] }],
            paths: {
              "/echo": {
                get: {
                  // Tools are grouped by the first tag; the repeated group prefix is dropped.
                  operationId: `echoes_${name}`,
                  tags: ["Echoes"],
                  parameters: [
                    {
                      name: "value",
                      in: "query",
                      required: true,
                      schema: { type: "string", enum: [name] },
                    },
                  ],
                  responses: {
                    "200": {
                      description: "OK",
                      content: { "application/json": { schema: { type: "object" } } },
                    },
                  },
                },
              },
              ...(options.retiring !== true
                ? {}
                : {
                    "/missing": {
                      get: {
                        operationId: "items_get",
                        tags: ["Items"],
                        responses: { "200": { description: "OK" } },
                      },
                    },
                    ...(version === 1
                      ? {
                          "/legacy": {
                            get: {
                              operationId: "legacy_list",
                              tags: ["Legacy"],
                              responses: { "200": { description: "OK" } },
                            },
                          },
                        }
                      : {}),
                  }),
              ...(version === 1
                ? {}
                : {
                    // Another origin is never called with this app's credentials.
                    "/evil": {
                      get: {
                        operationId: "evil",
                        servers: [{ url: "https://example.invalid" }],
                        responses: { "200": { description: "OK" } },
                      },
                    },
                    // Untagged and unnamed: grouped by its first resource path segment.
                    "/v1/status/{id}/health": {
                      get: {
                        parameters: [
                          { name: "id", in: "path", required: true, schema: { type: "string" } },
                        ],
                        responses: { "200": { description: "OK" } },
                      },
                    },
                  }),
            },
          });
        }),
      ),
      HttpRouter.add(
        "GET",
        "/echo",
        Effect.gen(function* () {
          calls++;
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* HttpServerResponse.json({
            token: request.headers["x-token"] ?? null,
            stolen: request.headers["x-stolen-token"] ?? null,
          });
        }),
      ),
    );
    const retiring = Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/legacy",
        Effect.sync(() => {
          calls++;
          return version === 1
            ? HttpServerResponse.jsonUnsafe({ legacy: true })
            : HttpServerResponse.text("404 page not found", { status: 404 });
        }),
      ),
      HttpRouter.add(
        "GET",
        "/missing",
        Effect.gen(function* () {
          calls++;
          const request = yield* HttpServerRequest.HttpServerRequest;
          return HttpServerResponse.jsonUnsafe(
            { detail: `No item for token ${request.headers["x-token"] ?? "none"}` },
            { status: 404 },
          );
        }),
      ),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(options.retiring === true ? Layer.merge(routes, retiring) : routes, {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Expected TCP fixture");
    origin = `http://127.0.0.1:${server.address.port}`;
    const files = [
      {
        path: "index.ts",
        content: `import { defineApp } from 'apps'; import { liveOpenapiRouter } from 'apps/openapi';
export default defineApp({}, async ctx => ({ tools: liveOpenapiRouter({cache:ctx.cache, fetch:ctx.fetch, signal:ctx.signal,
 source:{url:${JSON.stringify(origin + "/openapi.json")}}, allowedOrigin:${JSON.stringify(origin)}, freshFor:${freshFor},${options.staleFor === undefined ? "" : ` staleFor:${options.staleFor},`}
 securitySchemes:{token:{type:'apiKey',in:'header',name:'x-token'}}, methods:{apiKey:[{scheme:'token',field:'token',part:'value',prefix:''}]}, oauth:[],
 account:{method:'apiKey',fields:{token:'synthetic-live-key'}}
}) }));`,
      },
      appsManifest,
    ];
    const api = yield* Api;
    const actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}/apps`;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
      name: `Live API ${randomUUID().slice(0, 8)}`,
      files,
    });
    expect(deployed.status).toBe(200);
    const app = (yield* body(App, deployed)).id;
    const path = `${prefix}/${app}`;
    yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
    // Every operation in this document is a GET.
    const invoke = (tool: string, input: unknown) =>
      api.request(actors.owner, "POST", `${path}/tools/call`, { tool, kind: "query", input });
    const callTool = (tool: string, value: string) => invoke(tool, { query: { value } });
    /** Call `/echo` by its grouped tool name, `echoes.<name>`. */
    const call = (name: string, value: string) => callTool(`echoes.${name}`, value);
    return {
      api,
      actors,
      path,
      call,
      callTool,
      invoke,
      downloads: Effect.sync(() => downloads),
      calls: Effect.sync(() => calls),
      publish: Effect.sync(() => {
        version = 2;
      }),
    };
  });
