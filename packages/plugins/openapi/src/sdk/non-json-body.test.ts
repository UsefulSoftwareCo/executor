// ---------------------------------------------------------------------------
// Dispatch tests for non-JSON request bodies.
//
// Each case spins up a tiny http server, declares a POST endpoint in a
// minimal OpenAPI spec with the content type under test, and asserts both
// the wire-level content type and body shape the plugin actually sent.
//
// The scenarios mirror what real specs commonly carry — multipart uploads
// (files + scalar fields), XML bodies declared as pre-serialized strings,
// text/plain payloads, and raw octet-stream byte uploads.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi";

import {
  createExecutor,
  definePlugin,
  type InvokeOptions,
  type SecretProvider,
} from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { serveOpenApiHttpApiTestServer } from "@executor-js/plugin-openapi/testing";

import { openApiPlugin } from "./plugin";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };
const TEST_SCOPE = "test-scope";
const JsonNameBody = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
  }),
);
const decodeJsonNameBody = Schema.decodeUnknownSync(JsonNameBody);

const memoryProvider: SecretProvider = (() => {
  const store = new Map<string, string>();
  return {
    key: "memory",
    writable: true,
    get: (id, scope) => Effect.sync(() => store.get(`${scope}:${id}`) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(`${scope}:${id}`, value);
      }),
    delete: (id, scope) => Effect.sync(() => store.delete(`${scope}:${id}`)),
    list: () => Effect.sync(() => []),
  };
})();

const memorySecretsPlugin = definePlugin(() => ({
  id: "memory-secrets" as const,
  storage: () => ({}),
  secretProviders: [memoryProvider],
}));

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
    return { baseUrl: server.baseUrl, specJson: server.specJson, captured };
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
      const { baseUrl, specJson, captured } = yield* startEchoServer({
        payload: ObjectBody.pipe(HttpApiSchema.asMultipart()),
      });

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "mp",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "mp.body.submit",
        { body: { name: "Acme", flag: true, count: 7 } },
        autoApprove,
      );

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
      const { baseUrl, specJson, captured } = yield* startEchoServer({
        payload: Schema.String.pipe(HttpApiSchema.asText({ contentType: "application/xml" })),
      });

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "xml",
        baseUrl,
      });

      const xml = '<?xml version="1.0"?><root><name>Acme</name></root>';
      yield* executor.tools.invoke("xml.body.submit", { body: xml }, autoApprove);

      expect(captured.contentType).toBe("application/xml");
      expect(captured.body.toString("utf8")).toBe(xml);
    }),
  );

  it.effect("text/xml: object body is JSON-stringified (never '[object Object]')", () =>
    Effect.gen(function* () {
      const { baseUrl, specJson, captured } = yield* startEchoServer({
        payload: JsonNameObject,
        transformSpec: replaceRequestBodyContent("/submit", "post", contentFor("text/xml")),
      });

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "tx",
        baseUrl,
      });

      yield* executor.tools.invoke("tx.body.submit", { body: { name: "Acme" } }, autoApprove);

      expect(captured.contentType).toBe("text/xml");
      const body = captured.body.toString("utf8");
      expect(body).not.toBe("[object Object]");
      expect(decodeJsonNameBody(body)).toEqual({ name: "Acme" });
    }),
  );

  it.effect("text/plain: string body passes through with text/plain", () =>
    Effect.gen(function* () {
      const { baseUrl, specJson, captured } = yield* startEchoServer({
        payload: Schema.String.pipe(HttpApiSchema.asText()),
      });

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "tp",
        baseUrl,
      });

      yield* executor.tools.invoke("tp.body.submit", { body: "hello, world" }, autoApprove);

      expect(captured.contentType).toBe("text/plain");
      expect(captured.body.toString("utf8")).toBe("hello, world");
    }),
  );

  it.effect("application/octet-stream: Uint8Array passes through as bytes", () =>
    Effect.gen(function* () {
      const { baseUrl, specJson, captured } = yield* startEchoServer({
        payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      });

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "bin",
        baseUrl,
      });

      const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]);
      yield* executor.tools.invoke("bin.body.submit", { body: payload }, autoApprove);

      expect(captured.contentType).toBe("application/octet-stream");
      expect(captured.body.length).toBe(payload.length);
      expect(Array.from(captured.body)).toEqual(Array.from(payload));
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
      const { baseUrl, specJson, captured } = yield* startEchoServer({
        payload: multiContentPayload,
      });

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "mc",
        baseUrl,
      });

      yield* executor.tools.invoke("mc.body.submit", { body: { name: "Acme" } }, autoApprove);

      // multipart/form-data was declared first in the spec — it wins,
      // even though the old preferredContent would have picked JSON.
      expect(captured.contentType).toMatch(/^multipart\/form-data; boundary=/);
    }),
  );

  it.effect("multi-content: caller can override via args.contentType", () =>
    Effect.gen(function* () {
      const { baseUrl, specJson, captured } = yield* startEchoServer({
        payload: multiContentPayload,
      });

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "mc2",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "mc2.body.submit",
        { contentType: "application/json", body: { name: "Acme" } },
        autoApprove,
      );

      expect(captured.contentType).toBe("application/json");
      expect(decodeJsonNameBody(captured.body.toString("utf8"))).toEqual({
        name: "Acme",
      });
    }),
  );

  it.effect("multi-content: tool input schema exposes contentType enum", () =>
    Effect.gen(function* () {
      const { specJson } = yield* startEchoServer({
        payload: multiContentPayload,
      });
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "mc3",
        baseUrl: "https://example.com",
      });

      const tools = yield* executor.tools.list();
      const submit = tools.find((t) => t.id === "mc3.body.submit");
      expect(submit).toBeDefined();
      const schema = submit!.inputSchema as {
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

  // -------------------------------------------------------------------------
  // Per-part encoding.contentType in multipart — a metadata field declared
  // as application/json must ship with its own `Content-Type: application/
  // json` sub-header so strict servers can parse it correctly.
  // -------------------------------------------------------------------------

  it.effect("multipart encoding.contentType: JSON metadata part has typed header", () =>
    Effect.gen(function* () {
      const { baseUrl, specJson, captured } = yield* startEchoServer({
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

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "mpe",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "mpe.body.upload",
        {
          body: {
            metadata: { owner: "Acme", tags: ["x", "y"] },
            filename: "hello.txt",
          },
        },
        autoApprove,
      );

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
      const { baseUrl, specJson, captured } = yield* startEchoServer({
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

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "fe",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "fe.body.submit",
        { body: { tags: ["red", "blue", "green"], name: "Acme" } },
        autoApprove,
      );

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
      const { baseUrl, specJson, captured } = yield* startEchoServer({
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

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "fd",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "fd.body.submit",
        { body: { filter: { status: "active", tier: "gold" } } },
        autoApprove,
      );

      expect(captured.contentType).toBe("application/x-www-form-urlencoded");
      const body = captured.body.toString("utf8");
      expect(body).toContain("filter%5Bstatus%5D=active");
      expect(body).toContain("filter%5Btier%5D=gold");
    }),
  );

  it.effect("form-urlencoded default: arrays use form+explode=true (repeat key)", () =>
    Effect.gen(function* () {
      const { baseUrl, specJson, captured } = yield* startEchoServer({
        payload: ObjectBody.pipe(HttpApiSchema.asFormUrlEncoded()),
        transformSpec: replaceRequestBodyContent(
          "/submit",
          "post",
          contentFor("application/x-www-form-urlencoded"),
          {},
        ),
      });

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [
            openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
            memorySecretsPlugin(),
          ] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        // No encoding → OAS3 defaults: style=form, explode=true.
        spec: specJson,
        scope: TEST_SCOPE,
        namespace: "fdx",
        baseUrl,
      });

      yield* executor.tools.invoke(
        "fdx.body.submit",
        { body: { tag: ["x", "y"], name: "Acme" } },
        autoApprove,
      );

      expect(captured.contentType).toBe("application/x-www-form-urlencoded");
      const body = captured.body.toString("utf8");
      expect(body).toContain("tag=x&tag=y");
      expect(body).toContain("name=Acme");
    }),
  );
});
