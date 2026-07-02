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
import { fumadb } from "@executor-js/fumadb";
import {
  createDrizzleRuntimeSchemaFromTables,
  drizzleAdapter,
} from "@executor-js/fumadb/adapters/drizzle";
import { schema as fumaSchema } from "@executor-js/fumadb/schema";
import postgres from "postgres";

import {
  collectTables,
  createExecutor,
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  Subject,
  Tenant,
  type CredentialProvider,
  type InvokeOptions,
  type ProviderEntry,
  type FumaDb,
  type FumaTables,
} from "@executor-js/sdk";
import { makeExecutorToolInvoker } from "@executor-js/execution";
import { openApiPlugin, variable, type AuthenticationInput } from "@executor-js/plugin-openapi";

import { makeDynamicWorkerExecutor } from "./executor";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };
const TEST_TENANT = "test-tenant";
const TEST_SUBJECT = "test-subject";
const DATABASE_NAMESPACE = "executor_worker_test";
const DATABASE_URL =
  (env as { DATABASE_URL?: string }).DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5435/postgres";

// v2 credential provider: a connection IS the credential, resolved by an opaque
// id (no scope arg). Registered via `createExecutor({ providers })`. These tests
// don't exercise real auth, so the value is a throwaway token whose only job is
// to make the apiKey template render so per-connection tools get produced.
const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id: ProviderItemId) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id: ProviderItemId, value: string) =>
      Effect.sync(() => void store.set(String(id), value)),
    has: (id: ProviderItemId) => Effect.sync(() => store.has(String(id))),
    list: () =>
      Effect.sync((): readonly ProviderEntry[] =>
        Array.from(store.keys()).map((key) => ({
          id: ProviderItemId.make(key),
          name: key,
        })),
      ),
  };
};

// Minimal apiKey template: the resolved connection value renders into an
// `x-api-key` header. The body round-trip tests don't assert on auth, but a
// template + connection are required for tools to exist per-connection.
const apiKeyTemplate: AuthenticationInput = {
  slug: "apiKey",
  type: "apiKey",
  headers: { "x-api-key": [variable("token")] },
};

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

const buildSandboxBridge = (spec: string, slug: string, baseUrl = "https://upstream.test") =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const recording = makeRecordingHttpClient();
      const plugins = [openApiPlugin({ httpClientLayer: recording.layer })] as const;
      const tables = collectTables();
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
        tenant: Tenant.make(TEST_TENANT),
        subject: Subject.make(TEST_SUBJECT),
        db,
        providers: [memoryProvider()],
        plugins,
        onElicitation: "accept-all",
      });
      // v2: addSpec registers the integration; tools are produced per-connection,
      // so an org `main` connection is required for the operation to be callable.
      yield* executor.openapi.addSpec({
        spec: { kind: "blob", value: spec },
        slug,
        baseUrl,
        authenticationTemplate: [apiKeyTemplate],
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make(slug),
        template: AuthTemplateSlug.make("apiKey"),
        value: "test-token",
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
          await tools.mp.org.main.body.submit({ body: { file, name: "Acme" } });
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
          await tools.u8.org.main.body.submit({ body: { file: bytes } });
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
          await tools.j.org.main.body.submit({ body: { name: "Acme", count: 7, ok: true } });
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
          await tools.oct.org.main.body.submit({ body: payload });
        }`,
        invoker,
      );

      expect(result.error).toBeUndefined();
      expect(Array.from(captured[0]!.body)).toEqual([1, 2, 3, 4, 5, 0xff, 0x00, 0x7f]);
    }).pipe(Effect.scoped),
  );
});
