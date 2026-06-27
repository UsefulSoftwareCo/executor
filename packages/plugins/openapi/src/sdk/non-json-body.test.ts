// ---------------------------------------------------------------------------
// Dispatch tests for non-JSON request bodies.
//
// Each case spins up an Effect HttpApi-backed test server, derives the
// OpenAPI spec from that API, and asserts both the wire-level content type
// and body shape the plugin actually sent.
//
// The scenarios mirror what real specs commonly carry — multipart uploads
// (files + scalar fields), XML bodies declared as pre-serialized strings,
// text/plain payloads, and raw octet-stream byte uploads.
//
// v2: tools are produced per-connection, so each case adds the integration via
// `addSpec` AND creates a connection before executing the full tool address.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi";

import { createExecutor } from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import {
  addOpenApiTestConnection,
  serveOpenApiHttpApiTestServer,
} from "@executor-js/plugin-openapi/testing";

import { openApiPlugin } from "./plugin";

const JsonNameBody = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
  }),
);
const decodeJsonNameBody = Schema.decodeUnknownSync(JsonNameBody);

const testPlugins = () =>
  [openApiPlugin({ httpClientLayer: FetchHttpClient.layer }), memoryCredentialsPlugin()] as const;

type Captured = {
  contentType: string;
  body: Buffer;
};

const Ok = Schema.Struct({ ok: Schema.Boolean });

const startEchoServer = (options: {
  readonly name?: string;
  readonly path?: `/${string}`;
  readonly payload: Schema.Top | readonly Schema.Top[];
  readonly transformSpec?: (spec: Record<string, unknown>) => Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const captured: Captured = { contentType: "", body: Buffer.alloc(0) };
    const endpointName = options.name ?? "submit";
    const path = options.path ?? "/submit";
    const group = HttpApiGroup.make("body").add(
      HttpApiEndpoint.post(endpointName, path, {
        payload: options.payload,
        success: Ok,
      }),
    );
    const api = HttpApi.make(`bodyTest_${endpointName}`).add(group);
    const handlersLayer = HttpApiBuilder.group(api, "body", (handlers) =>
      handlers.handleRaw(endpointName, () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          captured.contentType = request.headers["content-type"] ?? "";
          const body = yield* request.arrayBuffer.pipe(
            Effect.catch(() => Effect.succeed(new ArrayBuffer(0))),
          );
          captured.body = Buffer.from(body);
          return HttpServerResponse.jsonUnsafe({ ok: true });
        }),
      ),
    );
    const server = yield* serveOpenApiHttpApiTestServer({
      api,
      handlersLayer,
      transformSpec: options.transformSpec,
    });
    return { server, captured };
  });

const ObjectBody = Schema.Struct({
  name: Schema.optional(Schema.String),
  flag: Schema.optional(Schema.Boolean),
  count: Schema.optional(Schema.Number),
});

const JsonNameObject = Schema.Struct({ name: Schema.String });

const contentFor = (contentType: string) => ({
  [contentType]: {
    schema: { type: "object" },
  },
});

const replaceResponseContent =
  (path: string, operation: string, content: Record<string, unknown>) =>
  (spec: Record<string, unknown>): Record<string, unknown> => {
    const paths = { ...(spec.paths as Record<string, unknown>) };
    const pathItem = { ...(paths[path] as Record<string, unknown>) };
    const operationSpec = { ...(pathItem[operation] as Record<string, unknown>) };
    const responses = { ...(operationSpec.responses as Record<string, unknown>) };
    const ok = { ...(responses["200"] as Record<string, unknown>) };
    responses["200"] = { ...ok, content };
    pathItem[operation] = { ...operationSpec, responses };
    paths[path] = pathItem;
    return { ...spec, paths };
  };

const replaceOperationServers =
  (path: string, operation: string, servers: readonly Record<string, unknown>[]) =>
  (spec: Record<string, unknown>): Record<string, unknown> => {
    const paths = { ...(spec.paths as Record<string, unknown>) };
    const pathItem = { ...(paths[path] as Record<string, unknown>) };
    const operationSpec = { ...(pathItem[operation] as Record<string, unknown>) };
    pathItem[operation] = { ...operationSpec, servers };
    paths[path] = pathItem;
    return { ...spec, paths };
  };

const replaceRequestBodyContent =
  (
    path: string,
    operation: string,
    content: Record<string, unknown>,
    encoding?: Record<string, unknown>,
  ) =>
  (spec: Record<string, unknown>): Record<string, unknown> => {
    const paths = { ...(spec.paths as Record<string, unknown>) };
    const pathItem = { ...(paths[path] as Record<string, unknown>) };
    const operationSpec = { ...(pathItem[operation] as Record<string, unknown>) };
    const requestBody = { ...(operationSpec.requestBody as Record<string, unknown>) };
    pathItem[operation] = {
      ...operationSpec,
      requestBody: {
        ...requestBody,
        content: encoding
          ? Object.fromEntries(
              Object.entries(content).map(([key, value]) => [
                key,
                { ...(value as Record<string, unknown>), encoding },
              ]),
            )
          : content,
      },
    };
    paths[path] = pathItem;
    return { ...spec, paths };
  };

describe("OpenAPI non-JSON request body dispatch", () => {
  it.effect("multipart/form-data: object body is encoded as real multipart", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: ObjectBody.pipe(HttpApiSchema.asMultipart()),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "mp" });

      yield* executor.execute(conn.address("body.submit"), {
        body: { name: "Acme", flag: true, count: 7 },
      });

      expect(captured.contentType).toMatch(/^multipart\/form-data; boundary=/);
      const body = captured.body.toString("utf8");
      expect(body).toContain('name="name"');
      expect(body).toContain("Acme");
      expect(body).toContain('name="flag"');
      expect(body).toContain("true");
      expect(body).toContain('name="count"');
      expect(body).toContain("7");
      // Regression guard: never ship [object Object] over multipart.
      expect(body).not.toContain("[object Object]");
    }),
  );

  it.effect("application/xml: string body passes through with xml content-type", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: Schema.String.pipe(HttpApiSchema.asText({ contentType: "application/xml" })),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "xml" });

      const xml = '<?xml version="1.0"?><root><name>Acme</name></root>';
      yield* executor.execute(conn.address("body.submit"), { body: xml });

      expect(captured.contentType).toBe("application/xml");
      expect(captured.body.toString("utf8")).toBe(xml);
    }),
  );

  it.effect("text/xml: object body is JSON-stringified (never '[object Object]')", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: JsonNameObject,
        transformSpec: replaceRequestBodyContent("/submit", "post", contentFor("text/xml")),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "tx" });

      yield* executor.execute(conn.address("body.submit"), { body: { name: "Acme" } });

      expect(captured.contentType).toBe("text/xml");
      const body = captured.body.toString("utf8");
      expect(body).not.toBe("[object Object]");
      expect(decodeJsonNameBody(body)).toEqual({ name: "Acme" });
    }),
  );

  it.effect("text/plain: string body passes through with text/plain", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: Schema.String.pipe(HttpApiSchema.asText()),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "tp" });

      yield* executor.execute(conn.address("body.submit"), { body: "hello, world" });

      expect(captured.contentType).toBe("text/plain");
      expect(captured.body.toString("utf8")).toBe("hello, world");
    }),
  );

  it.effect("application/octet-stream: Uint8Array passes through as bytes", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "bin" });

      const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]);
      yield* executor.execute(conn.address("body.submit"), { body: payload });

      expect(captured.contentType).toBe("application/octet-stream");
      expect(captured.body.length).toBe(payload.length);
      expect(Array.from(captured.body)).toEqual(Array.from(payload));
    }),
  );

  it.effect("application/octet-stream: bodyBase64 passes through as bytes", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "bin_b64" });

      yield* executor.execute(conn.address("body.submit"), {
        bodyBase64: "3q2+7w==",
      });

      expect(captured.contentType).toBe("application/octet-stream");
      expect(Array.from(captured.body)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    }),
  );

  it.effect("application/octet-stream: invalid bodyBase64 fails before dispatch", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "bin_b64_bad" });

      const exit = yield* executor
        .execute(conn.address("body.submit"), {
          bodyBase64: "@@",
        })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(captured.contentType).toBe("");
      expect(captured.body.length).toBe(0);
    }),
  );

  it.effect("application/octet-stream: invalid nested bodyBase64 fails before dispatch", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, {
        slug: "bin_nested_b64_bad",
      });

      const exit = yield* executor
        .execute(conn.address("body.submit"), {
          body: { bodyBase64: "@@" },
        })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(captured.contentType).toBe("");
      expect(captured.body.length).toBe(0);
    }),
  );

  it.effect("application/octet-stream: required body fails before dispatch when missing", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, {
        slug: "bin_b64_missing",
      });

      const exit = yield* executor.execute(conn.address("body.submit"), {}).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(captured.contentType).toBe("");
      expect(captured.body.length).toBe(0);
    }),
  );

  it.effect("application/octet-stream: object body fails before dispatch", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, {
        slug: "bin_object_body",
      });

      const exit = yield* executor
        .execute(conn.address("body.submit"), {
          body: { name: "photo.png" },
        })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(captured.contentType).toBe("");
      expect(captured.body.length).toBe(0);
    }),
  );

  it.effect("application/octet-stream: string body fails before dispatch", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, {
        slug: "bin_string_body",
      });

      const exit = yield* executor
        .execute(conn.address("body.submit"), {
          body: "3q2+7w==",
        })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(captured.contentType).toBe("");
      expect(captured.body.length).toBe(0);
    }),
  );

  it.effect(
    "format: byte response: Gmail-style image attachment data is exposed as a file artifact",
    () =>
      Effect.gen(function* () {
        const attachmentBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
        const attachmentBase64Url = "_9j_4AAQ";
        const MessagePartBody = Schema.Struct({
          data: Schema.String,
          size: Schema.Number,
        });
        const group = HttpApiGroup.make("gmail").add(
          HttpApiEndpoint.get("getAttachment", "/attachments/:id", {
            success: MessagePartBody,
          }),
        );
        const api = HttpApi.make("gmailAttachmentTest").add(group);
        const handlersLayer = HttpApiBuilder.group(api, "gmail", (handlers) =>
          handlers.handleRaw("getAttachment", () =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe({
                data: attachmentBase64Url,
                size: attachmentBytes.byteLength,
              }),
            ),
          ),
        );
        const server = yield* serveOpenApiHttpApiTestServer({
          api,
          handlersLayer,
          transformSpec: replaceResponseContent("/attachments/{id}", "get", {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  data: {
                    type: "string",
                    format: "byte",
                    description: "The body data as a base64url encoded string.",
                  },
                  size: {
                    type: "integer",
                    format: "int32",
                    description: "Number of bytes for the message part data.",
                  },
                },
                required: ["data", "size"],
              },
            },
          }),
        });

        const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
        const conn = yield* addOpenApiTestConnection(executor, server, { slug: "gmail" });

        const schema = yield* executor.tools.schema(conn.address("gmail.getAttachment"));
        expect(schema?.outputSchema).toMatchObject({
          properties: {
            _tag: { enum: ["ToolFile"] },
            data: { contentEncoding: "base64" },
          },
        });

        const result = yield* executor.execute(conn.address("gmail.getAttachment"), {
          id: "att_1",
        });

        expect(result).toMatchObject({
          ok: true,
          data: {
            _tag: "ToolFile",
            encoding: "base64",
            mimeType: "image/jpeg",
            data: "/9j/4AAQ",
            byteLength: attachmentBytes.byteLength,
          },
        });
      }),
  );

  it.effect("format: byte response: UTF-8 attachment data falls back to text/plain", () =>
    Effect.gen(function* () {
      const attachmentText = [
        "id,name,status,amount",
        "1,Ada,confirmed,42.50",
        "2,Grace,pending,13.75",
        "3,Linus,cancelled,0.00",
        "",
      ].join("\n");
      const attachmentBase64Url =
        "aWQsbmFtZSxzdGF0dXMsYW1vdW50CjEsQWRhLGNvbmZpcm1lZCw0Mi41MAoyLEdyYWNlLHBlbmRpbmcsMTMuNzUKMyxMaW51cyxjYW5jZWxsZWQsMC4wMAo";
      const MessagePartBody = Schema.Struct({
        data: Schema.String,
        size: Schema.Number,
      });
      const group = HttpApiGroup.make("gmailText").add(
        HttpApiEndpoint.get("getAttachment", "/attachments/:id", {
          success: MessagePartBody,
        }),
      );
      const api = HttpApi.make("gmailTextAttachmentTest").add(group);
      const handlersLayer = HttpApiBuilder.group(api, "gmailText", (handlers) =>
        handlers.handleRaw("getAttachment", () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe({
              data: attachmentBase64Url,
              size: new TextEncoder().encode(attachmentText).byteLength,
            }),
          ),
        ),
      );
      const server = yield* serveOpenApiHttpApiTestServer({
        api,
        handlersLayer,
        transformSpec: replaceResponseContent("/attachments/{id}", "get", {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                data: {
                  type: "string",
                  format: "byte",
                  description: "The body data as a base64url encoded string.",
                },
                size: {
                  type: "integer",
                  format: "int32",
                  description: "Number of bytes for the message part data.",
                },
              },
              required: ["data", "size"],
            },
          },
        }),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "gmail_text" });

      const result = yield* executor.execute(conn.address("gmailText.getAttachment"), {
        id: "att_1",
      });

      expect(result).toMatchObject({
        ok: true,
        data: {
          _tag: "ToolFile",
          encoding: "base64",
          mimeType: "text/plain",
          data: `${attachmentBase64Url}=`,
          byteLength: 89,
        },
      });
    }),
  );

  it.effect("format: byte response: ZIP bytes are sniffed from octet-stream output", () =>
    Effect.gen(function* () {
      const zipBase64Url = "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA";
      const MessagePartBody = Schema.Struct({
        data: Schema.String,
        size: Schema.Number,
      });
      const group = HttpApiGroup.make("zipAttachment").add(
        HttpApiEndpoint.get("getAttachment", "/attachments/:id", {
          success: MessagePartBody,
        }),
      );
      const api = HttpApi.make("zipAttachmentTest").add(group);
      const handlersLayer = HttpApiBuilder.group(api, "zipAttachment", (handlers) =>
        handlers.handleRaw("getAttachment", () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe({
              data: zipBase64Url,
              size: 22,
            }),
          ),
        ),
      );
      const server = yield* serveOpenApiHttpApiTestServer({
        api,
        handlersLayer,
        transformSpec: replaceResponseContent("/attachments/{id}", "get", {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                data: {
                  type: "string",
                  format: "byte",
                  description: "The body data as a base64url encoded string.",
                },
                size: {
                  type: "integer",
                  format: "int32",
                  description: "Number of bytes for the message part data.",
                },
              },
              required: ["data", "size"],
            },
          },
        }),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "zip_attachment" });

      const result = yield* executor.execute(conn.address("zipAttachment.getAttachment"), {
        id: "att_1",
      });

      expect(result).toMatchObject({
        ok: true,
        data: {
          _tag: "ToolFile",
          encoding: "base64",
          mimeType: "application/zip",
          data: `${zipBase64Url}==`,
          byteLength: 22,
        },
      });
    }),
  );

  it.effect("Gmail-style byte responses stay generic and do not fetch parent metadata", () =>
    Effect.gen(function* () {
      const attachmentText = [
        "id,name,status,amount",
        "1,Ada,confirmed,42.50",
        "2,Grace,pending,13.75",
        "3,Linus,cancelled,0.00",
        "",
      ].join("\n");
      const attachmentBase64Url =
        "aWQsbmFtZSxzdGF0dXMsYW1vdW50CjEsQWRhLGNvbmZpcm1lZCw0Mi41MAoyLEdyYWNlLHBlbmRpbmcsMTMuNzUKMyxMaW51cyxjYW5jZWxsZWQsMC4wMAo";
      const attachmentBytes = new TextEncoder().encode(attachmentText);
      const MessagePartBody = Schema.Struct({
        data: Schema.String,
        size: Schema.Number,
      });
      const Message = Schema.Struct({
        payload: Schema.Unknown,
      });
      let parentRequestUrl = "";
      const group = HttpApiGroup.make("gmailMeta")
        .add(
          HttpApiEndpoint.get(
            "getAttachment",
            "/users/:userId/messages/:messageId/attachments/:id",
            {
              success: MessagePartBody,
            },
          ),
        )
        .add(
          HttpApiEndpoint.get("getMessage", "/users/:userId/messages/:messageId", {
            success: Message,
          }),
        );
      const api = HttpApi.make("gmailMetadataAttachmentTest").add(group);
      const handlersLayer = HttpApiBuilder.group(api, "gmailMeta", (handlers) =>
        handlers
          .handleRaw("getAttachment", () =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe({
                data: attachmentBase64Url,
                size: attachmentBytes.byteLength,
              }),
            ),
          )
          .handleRaw("getMessage", () =>
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              parentRequestUrl = request.url;
              return HttpServerResponse.jsonUnsafe({
                payload: {
                  mimeType: "multipart/mixed",
                  parts: [
                    {
                      filename: "executor-test.csv",
                      mimeType: "text/csv",
                      body: {
                        attachmentId: "att_1",
                        size: attachmentBytes.byteLength,
                      },
                    },
                  ],
                },
              });
            }),
          ),
      );
      const server = yield* serveOpenApiHttpApiTestServer({
        api,
        handlersLayer,
        transformSpec: (spec) =>
          replaceOperationServers("/users/{userId}/messages/{messageId}/attachments/{id}", "get", [
            { url: "https://gmail.googleapis.com/gmail/v1" },
          ])(
            replaceResponseContent("/users/{userId}/messages/{messageId}/attachments/{id}", "get", {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "string",
                      format: "byte",
                      description: "The body data as a base64url encoded string.",
                    },
                    size: {
                      type: "integer",
                      format: "int32",
                      description: "Number of bytes for the message part data.",
                    },
                  },
                  required: ["data", "size"],
                },
              },
            })(spec),
          ),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "gmail_meta" });

      const result = yield* executor.execute(conn.address("gmailMeta.getAttachment"), {
        userId: "me",
        messageId: "msg_1",
        id: "att_1",
      });

      expect(parentRequestUrl).toBe("");
      expect(result).toMatchObject({
        ok: true,
        data: {
          _tag: "ToolFile",
          encoding: "base64",
          mimeType: "text/plain",
          data: `${attachmentBase64Url}=`,
          byteLength: attachmentBytes.byteLength,
        },
      });
    }),
  );

  it.effect("format: binary response: raw file bodies are exposed as file artifacts", () =>
    Effect.gen(function* () {
      const group = HttpApiGroup.make("files").add(
        HttpApiEndpoint.get("download", "/files/:id", {
          success: Schema.String,
        }),
      );
      const api = HttpApi.make("binaryDownloadTest").add(group);
      const handlersLayer = HttpApiBuilder.group(api, "files", (handlers) =>
        handlers.handleRaw("download", () =>
          Effect.succeed(HttpServerResponse.text("%PDF-", { contentType: "application/pdf" })),
        ),
      );
      const server = yield* serveOpenApiHttpApiTestServer({
        api,
        handlersLayer,
        transformSpec: replaceResponseContent("/files/{id}", "get", {
          "application/pdf": {
            schema: {
              type: "string",
              format: "binary",
            },
          },
        }),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "files" });

      const schema = yield* executor.tools.schema(conn.address("files.download"));
      expect(schema?.outputSchema).toMatchObject({
        properties: {
          _tag: { enum: ["ToolFile"] },
          data: { contentEncoding: "base64" },
        },
      });

      const result = yield* executor.execute(conn.address("files.download"), {
        id: "report",
      });

      expect(result).toMatchObject({
        ok: true,
        data: {
          _tag: "ToolFile",
          encoding: "base64",
          mimeType: "application/pdf",
          data: "JVBERi0=",
          byteLength: 5,
        },
      });
    }),
  );

  it.effect("format: binary response: non-2xx responses keep their error body", () =>
    Effect.gen(function* () {
      const group = HttpApiGroup.make("files").add(
        HttpApiEndpoint.get("download", "/files/:id", {
          success: Schema.String,
        }),
      );
      const api = HttpApi.make("binaryDownloadErrorTest").add(group);
      const handlersLayer = HttpApiBuilder.group(api, "files", (handlers) =>
        handlers.handleRaw("download", () =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "missing" }, { status: 404 })),
        ),
      );
      const server = yield* serveOpenApiHttpApiTestServer({
        api,
        handlersLayer,
        transformSpec: replaceResponseContent("/files/{id}", "get", {
          "application/pdf": {
            schema: {
              type: "string",
              format: "binary",
            },
          },
        }),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "files" });

      const result = yield* executor.execute(conn.address("files.download"), {
        id: "missing",
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "upstream_http_error",
          status: 404,
          details: {
            error: "missing",
          },
        },
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Multi-content: spec declares both multipart and JSON for one operation.
  // Default is first-declared (spec author's preferred order, not JSON-first),
  // and the caller can override via `args.contentType`.
  // -------------------------------------------------------------------------

  const multiContentPayload = [
    ObjectBody.pipe(HttpApiSchema.asMultipart()),
    JsonNameObject,
  ] as const;

  it.effect("multi-content: defaults to first-declared (not JSON-first)", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: multiContentPayload,
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "mc" });

      yield* executor.execute(conn.address("body.submit"), { body: { name: "Acme" } });

      // multipart/form-data was declared first in the spec — it wins,
      // even though the old preferredContent would have picked JSON.
      expect(captured.contentType).toMatch(/^multipart\/form-data; boundary=/);
    }),
  );

  it.effect("multi-content: caller can override via args.contentType", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: multiContentPayload,
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "mc2" });

      yield* executor.execute(conn.address("body.submit"), {
        contentType: "application/json",
        body: { name: "Acme" },
      });

      expect(captured.contentType).toBe("application/json");
      expect(decodeJsonNameBody(captured.body.toString("utf8"))).toEqual({
        name: "Acme",
      });
    }),
  );

  it.effect("multi-content: bodyBase64 selects octet-stream without explicit contentType", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: multiContentPayload,
        transformSpec: replaceRequestBodyContent("/submit", "post", {
          "application/json": {
            schema: { type: "object" },
          },
          "application/octet-stream": {
            schema: { type: "string", format: "binary" },
          },
        }),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "mc_b64" });

      yield* executor.execute(conn.address("body.submit"), {
        bodyBase64: "3q2+7w==",
      });

      expect(captured.contentType).toBe("application/octet-stream");
      expect(Array.from(captured.body)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    }),
  );

  it.effect("multi-content: bodyBase64 rejects a non-octet contentType", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: multiContentPayload,
        transformSpec: replaceRequestBodyContent("/submit", "post", {
          "application/json": {
            schema: { type: "object" },
          },
          "application/octet-stream": {
            schema: { type: "string", format: "binary" },
          },
        }),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "mc_b64_bad_ct" });

      const exit = yield* executor
        .execute(conn.address("body.submit"), {
          contentType: "application/json",
          bodyBase64: "3q2+7w==",
        })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(captured.contentType).toBe("");
      expect(captured.body.length).toBe(0);
    }),
  );

  it.effect("multi-content: required schema accepts body or bodyBase64", () =>
    Effect.gen(function* () {
      const { server } = yield* startEchoServer({
        payload: multiContentPayload,
        transformSpec: replaceRequestBodyContent("/submit", "post", {
          "application/json": {
            schema: { type: "object" },
          },
          "application/octet-stream": {
            schema: { type: "string", format: "binary" },
          },
        }),
      });
      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "mc_b64_schema" });

      const view = yield* executor.tools.schema(conn.address("body.submit"));
      expect(view).not.toBeNull();
      const schema = view!.inputSchema as {
        anyOf?: readonly { readonly required?: readonly string[] }[];
        properties?: {
          bodyBase64?: { contentEncoding?: string; contentMediaType?: string };
        };
      };
      expect(schema.anyOf).toEqual([{ required: ["body"] }, { required: ["bodyBase64"] }]);
      expect(schema.properties?.bodyBase64?.contentEncoding).toBe("base64");
      expect(schema.properties?.bodyBase64?.contentMediaType).toBe("application/octet-stream");
    }),
  );

  it.effect("multi-content: tool input schema exposes contentType enum", () =>
    Effect.gen(function* () {
      const { server } = yield* startEchoServer({
        payload: multiContentPayload,
      });
      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, {
        slug: "mc3",
        baseUrl: "https://example.com",
      });

      // `tools.schema` is the schema-bearing surface — `tools.list` is
      // metadata-only (the hot path projects the schema columns away).
      const view = yield* executor.tools.schema(conn.address("body.submit"));
      expect(view).not.toBeNull();
      const schema = view!.inputSchema as {
        properties?: {
          contentType?: { enum?: string[]; default?: string };
        };
      };
      expect(schema.properties?.contentType?.enum).toEqual([
        "multipart/form-data",
        "application/json",
      ]);
      expect(schema.properties?.contentType?.default).toBe("multipart/form-data");
    }),
  );

  it.effect("octet-stream: tool input schema exposes bodyBase64", () =>
    Effect.gen(function* () {
      const { server } = yield* startEchoServer({
        payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      });
      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "bin_schema" });

      const view = yield* executor.tools.schema(conn.address("body.submit"));
      expect(view).not.toBeNull();
      const schema = view!.inputSchema as {
        required?: string[];
        properties?: {
          body?: unknown;
          bodyBase64?: { contentEncoding?: string; contentMediaType?: string };
        };
      };
      expect(schema.required).toContain("bodyBase64");
      expect(schema.required).not.toContain("body");
      expect(schema.properties?.body).toBeUndefined();
      expect(schema.properties?.bodyBase64?.contentEncoding).toBe("base64");
      expect(schema.properties?.bodyBase64?.contentMediaType).toBe("application/octet-stream");
    }),
  );

  // -------------------------------------------------------------------------
  // Per-part encoding.contentType in multipart — a metadata field declared
  // as application/json must ship with its own `Content-Type: application/
  // json` sub-header so strict servers can parse it correctly.
  // -------------------------------------------------------------------------

  it.effect("multipart encoding.contentType: JSON metadata part has typed header", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        name: "upload",
        path: "/upload",
        payload: Schema.Struct({
          metadata: Schema.Record(Schema.String, Schema.Unknown),
          filename: Schema.String,
        }).pipe(HttpApiSchema.asMultipart()),
        transformSpec: replaceRequestBodyContent(
          "/upload",
          "post",
          contentFor("multipart/form-data"),
          {
            metadata: { contentType: "application/json" },
          },
        ),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "mpe" });

      yield* executor.execute(conn.address("body.upload"), {
        body: {
          metadata: { owner: "Acme", tags: ["x", "y"] },
          filename: "hello.txt",
        },
      });

      expect(captured.contentType).toMatch(/^multipart\/form-data; boundary=/);
      const body = captured.body.toString("utf8");
      // The metadata part must carry Content-Type: application/json ...
      expect(body).toMatch(/name="metadata"[\s\S]*?Content-Type: application\/json/);
      // ... and its payload must be the JSON-serialized object.
      expect(body).toContain('{"owner":"Acme","tags":["x","y"]}');
      // The filename part stays as a default text part — no typed header.
      expect(body).toContain('name="filename"');
      expect(body).toContain("hello.txt");
    }),
  );

  // -------------------------------------------------------------------------
  // Form-urlencoded style/explode — arrays with explode:false comma-join;
  // objects with style:deepObject use bracket notation.
  // -------------------------------------------------------------------------

  it.effect("form-urlencoded explode:false: arrays comma-join", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: ObjectBody.pipe(HttpApiSchema.asFormUrlEncoded()),
        transformSpec: replaceRequestBodyContent(
          "/submit",
          "post",
          contentFor("application/x-www-form-urlencoded"),
          {
            tags: { style: "form", explode: false },
          },
        ),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "fe" });

      yield* executor.execute(conn.address("body.submit"), {
        body: { tags: ["red", "blue", "green"], name: "Acme" },
      });

      expect(captured.contentType).toBe("application/x-www-form-urlencoded");
      const body = captured.body.toString("utf8");
      expect(body).toContain("tags=red%2Cblue%2Cgreen");
      expect(body).toContain("name=Acme");
      // Explicitly NOT repeated: `tags=red&tags=blue&tags=green`.
      expect(body).not.toMatch(/tags=red&tags=blue/);
    }),
  );

  it.effect("form-urlencoded deepObject: nested keys use bracket notation", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: ObjectBody.pipe(HttpApiSchema.asFormUrlEncoded()),
        transformSpec: replaceRequestBodyContent(
          "/submit",
          "post",
          contentFor("application/x-www-form-urlencoded"),
          {
            filter: { style: "deepObject", explode: true },
          },
        ),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "fd" });

      yield* executor.execute(conn.address("body.submit"), {
        body: { filter: { status: "active", tier: "gold" } },
      });

      expect(captured.contentType).toBe("application/x-www-form-urlencoded");
      const body = captured.body.toString("utf8");
      expect(body).toContain("filter%5Bstatus%5D=active");
      expect(body).toContain("filter%5Btier%5D=gold");
    }),
  );

  it.effect("form-urlencoded default: arrays use form+explode=true (repeat key)", () =>
    Effect.gen(function* () {
      const { server, captured } = yield* startEchoServer({
        payload: ObjectBody.pipe(HttpApiSchema.asFormUrlEncoded()),
        transformSpec: replaceRequestBodyContent(
          "/submit",
          "post",
          contentFor("application/x-www-form-urlencoded"),
          {},
        ),
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));

      // No encoding → OAS3 defaults: style=form, explode=true.
      const conn = yield* addOpenApiTestConnection(executor, server, { slug: "fdx" });

      yield* executor.execute(conn.address("body.submit"), {
        body: { tag: ["x", "y"], name: "Acme" },
      });

      expect(captured.contentType).toBe("application/x-www-form-urlencoded");
      const body = captured.body.toString("utf8");
      expect(body).toContain("tag=x&tag=y");
      expect(body).toContain("name=Acme");
    }),
  );
});
