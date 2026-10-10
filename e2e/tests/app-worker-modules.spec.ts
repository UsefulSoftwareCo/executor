/**
 * A cold app Worker runs whichever framework entries its app imports. Apps built on the MCP,
 * GraphQL and OpenAPI entries link and call their upstream from a cold start. An app that imports a
 * computed specifier can still load a framework entry it never names statically.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest, withApps, mcpSdkVersion } from "../support/apps-release.ts";

const Rpc = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
});
const Graphql = Schema.Struct({ query: Schema.String });
const scalar = { kind: "SCALAR", name: "String", ofType: null };
const graphqlType = (kind: string, name: string, fields: Schema.Json = null) => ({
  kind,
  name,
  fields,
  inputFields: null,
  enumValues: null,
});

/** One synthetic upstream for each framework entry: an MCP server, an OpenAPI API and a GraphQL API. */
const upstream = Effect.gen(function* () {
  const mcp = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rpc = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rpc)));
    if (rpc.id === undefined) return HttpServerResponse.empty({ status: 202 });
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "synthetic-modules", version: "1" },
          }
        : rpc.method === "tools/list"
          ? {
              tools: [
                {
                  name: "echo",
                  description: "Synthetic echo",
                  inputSchema: { type: "object", properties: {} },
                  annotations: { readOnlyHint: true },
                },
              ],
            }
          : rpc.method === "tools/call"
            ? { content: [{ type: "text", text: "mcp" }], structuredContent: { entry: "mcp" } }
            : {};
    return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: rpc.id, result });
  }).pipe(Effect.orDie);
  const graphql = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { query } = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Graphql)));
    return HttpServerResponse.jsonUnsafe(
      query.includes("__schema")
        ? {
            data: {
              __schema: {
                queryType: { name: "Query" },
                mutationType: null,
                types: [
                  graphqlType("OBJECT", "Query", [
                    { name: "entry", description: "Synthetic entry", args: [], type: scalar },
                  ]),
                  graphqlType("SCALAR", "String"),
                ],
              },
            },
          }
        : { data: { entry: "graphql" } },
    );
  }).pipe(Effect.orDie);
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add("POST", "/mcp", mcp),
        HttpRouter.add("GET", "/entry", HttpServerResponse.json({ entry: "openapi" })),
        HttpRouter.add("POST", "/graphql", graphql),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("The upstream requires a TCP listener");
  return `http://127.0.0.1:${server.address.port}`;
});

const plain = `import { defineApp, query, object, string, router } from "apps";
export const ping = query({ input: object({}), output: string() }, async () => "plain");
export default defineApp({ accounts: {} }, { tools: router({ ping }) });`;

/** The specifier is computed, so no static scan can see that the app loads `apps/graphql`. */
const computed = `import { defineApp, query, object, string, router } from "apps";
const entry = ["apps", "graphql"].join("/");
export const ping = query({ input: object({}), output: string() }, async () => {
  const graphql = await import(entry);
  return typeof graphql.graphqlRouter;
});
export default defineApp({ accounts: {} }, { tools: router({ ping }) });`;

/** An app whose only tools come from one framework entry's router over the upstream. */
const entryApps = (origin: string) => [
  {
    entry: "mcp",
    dependencies: { "@modelcontextprotocol/sdk": mcpSdkVersion },
    tool: "remote.echo",
    source: `import { defineApp, router } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({ accounts: {} }, async ({ signal }) => ({
  tools: router({ remote: await mcpRouter({ url: ${JSON.stringify(`${origin}/mcp`)}, signal }) }),
}));`,
  },
  {
    entry: "openapi",
    dependencies: {},
    tool: "remote.entries.read",
    source: `import { defineApp, router } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
export default defineApp({ accounts: {} }, async ({ cache, fetch, signal }) => ({
  tools: router({
    remote: liveOpenapiRouter({
      cache, fetch, signal,
      source: { document: ${JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Entry API", version: "1" },
        servers: [{ url: origin }],
        paths: {
          "/entry": {
            get: {
              operationId: "read",
              tags: ["entries"],
              responses: {
                "200": {
                  description: "OK",
                  content: { "application/json": { schema: { type: "object" } } },
                },
              },
            },
          },
        },
      })} },
      allowedOrigin: ${JSON.stringify(origin)},
      securitySchemes: {}, methods: {}, oauth: [],
    }),
  }),
}));`,
  },
  {
    entry: "graphql",
    dependencies: { graphql: "16.11.0" },
    tool: "remote.query_entry",
    source: `import { defineApp, router } from "apps";
import { graphqlRouter } from "apps/graphql";
export default defineApp({ accounts: {} }, async ({ signal }) => ({
  tools: router({ remote: await graphqlRouter({ url: ${JSON.stringify(`${origin}/graphql`)}, signal }) }),
}));`,
  },
];

layer(HostedLive, { excludeTestServices: true })("App Worker modules", (it) => {
  it.effect(scenarios.appWorkerModules.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deploy = (
          name: string,
          files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
        ) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files,
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            const path = `${prefix}/apps/${app.id}`;
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
            );
            return path;
          });
        /** Call one of the app's tools for the first time, so its Worker starts cold. */
        const coldCall = (path: string, tool: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
              tool,
              input: {},
              kind: "query",
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return response.body;
          });

        expect(
          yield* coldCall(
            yield* deploy("Plain modules", [{ path: "index.ts", content: plain }, appsManifest]),
            "ping",
          ),
        ).toBe("plain");

        const origin = yield* upstream;
        for (const app of entryApps(origin)) {
          const called = yield* coldCall(
            yield* deploy(`${app.entry} modules`, [
              { path: "index.ts", content: app.source },
              {
                path: "package.json",
                content: JSON.stringify({ dependencies: withApps(app.dependencies) }),
              },
            ]),
            app.tool,
          );
          expect(
            JSON.stringify(called),
            `The ${app.entry} tool reaches its upstream through apps/${app.entry}`,
          ).toContain(`"${app.entry}"`);
        }

        const open = yield* coldCall(
          yield* deploy("Computed import", [{ path: "index.ts", content: computed }, appsManifest]),
          "ping",
        );
        expect(open, "The computed import loads the GraphQL entry").toBe("function");
      }),
    ),
  );
});
