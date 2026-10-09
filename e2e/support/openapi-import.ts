/** OpenAPI definitions the live importer must explain or read, deployed as public apps. */
import { expect } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Ref } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Actors } from "./actors.ts";
import { Api, body } from "./api.ts";
import { App } from "./contracts.ts";
import { appsManifest } from "./apps-release.ts";
import { createProfile } from "./profiles.ts";

const ok = {
  "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
};

/**
 * Every operation overrides the document server with another host, as Google's definitions do,
 * so an allowed origin taken from the document server matches none of them.
 */
export const otherHostDocument = {
  openapi: "3.0.3",
  info: { title: "Mail", version: "1" },
  servers: [{ url: "https://www.example.com/" }],
  paths: {
    "/mail/v1/users/{userId}/messages": {
      servers: [{ url: "https://mail.example.com/" }],
      get: {
        operationId: "mail.users.messages.list",
        parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }],
        responses: ok,
      },
    },
    "/mail/v1/users/{userId}/labels": {
      servers: [{ url: "https://mail.example.com/" }],
      get: {
        operationId: "mail.users.labels.list",
        parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }],
        responses: ok,
      },
    },
  },
};

/**
 * `getTeam` returns a component whose nested `items` is an array holding a reference, which
 * OpenAPI 3.1 schemas forbid, so it is left out. `listTeams` imports; its `properties: []` is
 * just as invalid, but holds no reference that would go unresolved.
 */
export const invalidSchemaDocument = {
  openapi: "3.1.0",
  info: { title: "Teams", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  components: {
    schemas: {
      Member: { type: "object", properties: { id: { type: "string" } } },
      Team: {
        allOf: [
          { type: "object" },
          {
            type: "object",
            properties: {
              _embedded: {
                type: "object",
                properties: {
                  members: { type: "array", items: [{ $ref: "#/components/schemas/Member" }] },
                },
              },
            },
          },
        ],
      },
    },
  },
  paths: {
    "/teams": {
      get: {
        operationId: "listTeams",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: { type: "array", items: { properties: [] } } },
            },
          },
        },
      },
    },
    "/teams/{team}": {
      get: {
        operationId: "getTeam",
        parameters: [{ name: "team", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Team" } } },
          },
        },
      },
    },
  },
};

/** A Swagger 2.0 definition with a null response, which the 2.0 to 3.0 upgrader cannot read. */
export const malformedSwaggerDocument = {
  swagger: "2.0",
  info: { title: "Status", version: "1" },
  host: "status.example.com",
  schemes: ["https"],
  paths: { "/status": { get: { responses: { "200": null } } } },
};

/**
 * Every operation needs an OAuth client credentials grant, which Executor cannot sign in with, or
 * streams its response.
 */
export const unsupportedAuthDocument = {
  openapi: "3.1.0",
  info: { title: "Jobs", version: "1" },
  servers: [{ url: "https://jobs.example.com" }],
  security: [{ client: [] }],
  paths: {
    "/jobs": { get: { operationId: "listJobs", responses: ok } },
    "/jobs/events": {
      get: {
        operationId: "streamJobEvents",
        responses: { "200": { description: "Events", content: { "text/event-stream": {} } } },
      },
    },
  },
};
export const clientCredentialsScheme = {
  client: {
    type: "oauth2",
    flows: { clientCredentials: { tokenUrl: "https://jobs.example.com/token", scopes: {} } },
  },
};

/** The events every project's `/events` returns, one JSON value per line. */
export const jsonLines = '{"step":"build"}\n{"step":"test"}\n';

/**
 * An OpenAPI 3.2 API whose paths omit the project segment its routes need. It records each
 * request: method, path with query, and body.
 */
export const openapi32Upstream = Effect.gen(function* () {
  const requests = yield* Ref.make<
    readonly { readonly method: string; readonly url: string; readonly body: string }[]
  >([]);
  let origin = "";
  const document = () => ({
    openapi: "3.2.0",
    info: { title: "Builds", version: "1" },
    servers: [{ url: origin }],
    paths: {
      // Neither operation has an operationId, and both are `GET` in the `builds` group.
      "/builds": {
        get: { summary: "List builds", responses: ok },
        query: {
          operationId: "searchBuilds",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string" } },
                  required: ["status"],
                  additionalProperties: false,
                },
              },
            },
          },
          responses: ok,
        },
        additionalOperations: { PURGE: { operationId: "purgeBuilds", responses: ok } },
      },
      "/builds/{build_num}": {
        get: {
          summary: "Read one build",
          parameters: [
            { name: "build_num", in: "path", required: true, schema: { type: "integer" } },
          ],
          responses: ok,
        },
      },
      // A JSON Lines response, whose items OpenAPI 3.2 describes with `itemSchema`.
      "/events": {
        get: {
          summary: "Read build events",
          responses: {
            "200": {
              description: "One event per line",
              content: {
                "application/jsonl": {
                  itemSchema: { type: "object", properties: { step: { type: "string" } } },
                },
              },
            },
          },
        },
      },
      "/artifacts": {
        get: {
          operationId: "findArtifacts",
          parameters: [
            {
              name: "filter",
              in: "querystring",
              required: true,
              content: {
                "application/x-www-form-urlencoded": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      tag: { type: "array", items: { type: "string" } },
                    },
                    required: ["name"],
                    additionalProperties: false,
                  },
                },
              },
            },
          ],
          responses: ok,
        },
      },
    },
  });
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/openapi.json",
          Effect.suspend(() => HttpServerResponse.json(document())),
        ),
        HttpRouter.add(
          "GET",
          "/projects/:project/events",
          Effect.succeed(HttpServerResponse.text(jsonLines, { contentType: "application/jsonl" })),
        ),
        HttpRouter.add(
          "*",
          "/projects/*",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const observed = {
              method: request.method,
              url: request.url,
              body: yield* request.text,
            };
            yield* Ref.update(requests, (previous) => [...previous, observed]);
            return yield* HttpServerResponse.json(observed);
          }),
        ),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  origin = `http://127.0.0.1:${server.address.port}`;
  return { origin, requests: Ref.get(requests) };
});

/** Deploy a public app with the given `index.ts`; it is deleted when the scenario ends. */
export const deployPublicApp = (index: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}/apps`;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
      name: `OpenAPI import ${randomUUID().slice(0, 8)}`,
      files: [{ path: "index.ts", content: index }, appsManifest],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const path = `${prefix}/${(yield* body(App, deployed)).id}`;
    yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
    const profile = yield* createProfile(actors.owner, path);
    return {
      tools: api.request(actors.owner, "GET", `${path}/tools?profile=${profile.id}`),
      tool: (name: string) =>
        api.request(actors.owner, "GET", `${path}/tools/${name}?profile=${profile.id}`),
      call: (tool: string, kind: "query" | "mutation", input: unknown) =>
        api.request(actors.owner, "POST", `${path}/tools/call`, {
          profile: profile.id,
          tool,
          kind,
          input,
        }),
    };
  });
