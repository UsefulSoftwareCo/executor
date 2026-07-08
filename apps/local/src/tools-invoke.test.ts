// ---------------------------------------------------------------------------
// REST tool invocation + OpenAPI export: the wire surface behind
// `executor generate`.
//
// Full loop over real HTTP handlers (no mocked executor): an OpenAPI spec is
// registered, a connection created, then tools are invoked through
// POST /api/tools/invoke/{path}, exactly what a client generated from the
// exported OpenAPI document would do:
//   - a successful call returns the ok envelope with the upstream's data,
//   - an unknown path answers 404 (not a buried execution error),
//   - GET /api/tools/export/openapi serves a document whose paths match the
//     invokable tools and whose servers[0] points back at this API.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { addGroup, observabilityMiddleware } from "@executor-js/api";
import {
  CoreHandlers,
  ExecutionEngineService,
  ExecutorService,
  collectTables,
} from "@executor-js/api/server";
import { createExecutionEngine } from "@executor-js/execution";
import { openApiPlugin } from "@executor-js/plugin-openapi";
import {
  OpenApiExtensionService,
  OpenApiGroup,
  OpenApiHandlers,
} from "@executor-js/plugin-openapi/api";
import {
  makeOpenApiHttpApiTestSourceConfig,
  serveOpenApiHttpApiTestServer,
} from "@executor-js/plugin-openapi/testing";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  Subject,
  Tenant,
  createExecutor,
} from "@executor-js/sdk";
import { memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { ErrorCaptureLive } from "./observability";
import { createSqliteFumaDb } from "./db/sqlite-fumadb";

const TEST_BASE_URL = "http://local.test";
const API_KEY_TEMPLATE = "apiKey";

// A tiny upstream: one echo endpoint, so a full invoke round trip can be
// asserted on real data.
const EchoResponse = Schema.Struct({
  echoed: Schema.String,
  apiKey: Schema.optional(Schema.String),
});

const EchoGroup = HttpApiGroup.make("default", { topLevel: true }).add(
  HttpApiEndpoint.post("echo", "/echo", {
    payload: Schema.Struct({ message: Schema.String }),
    success: EchoResponse,
  }),
);
const UpstreamApi = HttpApi.make("invokeUpstream").add(EchoGroup);

const UpstreamLive = HttpApiBuilder.group(UpstreamApi, "default", (handlers) =>
  handlers.handle("echo", ({ payload }) =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      return EchoResponse.make({
        echoed: payload.message,
        apiKey: req.headers["x-api-key"],
      });
    }),
  ),
);

const TestApi = addGroup(OpenApiGroup);

interface Harness {
  readonly fetch: typeof globalThis.fetch;
  readonly integration: string;
  readonly dispose: () => Promise<void>;
}

const startHarness = async (tmpDir: string): Promise<Harness> => {
  const plugins = [
    openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
    memoryCredentialsPlugin(),
  ] as const;
  const sqlite = await createSqliteFumaDb({
    tables: collectTables(),
    namespace: "executor_local_tools_invoke_test",
    path: join(tmpDir, "data.db"),
  });

  const executor = await Effect.runPromise(
    createExecutor({
      tenant: Tenant.make(`test-${randomBytes(4).toString("hex")}`),
      subject: Subject.make("local"),
      db: sqlite.db,
      plugins,
      onElicitation: "accept-all",
    }),
  );

  const engine = createExecutionEngine({
    executor,
    codeExecutor: makeQuickJsExecutor(),
  });

  // Real upstream server the registered spec's tools dial. Its scope stays
  // open for the harness lifetime (closing it would shut the server down
  // before any tool call reaches it) and is released in dispose.
  const upstreamScope = Effect.runSync(Scope.make());
  const upstream = await Effect.runPromise(
    serveOpenApiHttpApiTestServer({ api: UpstreamApi, handlersLayer: UpstreamLive }).pipe(
      Scope.provide(upstreamScope),
      Effect.orDie,
    ),
  );

  const integration = `invoke_${randomBytes(4).toString("hex")}`;
  await Effect.runPromise(
    executor.openapi
      .addSpec({
        ...makeOpenApiHttpApiTestSourceConfig(UpstreamApi, {
          slug: integration,
          baseUrl: upstream.baseUrl,
          authenticationTemplate: [
            {
              slug: AuthTemplateSlug.make(API_KEY_TEMPLATE),
              type: "apiKey" as const,
              headers: { "x-api-key": [{ type: "variable" as const, name: "token" }] },
            },
          ],
        }),
      })
      .pipe(Effect.orDie),
  );
  await Effect.runPromise(
    executor.connections
      .create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make(integration),
        template: AuthTemplateSlug.make(API_KEY_TEMPLATE),
        value: "secret-key",
      })
      .pipe(Effect.orDie),
  );

  const TestObservability = observabilityMiddleware(TestApi);
  const TestApiBase = HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(CoreHandlers),
    Layer.provide(OpenApiHandlers),
    Layer.provide(TestObservability),
    Layer.provide(ErrorCaptureLive),
  );

  const { handler: webHandler, dispose: disposeHandler } = HttpRouter.toWebHandler(
    TestApiBase.pipe(
      Layer.provideMerge(Layer.succeed(OpenApiExtensionService)(executor.openapi)),
      Layer.provideMerge(Layer.succeed(ExecutorService)(executor)),
      Layer.provideMerge(Layer.succeed(ExecutionEngineService)(engine)),
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
    ),
  );

  return {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      webHandler(
        input instanceof Request ? input : new Request(input, init),
      )) as typeof globalThis.fetch,
    integration,
    dispose: async () => {
      await Effect.runPromise(Effect.ignore(Effect.tryPromise(() => disposeHandler())));
      await Effect.runPromise(Effect.ignore(executor.close()));
      await Effect.runPromise(Scope.close(upstreamScope, Exit.void));
      await sqlite.close();
    },
  };
};

let tmpDir: string;
let harness: Harness;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "executor-local-tools-invoke-"));
  harness = await startHarness(tmpDir);
});

afterAll(async () => {
  await harness.dispose();
  rmSync(tmpDir, { recursive: true, force: true });
});

const postInvoke = (path: string, body: unknown, options?: { autoApprove?: boolean }) =>
  Effect.tryPromise({
    try: async () => {
      const query = options?.autoApprove ? "?autoApprove=true" : "";
      const response = await harness.fetch(
        `${TEST_BASE_URL}/tools/invoke/${encodeURIComponent(path)}${query}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          body: JSON.stringify(body),
        },
      );
      return { status: response.status, body: (await response.json()) as unknown };
    },
    // oxlint-disable-next-line executor/no-instanceof-error, executor/no-error-constructor, executor/no-unknown-error-message -- test boundary: normalize in-process fetch rejections
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

describe("REST tool invocation", () => {
  it.effect("invokes a tool end to end and returns the ok envelope", () =>
    Effect.gen(function* () {
      // OpenAPI-plugin tools take carrier-shaped input: the request body
      // rides under `body` (matching the tool's exported input schema).
      // autoApprove: POST tools default to approval-gated; the caller here
      // is the approver.
      const { status, body } = yield* postInvoke(
        `${harness.integration}.org.main.default.echo`,
        { body: { message: "hello" } },
        { autoApprove: true },
      );
      expect(status).toBe(200);
      // Real upstream data plus the rendered credential prove the whole
      // executor path (auth template included) ran.
      expect(body).toMatchObject({
        ok: true,
        data: { echoed: "hello", apiKey: "secret-key" },
      });
    }),
  );

  it.effect("pauses approval-gated calls with resume coordinates", () =>
    Effect.gen(function* () {
      const { status, body } = yield* postInvoke(`${harness.integration}.org.main.default.echo`, {
        body: { message: "needs approval" },
      });
      expect(status).toBe(200);
      expect(body).toMatchObject({
        ok: false,
        error: { code: "execution_paused" },
      });
      const error = (body as { error: { executionId?: string; resumePath?: string } }).error;
      expect(error.executionId).toMatch(/^exec_/);
      expect(error.resumePath).toBe(`/executions/${encodeURIComponent(error.executionId!)}/resume`);
    }),
  );

  it.effect("answers 404 for an unknown tool path", () =>
    Effect.gen(function* () {
      const { status } = yield* postInvoke(`${harness.integration}.org.main.default.nope`, {});
      expect(status).toBe(404);
    }),
  );

  it.effect("rejects a non-object body with a typed error", () =>
    Effect.gen(function* () {
      const { status, body } = yield* postInvoke(
        `${harness.integration}.org.main.default.echo`,
        [1, 2, 3],
      );
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }),
  );
});

describe("OpenAPI export endpoint", () => {
  it.effect("serves a document whose operations match the invokable tools", () =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          harness.fetch(`${TEST_BASE_URL}/tools/export/openapi`, {
            // The direct web-handler harness carries no Host header; supply
            // the forwarded pair a fronting proxy would send.
            headers: { "x-forwarded-host": "local.test", "x-forwarded-proto": "http" },
          }),
        // oxlint-disable-next-line executor/no-instanceof-error, executor/no-error-constructor, executor/no-unknown-error-message -- test boundary: normalize in-process fetch rejections
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      expect(response.status).toBe(200);
      const document = (yield* Effect.tryPromise({
        try: () => response.json() as Promise<Record<string, unknown>>,
        // oxlint-disable-next-line executor/no-instanceof-error, executor/no-error-constructor, executor/no-unknown-error-message -- test boundary: normalize in-process fetch rejections
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      })) as {
        openapi: string;
        servers: ReadonlyArray<{ url: string }>;
        paths: Record<string, unknown>;
      };

      expect(document.openapi).toBe("3.1.0");
      // servers[0] points back at this instance's public API base, derived
      // from the request (`/api` is what CLI/proxy clients dial; the host
      // shell strips it before routes see it).
      expect(document.servers[0]!.url).toBe(`${TEST_BASE_URL}/api`);
      expect(
        document.paths[`/tools/invoke/${harness.integration}.org.main.default.echo`],
      ).toBeDefined();
    }),
  );
});
