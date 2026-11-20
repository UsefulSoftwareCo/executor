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

/** An API that answers every request with its method, path with query, and Authorization header. */
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

/** An API that answers every request with its method, path with query, Accept header and body. */
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

/** A HuJSON policy file: a comment and trailing commas, so it is not valid JSON. */
export const hujsonPolicy = `// Engineers reach CI runners.
{
  "grants": [
    { "src": ["group:eng"], "dst": ["tag:ci"], "ip": ["*"], },
  ],
}
`;
/** The same policy as JSON, which the policy file answers unless HuJSON is asked for. */
export const policyJson = { grants: [{ src: ["group:eng"], dst: ["tag:ci"], ip: ["*"] }] };

/**
 * JSON answers that are not `application/json`, by path: AWS's JSON protocols and a `+json` type
 * outside `application`.
 */
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

/**
 * An API whose bodies are JSON or text by media type. Its policy file is shaped like Tailscale's:
 * it takes the policy as JSON, HuJSON or a JSON merge patch, and answers with it as JSON, or as
 * HuJSON when its declared Accept header parameter asks for that. AWS's
 * JSON protocols and a glTF scene take and answer JSON under their own types (`jsonAnswers`). It
 * records each request: method, path, Content-Type and body as sent.
 */
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
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            return request.headers.accept === "application/hujson"
              ? HttpServerResponse.text(hujsonPolicy, { contentType: "application/hujson" })
              : yield* HttpServerResponse.json(policyJson);
          }),
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
  /** An operation that takes and answers one JSON media type. */
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
          parameters: [
            {
              name: "Accept",
              in: "header",
              schema: { type: "string", enum: ["application/json", "application/hujson"] },
            },
          ],
          responses: {
            "200": {
              description: "The policy file",
              content: {
                "application/json": { schema: object },
                "application/hujson": { schema: { type: "string" } },
              },
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

/**
 * Shapes Executor v1 imported that the OpenAPI specification forbids or leaves unclear: schema
 * references to a component whose name is not URI-encoded, into another component's properties,
 * into an operation under `paths` and into a Parameter Object; a request body whose schema is
 * another operation's; an operation that can answer with an event stream or JSON; paths that
 * carry a fixed query or a fragment; an operationId left empty; a parameter in `body`, which
 * OpenAPI 3 does not have; and a request body without media types.
 */
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
      // Only an event stream, which a tool still cannot return.
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
      // Two paths told apart only by their fragments, as some documents name one path's hosts.
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

/** Deploy an app with the given `index.ts`; it is deleted when the scenario ends. */
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
    // Its tools run with the caller's linked accounts; an app without requirements needs none.
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
