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
//
// v2: a connection IS the credential. addSpec registers the integration with an
// apiKey auth template; a connection is then created whose value cannot resolve
// (a `from` reference to a missing provider item). Invoking one of that
// connection's tools surfaces `connection_value_missing` to the model.
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
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  Subject,
  Tenant,
  createExecutor,
} from "@executor-js/sdk";
import { memoryCredentialsPlugin } from "@executor-js/sdk/testing";

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

const API_KEY_TEMPLATE = "apiKey";

interface Harness {
  readonly fetch: typeof globalThis.fetch;
  readonly addConnection: (input: {
    readonly integration: string;
    readonly connection: string;
  }) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

const startHarness = async (tmpDir: string): Promise<Harness> => {
  const plugins = [
    openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
    fileSecretsPlugin({ directory: tmpDir }),
    memoryCredentialsPlugin(),
  ] as const;
  const sqlite = await createSqliteFumaDb({
    tables: collectTables(),
    namespace: "executor_local_auth_tool_failures_test",
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
    // Create an org connection whose value cannot resolve: a `from` reference
    // to a memory-provider item that was never stored resolves to `null`, so
    // tool invocation surfaces `connection_value_missing`.
    addConnection: (input) =>
      Effect.runPromise(
        executor.connections
          .create({
            owner: "org",
            name: ConnectionName.make(input.connection),
            integration: IntegrationSlug.make(input.integration),
            template: AuthTemplateSlug.make(API_KEY_TEMPLATE),
            from: {
              provider: ProviderKey.make("memory"),
              id: ProviderItemId.make(`${input.integration}-missing`),
            },
          })
          .pipe(Effect.asVoid),
      ),
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
    const client = yield* HttpApiClient.make(TestApi, {
      baseUrl: TEST_BASE_URL,
    });
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
        code: "connection_value_missing",
        details: {
          category: "authentication",
          recovery: {
            createConnectionTool: "executor.coreTools.connections.createHandoff",
            listConnectionsTool: "executor.coreTools.connections.list",
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
  it.effect("local propagates missing credential value as model-visible auth failure", () =>
    Effect.gen(function* () {
      const integration = `auth_${randomBytes(4).toString("hex")}`;
      const connection = "main";
      yield* run((client) =>
        client.openapi.addSpec({
          payload: {
            ...makeOpenApiHttpApiTestAddSpecPayload(MissingAuthSourceApi, {
              slug: integration,
              authenticationTemplate: [
                {
                  slug: AuthTemplateSlug.make(API_KEY_TEMPLATE),
                  type: "apiKey" as const,
                  headers: {
                    Authorization: ["Bearer ", { type: "variable" as const, name: "token" }],
                  },
                },
              ],
            }),
            baseUrl: "https://api.example.test",
          },
        }),
      );

      yield* Effect.promise(() => harness.addConnection({ integration, connection }));

      const execution = yield* run((client) =>
        client.executions.execute({
          payload: {
            code: [
              `const result = await tools.${integration}.org.${connection}.default.ping({});`,
              "return result;",
            ].join("\n"),
          },
        }),
      );

      expectModelVisibleAuthFailure(execution);
    }),
  );
});
