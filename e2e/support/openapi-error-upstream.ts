import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, JsonSchema, Layer, Schema, SchemaRepresentation, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { createServer } from "node:http";

/** Private response content must never be copied into an agent diagnostic. */
export const openapiSecretMarker = "synthetic-private-openapi-detail";
/** Response-specific copy deliberately differs from the static schema description. */
export const openapiMemoryMessage =
  "The compiler ran out of memory during this build. Review build memory use before retrying.";
/** Response-specific recovery; the published Executor error schemas require it. */
export const openapiMemoryRecovery = {
  action: "Retry after the build memory limit increases.",
  instructions: "Tell the user the build hit the memory limit before changing the app.",
};
/** A declared recovery on an API whose error schema allows extra fields. */
export const openapiConflictRecovery = {
  action: "Reload the record, then save again.",
  instructions: "Read the current revision and reapply the change before retrying.",
};
/** A declared 403 body; a bare status alone would not explain the refusal. */
export const openapiDeniedMessage = "This workspace does not allow exports by members.";
/** A reason-specific response from an error schema with no static description. */
export const openapiOAuthMessage = "We could not register an OAuth client for this connection.";
/** A declared conflict a bulk write meets after saving part of its records. */
export const openapiConflictMessage = "The record store changed while these records were saved.";
/** Advice a service declares for its own error, which would repeat a bulk write's saved part. */
export const openapiRetryRecovery = {
  action: "Try again.",
  instructions: "Send the same request again.",
};

/**
 * A real HTTP API using the product's published memory-error schema and controlled failures.
 * `POST /records` saves its record and then fails with HTTP 502, as a service that commits a
 * change before its gateway or response fails. `POST /records/bulk` appends its records in order
 * and stops at the first one it refuses, with a declared error: `StoreConflict` (HTTP 409, with
 * the service's own advice to try again) for the name `conflict`, `InvalidRecord` (HTTP 422,
 * without advice) for an empty one. The records before it stay saved, so repeating the request
 * saves them again. `GET /records` reads the records.
 */
export const openapiErrorUpstream = (memorySchema: unknown, oauthSchema: unknown) =>
  Effect.gen(function* () {
    // Import the running product's public schemas without importing its implementation.
    const publishedError = (identifier: string, schema: unknown) =>
      SchemaRepresentation.fromJsonSchemaDocument(
        JsonSchema.fromSchemaOpenApi3_1(
          Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(schema),
        ),
      ).annotate({ identifier, httpApiStatus: 422 });
    const conflict = Schema.StructWithRest(
      Schema.TaggedStruct("Conflict", { revision: Schema.Number }),
      [Schema.Record(Schema.String, Schema.Json)],
    ).annotate({
      identifier: "Conflict",
      httpApiStatus: 422,
      description: "Read the current revision before saving again.",
    });
    const api = HttpApi.make("openapiErrors").add(
      HttpApiGroup.make("failures").add(
        HttpApiEndpoint.get("fail", "/failure", {
          query: { mode: Schema.String },
          error: [
            publishedError("BuildMemoryExceeded", memorySchema),
            publishedError("OAuthSetupFailed", oauthSchema),
            conflict,
            Schema.TaggedStruct("ExportDenied", { message: Schema.String }).annotate({
              identifier: "ExportDenied",
              httpApiStatus: 403,
            }),
          ],
        }).annotate(OpenApi.Identifier, "fail"),
      ),
      HttpApiGroup.make("records")
        .add(
          HttpApiEndpoint.post("create", "/records", {
            payload: Schema.Struct({ name: Schema.String }),
            success: Schema.Struct({ name: Schema.String }),
          }).annotate(OpenApi.Identifier, "createRecord"),
        )
        .add(
          HttpApiEndpoint.post("bulk", "/records/bulk", {
            payload: Schema.Struct({ names: Schema.Array(Schema.String) }),
            success: Schema.Struct({ saved: Schema.Array(Schema.String) }),
            error: [
              Schema.TaggedStruct("StoreConflict", {
                message: Schema.String,
                recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
              }).annotate({ identifier: "StoreConflict", httpApiStatus: 409 }),
              Schema.TaggedStruct("InvalidRecord", { message: Schema.String }).annotate({
                identifier: "InvalidRecord",
                httpApiStatus: 422,
              }),
            ],
          }).annotate(OpenApi.Identifier, "createRecords"),
        )
        .add(
          HttpApiEndpoint.get("list", "/records", {
            success: Schema.Struct({ records: Schema.Array(Schema.String) }),
          }).annotate(OpenApi.Identifier, "listRecords"),
        ),
    );
    const records: Array<string> = [];
    const document = OpenApi.fromApi(api);
    const operation = document.paths["/failure"]?.get;
    if (operation === undefined) return yield* Effect.die("Fixture must declare GET /failure");
    // Deliberately unsupported declarations exercise the importer's generic-error fallback.
    Object.assign(operation.responses, {
      "424": {
        description: "Constrained union",
        content: {
          "application/json": {
            schema: {
              anyOf: [{ $ref: "#/components/schemas/BuildMemoryExceeded" }],
              required: ["missing"],
            },
          },
        },
      },
      "418": {
        description: "External reference",
        content: {
          "application/json": { schema: { $ref: "https://example.invalid/errors.json" } },
        },
      },
      "420": {
        description: "Boolean schema",
        content: { "application/json": { schema: false } },
      },
      "421": { $ref: "https://example.invalid/response.json" },
      "425": {
        description: "Reference sibling constraint",
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/BuildMemoryExceeded",
              properties: { message: { not: { const: openapiSecretMarker } } },
            },
          },
        },
      },
    });
    // Each pet declares its discriminator as a plain string, so only the mapping selects one.
    const pet = (sound: string) => ({
      type: "object",
      properties: { petType: { type: "string" }, [sound]: { type: "boolean" } },
      required: ["petType", sound],
    });
    Object.assign(document, {
      components: {
        ...document.components,
        schemas: {
          ...document.components.schemas,
          Cat: pet("meow"),
          Dog: pet("bark"),
        },
        parameters: {
          WireId: {
            name: "id",
            in: "path",
            required: true,
            style: "matrix",
            explode: true,
            schema: {
              type: "object",
              properties: { role: { type: "string" } },
              required: ["role"],
            },
          },
        },
      },
    });
    Object.assign(document.paths, {
      // The API serves no items, so every call fails with a status the document does not declare.
      "/items/{item}": {
        get: {
          operationId: "getItem",
          parameters: [{ name: "item", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Item",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/wire/{id}": {
        post: {
          operationId: "wire",
          parameters: [
            { $ref: "#/components/parameters/WireId" },
            { name: "theme", in: "cookie", schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  properties: { ids: { type: "array", items: { type: "string" } } },
                  required: ["ids"],
                },
                encoding: { ids: { style: "pipeDelimited", explode: false } },
              },
              "application/json": { schema: {} },
            },
          },
          responses: {
            "200": {
              description: "Wire request",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/pets": {
        post: {
          operationId: "adopt",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/Cat" },
                    { $ref: "#/components/schemas/Dog" },
                  ],
                  // A mapping may name a schema by reference or by component name.
                  discriminator: {
                    propertyName: "petType",
                    mapping: { cat: "#/components/schemas/Cat", dog: "Dog" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Adopted pet",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    });
    const routes = Layer.mergeAll(
      HttpRouter.add(
        "POST",
        "/wire/*",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* HttpServerResponse.json({
            url: request.url,
            cookie: request.headers.cookie,
            contentType: request.headers["content-type"],
            body: yield* request.text,
          });
        }),
      ),
      HttpRouter.add("GET", "/openapi.json", HttpServerResponse.json(document)),
      HttpRouter.add(
        "POST",
        "/records",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const record = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
          )(yield* request.text);
          // The change is committed before the failure, so a repeat would save it twice.
          records.push(record.name);
          return yield* HttpServerResponse.json({ message: openapiSecretMarker }, { status: 502 });
        }),
      ),
      HttpRouter.add(
        "POST",
        "/records/bulk",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { names } = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ names: Schema.Array(Schema.String) })),
          )(yield* request.text);
          for (const name of names) {
            // The records before a refused one stay saved: the request partly committed.
            if (name === "")
              return yield* HttpServerResponse.json(
                { _tag: "InvalidRecord", message: "Record names must not be empty." },
                { status: 422 },
              );
            if (name === "conflict")
              return yield* HttpServerResponse.json(
                {
                  _tag: "StoreConflict",
                  message: openapiConflictMessage,
                  recovery: openapiRetryRecovery,
                },
                { status: 409 },
              );
            records.push(name);
          }
          return yield* HttpServerResponse.json({ saved: names });
        }),
      ),
      HttpRouter.add(
        "GET",
        "/records",
        Effect.suspend(() => HttpServerResponse.json({ records })),
      ),
      HttpRouter.add(
        "GET",
        "/items/*",
        HttpServerResponse.text(openapiSecretMarker, { status: 404, contentType: "text/plain" }),
      ),
      HttpRouter.add(
        "GET",
        "/failure",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const mode = new URL(request.url, "http://fixture.test").searchParams.get("mode");
          const body = {
            _tag: "BuildMemoryExceeded",
            message: openapiSecretMarker,
            description: openapiSecretMarker,
            stack: openapiSecretMarker,
            recovery: openapiMemoryRecovery,
          };
          if (mode === "known")
            return yield* HttpServerResponse.json(
              {
                _tag: "BuildMemoryExceeded",
                message: openapiMemoryMessage,
                recovery: openapiMemoryRecovery,
              },
              { status: 422 },
            );
          if (mode === "dynamic")
            return yield* HttpServerResponse.json(
              {
                _tag: "OAuthSetupFailed",
                reason: "registration_rejected",
                message: openapiOAuthMessage,
                recovery: openapiMemoryRecovery,
              },
              { status: 422 },
            );
          if (mode === "declared-forbidden" || mode === "declared-limited")
            return yield* HttpServerResponse.json(
              { _tag: "ExportDenied", message: openapiDeniedMessage },
              {
                status: 403,
                // Rate-limit evidence still wins over a declared body.
                headers: mode === "declared-limited" ? { "x-ratelimit-remaining": "0" } : {},
              },
            );
          if (mode === "missing-message")
            return yield* HttpServerResponse.json(
              { _tag: "BuildMemoryExceeded", recovery: openapiMemoryRecovery },
              { status: 422 },
            );
          if (mode === "invalid-message" || mode === "long-message" || mode === "empty-message")
            return yield* HttpServerResponse.json(
              {
                _tag: "BuildMemoryExceeded",
                message:
                  mode === "invalid-message" ? 42 : mode === "long-message" ? "x".repeat(4100) : "",
                recovery: openapiMemoryRecovery,
              },
              { status: 422 },
            );
          // Conflict allows extra fields, so recovery is optional and validated separately.
          if (mode === "extras")
            return yield* HttpServerResponse.json(
              {
                ...body,
                _tag: "Conflict",
                revision: 1,
                recovery: { action: openapiSecretMarker, instructions: 42 },
              },
              { status: 422 },
            );
          if (mode === "conflict-recovery")
            return yield* HttpServerResponse.json(
              { _tag: "Conflict", revision: 1, recovery: openapiConflictRecovery },
              { status: 422 },
            );
          if (mode === "slow")
            return HttpServerResponse.stream(
              Stream.concat(Stream.make(new TextEncoder().encode("{")), Stream.never),
              { status: 422, contentType: "application/json" },
            );
          if (mode === "malformed")
            return HttpServerResponse.text("{", { status: 422, contentType: "application/json" });
          if (mode === "html")
            return HttpServerResponse.text(openapiSecretMarker, {
              status: 422,
              contentType: "text/html",
            });
          if (mode === "oversized" || mode === "chunked") {
            const text = JSON.stringify({ ...body, padding: "x".repeat(80_000) });
            return mode === "oversized"
              ? HttpServerResponse.text(text, { status: 422, contentType: "application/json" })
              : HttpServerResponse.stream(
                  Stream.fromIterable([text.slice(0, 40_000), text.slice(40_000)]).pipe(
                    Stream.encodeText,
                  ),
                  { status: 422, contentType: "application/json" },
                );
          }
          if (mode === "unknown")
            return yield* HttpServerResponse.json({ _tag: openapiSecretMarker }, { status: 422 });
          if (mode === "invalid")
            return yield* HttpServerResponse.json(
              { _tag: "Conflict", revision: openapiSecretMarker },
              { status: 422 },
            );
          const status =
            mode === "unauthorized"
              ? 401
              : mode === "forbidden"
                ? 403
                : mode === "limited"
                  ? 429
                  : mode === "bad-gateway"
                    ? 502
                    : mode === "constrained"
                      ? 424
                      : mode === "ref-sibling"
                        ? 425
                        : mode === "unsupported-response"
                          ? 421
                          : mode === "unsupported"
                            ? 418
                            : mode === "wrong-status"
                              ? 409
                              : 422;
          return yield* HttpServerResponse.json(body, { status });
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
    return `http://127.0.0.1:${server.address.port}`;
  });
