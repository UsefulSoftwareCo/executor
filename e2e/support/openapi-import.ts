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

const ok = {
  "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
};

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

export const malformedSwaggerDocument = {
  swagger: "2.0",
  info: { title: "Status", version: "1" },
  host: "status.example.com",
  schemes: ["https"],
  paths: { "/status": { get: { responses: { "200": null } } } },
};

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

export const jsonLines = '{"step":"build"}\n{"step":"test"}\n';

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

export const credentialEchoUpstream = Effect.gen(function* () {
  const services = yield* Layer.build(
    HttpRouter.serve(
      HttpRouter.add(
        "*",
        "/*",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* HttpServerResponse.json({
            method: request.method,
            url: request.url,
            authorization: request.headers.authorization ?? null,
          });
        }),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return { origin: `http://127.0.0.1:${server.address.port}` };
});

export const requestEchoUpstream = Effect.gen(function* () {
  const services = yield* Layer.build(
    HttpRouter.serve(
      HttpRouter.add(
        "*",
        "/*",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* HttpServerResponse.json({
            method: request.method,
            url: request.url,
            accept: request.headers.accept ?? null,
            body: yield* request.text,
          });
        }),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return { origin: `http://127.0.0.1:${server.address.port}` };
});

export const hujsonPolicy = `// Engineers reach CI runners.
{
  "grants": [
    { "src": ["group:eng"], "dst": ["tag:ci"], "ip": ["*"], },
  ],
}
`;

export const jsonAnswers = {
  "/aws/json-1.0": {
    contentType: "application/x-amz-json-1.0",
    body: { TableNames: ["synthetic-table"] },
  },
  "/aws/json-1.1": {
    contentType: "application/x-amz-json-1.1",
    body: { StreamNames: ["synthetic-stream"] },
  },
  "/scene": { contentType: "model/gltf+json", body: { asset: { version: "2.0" } } },
} as const;

export const mediaTypeUpstream = Effect.gen(function* () {
  const requests = yield* Ref.make<
    readonly {
      readonly method: string;
      readonly url: string;
      readonly contentType: string | null;
      readonly body: string;
    }[]
  >([]);
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/policy",
          Effect.succeed(
            HttpServerResponse.text(hujsonPolicy, { contentType: "application/hujson" }),
          ),
        ),
        HttpRouter.add(
          "POST",
          "/*",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const observed = {
              method: request.method,
              url: request.url,
              contentType: request.headers["content-type"] ?? null,
              body: yield* request.text,
            };
            yield* Ref.update(requests, (previous) => [...previous, observed]);
            const answer = Object.entries(jsonAnswers).find(([path]) => path === request.url)?.[1];
            return answer === undefined
              ? yield* HttpServerResponse.json({})
              : HttpServerResponse.text(JSON.stringify(answer.body), {
                  contentType: answer.contentType,
                });
          }),
        ),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  const origin = `http://127.0.0.1:${server.address.port}`;
  const object = { type: "object" };
  const jsonOperation = (operationId: string, type: string) => ({
    post: {
      operationId,
      requestBody: { required: true, content: { [type]: { schema: object } } },
      responses: { "200": { description: "OK", content: { [type]: { schema: object } } } },
    },
  });
  const document = {
    openapi: "3.1.0",
    info: { title: "Media types", version: "1" },
    servers: [{ url: origin }],
    paths: {
      "/policy": {
        get: {
          operationId: "getPolicyFile",
          responses: {
            "200": {
              description: "The policy file",
              content: { "application/hujson": { schema: { type: "string" } } },
            },
          },
        },
        post: {
          operationId: "setPolicyFile",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", properties: { grants: { type: "array" } } },
              },
              "application/hujson": { schema: { type: "string" } },
              "application/merge-patch+json": { schema: { type: "object" } },
            },
          },
          responses: ok,
        },
      },
      "/aws/json-1.0": jsonOperation("listTables", "application/x-amz-json-1.0"),
      "/aws/json-1.1": jsonOperation("listStreams", "application/x-amz-json-1.1"),
      "/scene": jsonOperation("putScene", "model/gltf+json"),
    },
  };
  return { origin, document, requests: Ref.get(requests) };
});

export const v1Document = (origin: string) => {
  const json = (schema: unknown) => ({ "application/json": { schema } });
  const ok = { "200": { description: "OK", content: json({ type: "object" }) } };
  const page = "Page`1[[Item, Lib, Version=1.0.0]]";
  return {
    openapi: "3.0.3",
    info: { title: "v1 shapes", version: "1" },
    servers: [{ url: origin }],
    components: {
      schemas: {
        [page]: {
          type: "object",
          properties: { items: { type: "array", items: { $ref: "#/components/schemas/Item" } } },
        },
        Item: {
          type: "object",
          properties: {
            id: { type: "string" },
            owner: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
          required: ["id"],
        },
      },
      parameters: {
        Limit: { name: "limit", in: "query", schema: { type: "integer", minimum: 1 } },
        Legacy: { name: "payload", in: "body", schema: { type: "object" } },
      },
      responses: {
        Created: {
          description: "Created",
          content: json({ type: "object", properties: { created: { type: "boolean" } } }),
        },
      },
    },
    paths: {
      "/items": {
        post: {
          operationId: "createItem",
          requestBody: {
            required: true,
            content: json({
              type: "object",
              properties: { owner: { $ref: "#/components/schemas/Item/properties/owner" } },
              required: ["owner"],
              additionalProperties: false,
            }),
          },
          responses: {
            "200": { description: "OK", content: json({ $ref: `#/components/schemas/${page}` }) },
          },
        },
      },
      "/items/copy": {
        post: {
          operationId: "copyItem",
          parameters: [
            { name: "max", in: "query", schema: { $ref: "#/components/parameters/Limit/schema" } },
          ],
          requestBody: {
            required: true,
            content: json({
              $ref: "#/paths/~1items/post/requestBody/content/application~1json/schema",
            }),
          },
          responses: { "200": { $ref: "#/components/responses/Created" } },
        },
      },
      "/items/stream": {
        get: {
          operationId: "streamItems",
          responses: {
            "200": {
              description: "Events, or the items at once",
              content: {
                "text/event-stream": { schema: { type: "string" } },
                ...json({ type: "object" }),
              },
            },
          },
        },
      },
      "/items/events": {
        get: {
          operationId: "watchItems",
          responses: {
            "200": { description: "Events", content: { "text/event-stream": {} } },
          },
        },
      },
      "/search?type=items": {
        get: {
          operationId: "searchItems",
          parameters: [{ name: "q", in: "query", schema: { type: "string" } }],
          responses: ok,
        },
      },
      "/items/{id}?view=full": {
        get: {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: ok,
        },
      },
      "/docs#latest": { get: { operationId: "readDocs", responses: ok } },
      "/docs#archive": { get: { operationId: "readDocs", responses: ok } },
      "/legacy": {
        post: {
          operationId: null,
          tags: ["legacy"],
          parameters: [
            { $ref: "#/components/parameters/Legacy" },
            { name: "q", in: "query", schema: { type: "string" } },
          ],
          requestBody: { content: {} },
          responses: ok,
        },
      },
    },
  };
};

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
    return {
      api,
      actors,
      organization: `/api/organizations/${actors.organization.id}`,
      path,
      tools: api.request(actors.owner, "GET", `${path}/tools`),
      tool: (name: string) => api.request(actors.owner, "GET", `${path}/tools/${name}`),
      call: (tool: string, kind: "query" | "mutation", input: unknown) =>
        api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool,
          kind,
          input,
        }),
    };
  });
