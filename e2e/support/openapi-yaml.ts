/** YAML OpenAPI documents served by a loopback upstream, each imported as a public live app. */
import { expect } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Actors } from "./actors.ts";
import { Api, body } from "./api.ts";
import { App } from "./contracts.ts";
import { createProfile } from "./profiles.ts";
import { appsManifest } from "./apps-release.ts";

/** Operations share a parameter and a schema through YAML anchors. */
const aliased = (origin: string) => `openapi: 3.0.3
info: { title: Aliased, version: "1" }
servers: [{ url: "${origin}" }]
x-shared:
  limit: &limit { name: limit, in: query, schema: { type: integer, minimum: 1 } }
  item: &item
    type: object
    properties:
      id: { type: string }
      labels: { type: array, items: { type: string } }
paths:
  /items:
    get:
      operationId: listItems
      tags: [items]
      parameters: [*limit]
      responses:
        "200":
          description: OK
          content: { application/json: { schema: { type: array, items: *item } } }
  /items/{id}:
    get:
      operationId: getItem
      tags: [items]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - *limit
      responses:
        "200":
          description: OK
          content: { application/json: { schema: *item } }
`;

/** Nine levels of nine aliases: a few hundred bytes that expand to hundreds of millions of values. */
const aliasBomb = (origin: string) => {
  const levels = [`  a0: &a0 [${Array.from({ length: 9 }, () => "lol").join(", ")}]`];
  for (let level = 1; level < 9; level++)
    levels.push(
      `  a${level}: &a${level} [${Array.from({ length: 9 }, () => `*a${level - 1}`).join(", ")}]`,
    );
  return `openapi: 3.0.3
info: { title: Bomb, version: "1" }
servers: [{ url: "${origin}" }]
x-expansion:
${levels.join("\n")}
paths:
  /ping:
    get:
      operationId: ping
      responses: { "200": { description: OK } }
`;
};

export const openapiYamlFixture = Effect.gen(function* () {
  let origin = "";
  const yaml = (text: () => string) =>
    Effect.sync(() => HttpServerResponse.text(text(), { contentType: "application/yaml" }));
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/aliased.yaml",
      yaml(() => aliased(origin)),
    ),
    HttpRouter.add(
      "GET",
      "/bomb.yaml",
      yaml(() => aliasBomb(origin)),
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
  /** Deploy a public app over one of the served documents. */
  const deploy = (document: "aliased" | "bomb") =>
    Effect.gen(function* () {
      const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
        name: `YAML ${document} ${randomUUID().slice(0, 8)}`,
        files: [
          {
            path: "index.ts",
            content: `import { defineApp } from 'apps'; import { liveOpenapiRouter } from 'apps/openapi';
export default defineApp({accounts:{}}, async ctx => ({ tools: liveOpenapiRouter({cache:ctx.cache, fetch:ctx.fetch, signal:ctx.signal,
 source:{url:${JSON.stringify(`${origin}/${document}.yaml`)}}, allowedOrigin:${JSON.stringify(origin)},
 securitySchemes:{}, methods:{}, oauth:[]
}) }));`,
          },
          appsManifest,
        ],
      });
      expect(deployed.status).toBe(200);
      const path = `${prefix}/${(yield* body(App, deployed)).id}`;
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
      );
      const profile = yield* createProfile(actors.owner, path);
      return {
        tools: api.request(actors.owner, "GET", `${path}/tools?profile=${profile.id}`),
      };
    });
  return { deploy };
});
