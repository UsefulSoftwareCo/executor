// ---------------------------------------------------------------------------
// Local app auth failure propagation
// ---------------------------------------------------------------------------
//
// Exercises the local HTTP API boundary:
//
//   test -> HttpApiClient -> in-process LocalApi -> execution engine
//        -> sandbox code -> OpenAPI tool invocation
//
// The assertion is intentionally on the final execution payload, not the
// plugin facade, so reviewers can see that model-visible tool results carry
// auth guidance instead of an opaque internal tool error.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/unstable/httpapi";

import { addGroup, observabilityMiddleware } from "@executor-js/api";
import {
  CoreHandlers,
  ExecutionEngineService,
  ExecutorService,
  collectTables,
} from "@executor-js/api/server";
import { createExecutionEngine } from "@executor-js/execution";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { openApiPlugin } from "@executor-js/plugin-openapi";
import {
  OpenApiExtensionService,
  OpenApiGroup,
  OpenApiHandlers,
} from "@executor-js/plugin-openapi/api";
import { makeOpenApiHttpApiTestAddSpecPayload } from "@executor-js/plugin-openapi/testing";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { Scope, ScopeId, createExecutor } from "@executor-js/sdk";

import { ErrorCaptureLive } from "./observability";
import { createSqliteFumaDb } from "./db/sqlite-fumadb";

const TEST_BASE_URL = "http://local.test";

const PingGroup = HttpApiGroup.make("default", { topLevel: true }).add(
  HttpApiEndpoint.get("ping", "/ping", { success: Schema.Unknown }),
);

const MissingAuthSourceApi = HttpApi.make("localAuthFailureSource").add(PingGroup);

const TestApi = addGroup(OpenApiGroup);
type TestApiShape =
  typeof TestApi extends HttpApi.HttpApi<infer _Id, infer Groups>
    ? HttpApiClient.Client<Groups, never>
    : never;

interface Harness {
  readonly fetch: typeof globalThis.fetch;
  readonly scopeId: ScopeId;
  readonly dispose: () => Promise<void>;
}

const startHarness = async (tmpDir: string): Promise<Harness> => {
  const scopeId = ScopeId.make(`test-${randomBytes(4).toString("hex")}`);
  const plugins = [
    openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
    fileSecretsPlugin({ directory: tmpDir }),
  ] as const;
  const sqlite = await createSqliteFumaDb({
    tables: collectTables(),
    namespace: "executor_local_auth_tool_failures_test",
    path: join(tmpDir, "data.db"),
  });

  const executor = await Effect.runPromise(
    createExecutor({
      scopes: [
        Scope.make({
          id: scopeId,
          name: "test",
          createdAt: new Date(),
        }),
      ],
      db: sqlite.db,
      plugins,
      onElicitation: "accept-all",
    }),
  );

  const engine = createExecutionEngine({
    executor,
    codeExecutor: makeQuickJsExecutor(),
  });

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
    scopeId,
    dispose: async () => {
      await Effect.runPromise(Effect.ignore(Effect.tryPromise(() => disposeHandler())));
      await Effect.runPromise(
        Effect.ignore(Effect.tryPromise(() => Effect.runPromise(executor.close()))),
      );
      await sqlite.close();
    },
  };
};

const run = <A, E>(body: (client: TestApiShape) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(TestApi, { baseUrl: TEST_BASE_URL });
    return yield* body(client);
  }).pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(harness.fetch)),
      ),
    ),
  ) as Effect.Effect<A, E>;

type EffectSuccess<T> = T extends Effect.Effect<infer A, unknown, unknown> ? A : never;
type ExecuteResult = EffectSuccess<ReturnType<TestApiShape["executions"]["execute"]>>;

const expectModelVisibleAuthFailure = (execution: ExecuteResult) => {
  expect(execution.status).toBe("completed");
  if (execution.status !== "completed") return;
  expect(execution.isError).toBe(false);
  expect(JSON.stringify(execution.structured)).not.toContain("Internal tool error");
  expect(JSON.stringify(execution.structured)).not.toContain("Internal Tool Error");
  expect(execution.structured).toMatchObject({
    status: "completed",
    result: {
      ok: false,
      error: {
        code: "credential_binding_missing",
        details: {
          category: "authentication",
          recovery: {
            createSecretTool: "executor.coreTools.secrets.create",
            secretsUrl: "https://executor.sh/secrets",
          },
        },
      },
    },
  });
};

let tmpDir: string;
let harness: Harness;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "executor-local-auth-tool-failures-"));
  harness = await startHarness(tmpDir);
});

afterAll(async () => {
  await harness.dispose();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("local auth tool failures", () => {
  it.effect("local propagates missing credential binding as model-visible auth failure", () =>
    Effect.gen(function* () {
      const namespace = `auth_${randomBytes(4).toString("hex")}`;
      yield* run((client) =>
        client.openapi.addSpec({
          params: { scopeId: harness.scopeId },
          payload: {
            ...makeOpenApiHttpApiTestAddSpecPayload(MissingAuthSourceApi, {
              namespace,
              headers: {
                Authorization: { kind: "secret", prefix: "Bearer " },
              },
            }),
            baseUrl: "https://api.example.test",
          },
        }),
      );

      const execution = yield* run((client) =>
        client.executions.execute({
          payload: {
            code: [
              `const result = await tools.${namespace}.default.ping({});`,
              "return result;",
            ].join("\n"),
          },
        }),
      );

      expectModelVisibleAuthFailure(execution);
    }),
  );
});
