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
import { connectionsPath } from "../support/app-accounts.ts";

const Catalog = Schema.Struct({
  version: Schema.String,
  items: Schema.Array(Schema.Struct({ name: Schema.String })),
});

const collect = (value: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) return value.flatMap(collect);
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.entries(record).flatMap(([, nested]) => collect(nested))];
};

const document = {
  openapi: "3.1.0",
  info: { title: "Import diagnostics fixture", version: "1" },
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  security: [{ bearer: [] }],
  paths: {
    "/reports/{report_slug}": {
      get: {
        operationId: "reportBySlug",
        parameters: [{ name: "report_id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "A report",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/items/{id}": {
      get: {
        operationId: "itemWithExtra",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "extra", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "An item",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/jobs/:jobId": {
      get: {
        operationId: "colonPlaceholder",
        parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "A job" } },
      },
    },
    "/files/{id}/*rest": {
      get: {
        operationId: "starPlaceholder",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "rest", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "A file" } },
      },
    },
    "/tags/(\\d+)/active": {
      get: {
        operationId: "patternSegment",
        parameters: [{ name: "optionId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "A tag" } },
      },
    },
    "/items(archived)/{id}": {
      get: {
        operationId: "literalParentheses",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "extra", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "An archived item" } },
      },
    },
    "/search?limit={limit}": {
      get: {
        operationId: "searchWithQueryTemplate",
        parameters: [{ name: "limit", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Results",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/note#view={id}": {
      get: {
        operationId: "fragmentTemplate",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "A note" } },
      },
    },
    "/required": {
      get: {
        operationId: "requiredBodyGet",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { value: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "A required body received",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/optional": {
      get: {
        operationId: "optionalBodyGet",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { value: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Whether a body was received",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { body: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/head-required": {
      head: {
        operationId: "requiredBodyHead",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { value: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "A required body received",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/post-required": {
      post: {
        operationId: "requiredBodyPost",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { value: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "A required body received",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/users/{id?}": {
      get: {
        operationId: "malformedUser",
        responses: {
          "200": {
            description: "A malformed path parameter",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/hello/{name}": {
      get: {
        operationId: "helloName",
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "The path parameter",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

layer(HostedLive, { excludeTestServices: true })("OpenAPI import diagnostics", (it) => {
  it.effect(scenarios.openapiImportDiagnostics.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const routes = Layer.mergeAll(
          HttpRouter.add("GET", "/openapi.json", HttpServerResponse.json(document)),
          HttpRouter.add(
            "GET",
            "/optional",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              if (request.headers.authorization !== "Bearer synthetic-query-key")
                return HttpServerResponse.empty({ status: 401 });
              const bodySent =
                request.headers["content-type"] !== undefined ||
                request.headers["content-length"] !== undefined ||
                request.headers["transfer-encoding"] !== undefined;
              return yield* HttpServerResponse.json({ body: bodySent ? "present" : "none" });
            }),
          ),
          HttpRouter.add(
            "GET",
            "/items/:id",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              if (request.headers.authorization !== "Bearer synthetic-query-key")
                return HttpServerResponse.empty({ status: 401 });
              return yield* HttpServerResponse.json({ url: request.originalUrl });
            }),
          ),
          HttpRouter.add(
            "GET",
            "/search",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              if (request.headers.authorization !== "Bearer synthetic-query-key")
                return HttpServerResponse.empty({ status: 401 });
              return yield* HttpServerResponse.json({ url: request.originalUrl });
            }),
          ),
          HttpRouter.add(
            "GET",
            "/hello/:name",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              if (request.headers.authorization !== "Bearer synthetic-query-key")
                return HttpServerResponse.empty({ status: 401 });
              return yield* HttpServerResponse.json({
                name: decodeURIComponent(request.originalUrl.split("/").pop() ?? ""),
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
          name: "Import diagnostics proof",
          files: openapiAppFiles("Import diagnostics proof", {
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

        const toolsResponse = yield* api.request(actors.owner, "GET", `${path}/tools`);
        expect(toolsResponse.status, JSON.stringify(toolsResponse.body)).toBe(200);
        const catalog = yield* body(Catalog, toolsResponse);
        expect(catalog.items.length).toBeGreaterThan(0);

        const report = JSON.stringify(toolsResponse.body);
        const listed = (name: string) =>
          collect(toolsResponse.body).find(
            (entry) => entry.name === name && "inputSchema" in entry,
          );
        const inputFields = (name: string) => {
          const inputs = collect(listed(name)?.inputSchema).flatMap((entry) => {
            const input = (entry.properties as Record<string, unknown> | undefined)?.input;
            return input === undefined ? [] : [input];
          });
          expect(inputs.length, report).toBeGreaterThan(0);
          const fields = inputs.map((input) => collect(input)[0]?.properties);
          for (const branch of fields)
            expect(
              branch !== null && typeof branch === "object" && !Array.isArray(branch),
              report,
            ).toBe(true);
          return fields.flatMap((branch) => Object.keys(branch ?? {}));
        };
        const leftOut = (name: string) =>
          Effect.gen(function* () {
            const read = yield* api.request(actors.owner, "GET", `${path}/tools/${name}`);
            expect(listed(name), report).toBeUndefined();
            expect(read.status, JSON.stringify(read.body)).toBe(502);
            return (read.body as { failure: { code: string; message: string } }).failure;
          });

        const misnamed = yield* leftOut("reports.reportBySlug");
        expect(misnamed.code).toBe("operation_path");
        expect(misnamed.message).toContain(
          "The path uses {report_slug}, but the operation declares no path parameter named report_slug. Declared path parameters the path does not use: report_id.",
        );

        expect(listed("items.itemWithExtra"), report).toBeDefined();
        expect(String(listed("items.itemWithExtra")?.description ?? "")).toContain(
          "Its path does not hold extra, so any value given is not sent.",
        );
        expect(
          collect(toolsResponse.body).find(
            (entry) => String(entry.name).endsWith(".literalParentheses") && "inputSchema" in entry,
          ),
          report,
        ).toBeDefined();
        const colon = yield* leftOut("jobs.colonPlaceholder");
        expect(colon.code).toBe("operation_path");
        expect(colon.message).toContain("declares jobId in a form that is never filled");
        for (const name of ["files.starPlaceholder", "tags.patternSegment"])
          expect((yield* leftOut(name)).message).toContain("in a form that is never filled");

        expect(listed("search.searchWithQueryTemplate"), report).toBeDefined();

        expect(listed("note.fragmentTemplate"), report).toBeDefined();
        expect(String(listed("note.fragmentTemplate")?.description ?? "")).toContain(
          "Its path does not hold id, so any value given is not sent.",
        );

        expect(listed("optional.optionalBodyGet"), report).toBeDefined();
        expect(inputFields("optional.optionalBodyGet"), report).not.toContain("body");
        const optionalDescription = String(listed("optional.optionalBodyGet")?.description ?? "");
        expect(optionalDescription).toContain("optional.optionalBodyGet");
        expect(optionalDescription).toContain(
          "Its optional request body is left out: GET and HEAD cannot carry a body.",
        );

        for (const name of ["required.requiredBodyGet", "headRequired.requiredBodyHead"]) {
          const skipped = yield* leftOut(name);
          expect(skipped.code).toBe("request_body");
          expect(skipped.message).toContain(
            "A GET or HEAD request cannot carry a body, and this operation requires one.",
          );
        }

        expect(inputFields("postRequired.requiredBodyPost"), report).toContain("body");

        expect((yield* leftOut("users.malformedUser")).code).toBe("operation_path");

        const optionalCall = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "optional.optionalBodyGet",
          kind: "query",
          input: { accountId: account, input: {} },
        });
        expect(optionalCall.status, JSON.stringify(optionalCall.body)).toBe(200);
        const optional = yield* body(Schema.Struct({ body: Schema.String }), optionalCall);
        expect(optional.body).toBe("none");

        const searchCall = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "search.searchWithQueryTemplate",
          kind: "query",
          input: { accountId: account, input: { path: { limit: "5" } } },
        });
        expect(searchCall.status, JSON.stringify(searchCall.body)).toBe(200);
        expect((yield* body(Schema.Struct({ url: Schema.String }), searchCall)).url).toMatch(
          /\/search\?limit=5$/,
        );

        const extraCall = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "items.itemWithExtra",
          kind: "query",
          input: { accountId: account, input: { path: { id: "7", extra: "ignored" } } },
        });
        expect(extraCall.status, JSON.stringify(extraCall.body)).toBe(200);
        expect((yield* body(Schema.Struct({ url: Schema.String }), extraCall)).url).toMatch(
          /\/items\/7$/,
        );

        const helloCall = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "hello.helloName",
          kind: "query",
          input: { accountId: account, input: { path: { name: "Ada" } } },
        });
        expect(helloCall.status, JSON.stringify(helloCall.body)).toBe(200);
        const hello = yield* body(Schema.Struct({ name: Schema.String }), helloCall);
        expect(hello.name).toBe("Ada");
      }),
    ),
  );
});
