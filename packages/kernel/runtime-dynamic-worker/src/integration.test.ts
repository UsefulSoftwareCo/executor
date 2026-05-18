// ---------------------------------------------------------------------------
// Cross-layer integration tests: sandboxed user code → ToolDispatcher RPC →
// makeExecutorToolInvoker → openApiPlugin → recording HttpClient.
//
// These exist to catch the class of bug where each layer's unit tests pass
// in isolation but the seam between two layers loses or corrupts data. The
// canonical case is a multipart upload where the user constructs a Blob in
// sandbox code: every layer accepts Blobs in its own contract, but the
// sandbox→host RPC hop used to JSON.stringify the args, leaving the
// upstream multipart encoder with `{}` where the file should have been.
//
// Each test runs real user code through the dynamic Worker, drives a real
// openApiPlugin (with a real spec), and inspects the actual request body
// that would have hit the wire.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/postgres-js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http";
import { fumadb } from "fumadb";
import { createDrizzleRuntimeSchemaFromTables, drizzleAdapter } from "fumadb/adapters/drizzle";
import { schema as fumaSchema } from "fumadb/schema";
import postgres from "postgres";

import {
  collectTables,
  createExecutor,
  definePlugin,
  type InvokeOptions,
  type SecretProvider,
  Scope,
  ScopeId,
  type FumaDb,
  type FumaTables,
} from "@executor-js/sdk";
import { makeExecutorToolInvoker } from "@executor-js/execution";
import { openApiPlugin } from "@executor-js/plugin-openapi";

import { makeDynamicWorkerExecutor } from "./executor";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };
const TEST_SCOPE = "test-scope";
const DATABASE_NAMESPACE = "executor_worker_test";
const DATABASE_URL =
  (env as { DATABASE_URL?: string }).DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5435/postgres";

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

type CapturedRequest = {
  url: string;
  method: string;
  contentType: string;
  bodyKind: string;
  body: Uint8Array;
};

/**
 * Build an HttpClient layer that captures every request the openApiPlugin
 * dispatches, returning a 200 OK with `{}`. Captured requests are exposed
 * via the returned `captured` array (mutated in place). Reads multipart
 * `FormData` bodies into their on-the-wire bytes via the platform `Response`
 * encoder so assertions can match the actual multipart frame.
 */
const makeRecordingHttpClient = () => {
  const captured: CapturedRequest[] = [];

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const headers = { ...request.headers };
        let bytes = new Uint8Array();
        let contentType = headers["content-type"] ?? "";
        const isRaw = Predicate.isTagged(request.body, "Raw");
        const isUint8Array = Predicate.isTagged(request.body, "Uint8Array");
        const isFormData = Predicate.isTagged(request.body, "FormData");

        if (isRaw || isUint8Array) {
          const wire = new Request("http://capture/", {
            method: "POST",
            body: request.body.body as BodyInit,
          });
          bytes = new Uint8Array(yield* Effect.promise(() => wire.arrayBuffer()));
        } else if (isFormData) {
          // Letting `Response` realize the FormData yields the actual
          // multipart wire bytes plus a generated boundary in its
          // content-type header — exactly what the upstream server sees.
          const wire = new Response(request.body.formData);
          contentType = wire.headers.get("content-type") ?? contentType;
          bytes = new Uint8Array(yield* Effect.promise(() => wire.arrayBuffer()));
        }

        captured.push({
          url: request.url,
          method: request.method,
          contentType,
          bodyKind: isRaw ? "Raw" : isUint8Array ? "Uint8Array" : isFormData ? "FormData" : "",
          body: bytes,
        });

        return HttpClientResponse.fromWeb(
          request,
          new Response('{"ok":true}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

  return { layer, captured };
};

const makeSpec = (contentType: string, schema: Record<string, unknown> = { type: "object" }) =>
  JSON.stringify({
    openapi: "3.0.0",
    info: { title: "IntegrationTest", version: "1.0.0" },
    paths: {
      "/submit": {
        post: {
          operationId: "submit",
          tags: ["body"],
          requestBody: {
            required: true,
            content: { [contentType]: { schema } },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });

const createPostgresFumaDb = <const TTables extends FumaTables>(
  db: unknown,
  tables: TTables,
): FumaDb<any> => {
  const version = "1.0.0" as const;
  const factory = fumadb({
    namespace: DATABASE_NAMESPACE,
    schemas: [
      fumaSchema({
        version,
        tables,
      }),
    ],
  });
  const fuma = factory.client(
    drizzleAdapter({
      db,
      provider: "postgresql",
    }),
  );
  return fuma.orm(version);
};

const buildSandboxBridge = (spec: string, namespace: string, baseUrl = "https://upstream.test") =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const recording = makeRecordingHttpClient();
      const plugins = [
        openApiPlugin({ httpClientLayer: recording.layer }),
        memorySecretsPlugin(),
      ] as const;
      const tables = collectTables(plugins);
      const sql = postgres(DATABASE_URL, {
        max: 1,
        idle_timeout: 0,
        max_lifetime: 60,
        connect_timeout: 10,
        fetch_types: false,
        prepare: true,
        onnotice: () => undefined,
      });
      const schema = createDrizzleRuntimeSchemaFromTables({
        tables,
        namespace: DATABASE_NAMESPACE,
        version: "1.0.0",
        provider: "postgresql",
      });
      const db = createPostgresFumaDb(drizzle(sql, { schema }), tables);
      const executor = yield* createExecutor({
        scopes: [
          Scope.make({
            id: ScopeId.make(TEST_SCOPE),
            name: "test",
            createdAt: new Date(),
          }),
        ],
        db,
        plugins,
        onElicitation: "accept-all",
      });
      yield* executor.openapi.addSpec({
        spec: { kind: "blob", value: spec },
        scope: TEST_SCOPE,
        namespace,
        name: namespace,
        baseUrl,
      });
      const invoker = makeExecutorToolInvoker(executor, { invokeOptions: autoApprove });
      return { executor, invoker, captured: recording.captured, sql };
    }),
    ({ executor, sql }) =>
      executor.close().pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.tryPromise({
            try: () => sql.end({ timeout: 0 }),
            catch: (cause) => cause,
          }).pipe(Effect.ignore),
        ),
      ),
  );

const loader = (env as { LOADER: WorkerLoader }).LOADER;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sandbox → openApiPlugin integration", () => {
  it.effect("multipart with Blob: file part contains the original bytes", () =>
    Effect.gen(function* () {
      const { invoker, captured } = yield* buildSandboxBridge(
        makeSpec("multipart/form-data"),
        "mp",
      );
      const sandbox = makeDynamicWorkerExecutor({ loader });

      const result = yield* sandbox.execute(
        `async () => {
          const file = new Blob(["hello multipart"], { type: "text/plain" });
          await tools.mp.body.submit({ body: { file, name: "Acme" } });
        }`,
        invoker,
      );

      expect(result.error).toBeUndefined();
      expect(captured).toHaveLength(1);
      const req = captured[0]!;
      expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/);
      const wire = new TextDecoder().decode(req.body);
      expect(wire).toMatch(/name="file"[\s\S]*?hello multipart/);
      expect(wire).toContain('name="name"');
      expect(wire).toContain("Acme");
      // Regression guard for the JSON-stringify bug — the symptom was
      // either an empty body part or `[object Object]` in place of bytes.
      expect(wire).not.toContain("[object Object]");
    }).pipe(Effect.scoped),
  );

  it.effect("multipart with Uint8Array: bytes survive intact", () =>
    Effect.gen(function* () {
      const { invoker, captured } = yield* buildSandboxBridge(
        makeSpec("multipart/form-data"),
        "u8",
      );
      const sandbox = makeDynamicWorkerExecutor({ loader });

      const result = yield* sandbox.execute(
        `async () => {
          const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
          await tools.u8.body.submit({ body: { file: bytes } });
        }`,
        invoker,
      );

      expect(result.error).toBeUndefined();
      const wire = captured[0]!.body;
      // Find DEADBEEF anywhere in the multipart frame.
      const needle = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      let found = false;
      for (let i = 0; i <= wire.length - needle.length; i++) {
        if (
          wire[i] === needle[0] &&
          wire[i + 1] === needle[1] &&
          wire[i + 2] === needle[2] &&
          wire[i + 3] === needle[3]
        ) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("application/json: primitive object body round-trips unchanged", () =>
    Effect.gen(function* () {
      const { invoker, captured } = yield* buildSandboxBridge(makeSpec("application/json"), "j");
      const sandbox = makeDynamicWorkerExecutor({ loader });

      const result = yield* sandbox.execute(
        `async () => {
          await tools.j.body.submit({ body: { name: "Acme", count: 7, ok: true } });
        }`,
        invoker,
      );
      expect(result.error).toBeUndefined();
      const json = JSON.parse(new TextDecoder().decode(captured[0]!.body));
      expect(json).toEqual({ name: "Acme", count: 7, ok: true });
    }).pipe(Effect.scoped),
  );

  it.effect("application/octet-stream: Uint8Array body matches byte-for-byte", () =>
    Effect.gen(function* () {
      const { invoker, captured } = yield* buildSandboxBridge(
        makeSpec("application/octet-stream"),
        "oct",
      );
      const sandbox = makeDynamicWorkerExecutor({ loader });

      const result = yield* sandbox.execute(
        `async () => {
          const payload = new Uint8Array([1, 2, 3, 4, 5, 0xff, 0x00, 0x7f]);
          await tools.oct.body.submit({ body: payload });
        }`,
        invoker,
      );

      expect(result.error).toBeUndefined();
      expect(Array.from(captured[0]!.body)).toEqual([1, 2, 3, 4, 5, 0xff, 0x00, 0x7f]);
    }).pipe(Effect.scoped),
  );
});
