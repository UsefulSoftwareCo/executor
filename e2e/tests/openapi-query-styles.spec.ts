import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { openapiAppFiles } from "../support/authored-templates.ts";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { connectionsPath } from "../support/app-accounts.ts";

const list = { type: "array", items: { type: "string" } };
const document = {
  openapi: "3.1.0",
  info: { title: "Query styles fixture", version: "1" },
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  security: [{ bearer: [] }],
  paths: {
    "/items": {
      get: {
        operationId: "listItems",
        parameters: [
          { name: "tags", in: "query", style: "form", explode: false, schema: list },
          { name: "ids", in: "query", style: "form", explode: true, schema: list },
          { name: "pipes", in: "query", style: "pipeDelimited", explode: false, schema: list },
          { name: "spaces", in: "query", style: "spaceDelimited", explode: false, schema: list },
          {
            name: "filter",
            in: "query",
            style: "deepObject",
            explode: true,
            schema: {
              type: "object",
              properties: { status: { type: "string" }, owner: { type: "string" } },
            },
          },
          {
            name: "rfilter",
            in: "query",
            style: "deepObject",
            explode: true,
            allowReserved: true,
            schema: { type: "object", properties: { status: { type: "string" } } },
          },
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "path", in: "query", allowReserved: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "The query string as the upstream received it",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
};

const cases = [
  [{ tags: ["red", "blue"] }, "tags=red,blue"],
  [{ tags: ["red,blue", "green"] }, "tags=red%2Cblue,green"],
  [{ ids: ["a", "b"] }, "ids=a&ids=b"],
  [{ pipes: ["a", "b"] }, "pipes=a%7Cb"],
  [{ spaces: ["a", "b"] }, "spaces=a%20b"],
  [{ filter: { status: "open", owner: "me" } }, "filter%5Bstatus%5D=open&filter%5Bowner%5D=me"],
  [{ q: "two words" }, "q=two%20words"],
  [{ q: "a&b=c/d?e#f+g" }, "q=a%26b%3Dc%2Fd%3Fe%23f%2Bg"],
  [{ path: "a/b:c" }, "path=a/b:c"],
  [{ rfilter: { status: "a/b" } }, "rfilter%5Bstatus%5D=a/b"],
] as const;

layer(HostedLive, { excludeTestServices: true })("OpenAPI query styles", (it) => {
  it.effect(scenarios.openapiQueryStyles.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        let requests = 0;
        const routes = Layer.mergeAll(
          HttpRouter.add("GET", "/openapi.json", HttpServerResponse.json(document)),
          HttpRouter.add(
            "GET",
            "/items",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              requests++;
              if (request.headers.authorization !== "Bearer synthetic-query-key")
                return HttpServerResponse.empty({ status: 401 });
              return yield* HttpServerResponse.json({
                query: request.originalUrl.split("?")[1] ?? "",
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
        if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
        const origin = `http://127.0.0.1:${server.address.port}`;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Query styles proof",
          files: openapiAppFiles("Query styles proof", {
            url: `${origin}/openapi.json`,
            allowedOrigin: origin,
            baseUrl: origin,
            securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
            key: "bearer",
          }),
        });
        expect(imported.status, JSON.stringify(imported.body)).toBe(200);
        const app = yield* body(App, imported);
        const path = `${prefix}/apps/${app.id}`;
        let account: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            if (account !== undefined)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {}),
        );
        account = (yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            { method: "apiKey", label: "Synthetic key", fields: { token: "synthetic-query-key" } },
          ),
        )).id;
        const received: Array<string> = [];
        for (const [query] of cases) {
          const result = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool: "items.listItems",
            kind: "query",
            input: { accountId: account, input: { query } },
          });
          expect(result.status, JSON.stringify(result.body)).toBe(200);
          received.push((yield* body(Schema.Struct({ query: Schema.String }), result)).query);
        }
        yield* evidence.json("received-queries.json", received);
        expect(received).toEqual(cases.map(([, wire]) => wire));
        for (const value of ["x#y", "x#", "#"]) {
          const refused = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool: "items.listItems",
            kind: "query",
            input: { accountId: account, input: { query: { tags: ["a", "b"], path: value } } },
          });
          expect(refused.status, `${value}: ${JSON.stringify(refused.body)}`).toBe(502);
          expect(JSON.stringify(refused.body)).toContain("could not be encoded");
        }
        expect(requests).toBe(cases.length);
      }),
    ),
  );
});
