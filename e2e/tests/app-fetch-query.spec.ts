import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { scenarios } from "../test-plan.ts";

const Upstream = Schema.Struct({
  search: Schema.String,
});
const Echo = Schema.Struct({
  search: Schema.String,
  body: Schema.String,
});

const searchOf = (url: string) => {
  const question = url.indexOf("?");
  return question === -1 ? "" : url.slice(question);
};

const cases = [
  { name: "plain", path: "/query", expected: "" },
  { name: "comma", path: "/query?tags=red,blue", expected: "?tags=red,blue" },
  { name: "space", path: "/query?spaces=a%20b", expected: "?spaces=a%20b" },
  { name: "slash-colon", path: "/query?path=a/b:c", expected: "?path=a/b:c" },
  { name: "encoded-equals", path: "/query?q=a%26b%3Dc", expected: "?q=a%26b%3Dc" },
  { name: "empty", path: "/query?empty=", expected: "?empty=" },
  { name: "bare-question-mark", path: "/query?", expected: "?" },
  { name: "fragment", path: "/query?a=1#frag", expected: "?a=1" },
];

const source = (origin: string) => `import {
  decodeJson, defineApp, mutation, object, query, router, string,
} from "apps";
const Upstream = object({ search: string() });
const Echo = object({ search: string(), body: string() });
export default defineApp({}, {
  tools: router({
    fetchQuery: query({ input: object({ path: string() }) }, async (ctx, { path }) => {
      const response = await ctx.fetch(${JSON.stringify(origin)} + path);
      return decodeJson(response, Upstream);
    }),
    sendBody: mutation(
      { input: object({ path: string(), mode: string() }) },
      async (ctx, { path, mode }) => {
        const response = mode === "stream"
          ? await ctx.fetch(${JSON.stringify(origin)} + path, {
              method: "POST",
              duplex: "half",
              body: new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("first,"));
                  controller.enqueue(new TextEncoder().encode("second"));
                  controller.close();
                },
              }),
            })
          : await ctx.fetch(${JSON.stringify(origin)} + path, {
              method: "POST",
              keepalive: true,
              body: "first,second",
            });
        return decodeJson(response, Echo);
      },
    ),
  }),
});`;

layer(HostedLive, { excludeTestServices: true })("App fetch query", (it) => {
  it.effect(scenarios.appFetchQuery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const routes = Layer.mergeAll(
          HttpRouter.add(
            "GET",
            "/query",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              return yield* HttpServerResponse.json({ search: searchOf(request.originalUrl) });
            }),
          ),
          HttpRouter.add(
            "POST",
            "/echo",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const text = yield* request.text;
              return yield* HttpServerResponse.json({
                search: searchOf(request.originalUrl),
                body: text,
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
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "App fetch query proof",
          files: [{ path: "index.ts", content: source(origin) }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
          }).pipe(Effect.orDie),
        );

        for (const entry of cases) {
          const called = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool: "fetchQuery",
            kind: "query",
            input: { path: entry.path },
          });
          yield* evidence.json(`${entry.name}.json`, called);
          expect(called.status, JSON.stringify(called.body)).toBe(200);
          expect(yield* body(Upstream, called)).toEqual({ search: entry.expected });
        }

        for (const mode of ["keepalive", "stream"] as const) {
          const called = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool: "sendBody",
            kind: "mutation",
            input: { path: "/echo?tags=red,blue&spaces=a%20b", mode },
          });
          yield* evidence.json(`body-${mode}.json`, called);
          expect(called.status, JSON.stringify(called.body)).toBe(200);
          expect(yield* body(Echo, called)).toEqual({
            search: "?tags=red,blue&spaces=a%20b",
            body: "first,second",
          });
        }
      }),
    ),
  );
});
