/** Product Worker. One durable actor owns PostgreSQL, auth, sessions and background work. */
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { DurableObjectState, Fetcher } from "@cloudflare/workers-types";
import { PGlite } from "@electric-sql/pglite";
import { PgliteClient } from "@effect/sql-pglite";
import { executorSkillFiles } from "@executor-js/app-templates/executor";
import { bindingWorkerdApps } from "@executor-js/sdk/workerd";
import { ScheduleHostReady } from "@executor-js/sdk/scheduling";
import { telemetryConfig, telemetryLayer } from "@executor-js/telemetry";
import { urlPolicyConfig } from "@executor-js/utils/url-policy";
import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Scope,
} from "effect";
import {
  FetchHttpClient,
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
} from "effect/unstable/http";
import { selfHostDatabaseSchema } from "./implementation/database-schema.ts";
import {
  selfHostExecutorServices,
  SelfHostWorkflowRequests,
} from "./implementation/executor-services.ts";
import { selfHostRouteMap } from "./implementation/routes.ts";
import {
  bindingBlobStore,
  bindingDashboard,
  bindingHttpClient,
  bindingRepositories,
  type HttpBinding,
} from "./implementation/workerd/bindings.ts";
import {
  prepareProductFilesystem,
  completeProductBootstrap,
} from "./implementation/workerd/storage-migration.ts";
import skills from "executor:skills";
import dashboard from "executor:dashboard";
import pgliteWasmModule from "executor:pglite.wasm";
import initdbWasmModule from "executor:initdb.wasm";
import pgliteData from "executor:pglite.data";

interface ProductStub {
  fetch(request: Request): Promise<Response>;
  workflow(request: Request): Promise<Response>;
  exportDatabase(): Promise<Response>;
}
interface Environment {
  readonly PRODUCT: { getByName(name: string): ProductStub };
  readonly LEGACY_DATABASE: HttpBinding;
  readonly NATIVE: HttpBinding;
  readonly BLOBS: HttpBinding;
  readonly DASHBOARD: HttpBinding;
  readonly PUBLIC_FETCH: HttpBinding;
  readonly PRIVATE_FETCH: HttpBinding;
  readonly APPS: Fetcher;
}

const configuration = (native: HttpBinding) =>
  Effect.tryPromise({
    try: async () => {
      const response = await native.fetch(new Request("http://native.internal/configuration"));
      if (!response.ok) throw new Error("Cannot read host configuration");
      return response.json();
    },
    catch: () => new Error("Cannot read host configuration"),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))));

const prepare = (state: DurableObjectState, env: Environment) =>
  Effect.gen(function* () {
    const fs = yield* prepareProductFilesystem(state.storage, env.LEGACY_DATABASE);
    const pg = yield* Effect.acquireRelease(
      Effect.tryPromise(async () => {
        const pg = new PGlite({
          fs,
          pgliteWasmModule,
          initdbWasmModule,
          fsBundle: new Blob([pgliteData]),
          parsers: { 1082: (value) => value, 1114: (value) => value },
        });
        await pg.waitReady;
        return pg;
      }),
      (pg) => Effect.promise(() => pg.close()),
    );
    yield* completeProductBootstrap(state.storage);
    const exportDatabase = async () =>
      new Response(await pg.dumpDataDir("none"), {
        headers: { "content-type": "application/x-tar" },
      });
    if (yield* Config.Boolean("EXECUTOR_STORAGE_EXPORT").pipe(Config.withDefault(false)))
      return {
        fetch: async (_request: Request) => new Response(null, { status: 503 }),
        workflow: async (_request: Request) => new Response(null, { status: 503 }),
        exportDatabase,
      };
    const telemetry = yield* telemetryConfig("executor-selfhost");
    const common = yield* Layer.build(
      Layer.mergeAll(
        selfHostDatabaseSchema.pipe(Layer.provideMerge(PgliteClient.layer({ liveClient: pg }))),
        telemetryLayer(
          telemetry.traces === undefined && telemetry.logs === undefined
            ? {
                ...telemetry,
                traces: { url: "http://127.0.0.1:4318/v1/traces" },
                logs: { url: "http://127.0.0.1:4318/v1/logs" },
              }
            : telemetry,
        ),
        HttpServer.layerServices,
        BrowserCrypto.layer,
        Layer.succeed(ScheduleHostReady, Effect.void),
      ),
    );
    return yield* Effect.gen(function* () {
      const policy = yield* urlPolicyConfig;
      const egress = {
        policy,
        client: yield* bindingHttpClient(policy, env.PUBLIC_FETCH, env.PRIVATE_FETCH),
      };
      const blobs = bindingBlobStore(env.BLOBS);
      const directory = yield* Config.NonEmptyString("EXECUTOR_REPOSITORIES_DIR");
      const services = yield* Layer.build(
        selfHostExecutorServices(executorSkillFiles(skills), egress, () =>
          Effect.gen(function* () {
            const host = yield* bindingWorkerdApps({
              binding: env.APPS,
              authorization: "service-binding",
              blobs,
            });
            return { ...host, blobs, repositories: bindingRepositories(env.NATIVE, directory) };
          }),
        ),
      );
      const routes = yield* selfHostRouteMap({
        skills: executorSkillFiles(skills),
        egress,
        executorServices: Layer.succeedContext(services),
        dashboard: bindingDashboard(env.DASHBOARD, dashboard),
      });
      const http = yield* HttpRouter.toHttpEffect(routes).pipe(
        Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
      );
      const workflow = Context.get(services, SelfHostWorkflowRequests);
      const context = yield* Effect.context<never>();
      const addressed = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* http.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            request.modify({
              remoteAddress: Option.fromUndefinedOr(request.headers["x-executor-client-ip"]),
            }),
          ),
        );
      });
      return {
        fetch: HttpEffect.toWebHandlerWith<never, Effect.Services<typeof addressed>>(context)(
          addressed,
        ),
        workflow: HttpEffect.toWebHandlerWith<never, Effect.Services<typeof workflow>>(context)(
          workflow,
        ),
        exportDatabase,
      };
    }).pipe(Effect.provideContext(common));
  });

/** The product store has its own disk service, namespace and migration journal. */
export class ExecutorProduct extends DurableObject<Environment> implements ProductStub {
  readonly #scope = Scope.makeUnsafe();
  readonly #ready: Promise<Effect.Success<ReturnType<typeof prepare>>>;
  constructor(state: DurableObjectState, env: Environment) {
    super(state, env);
    this.#ready = state.blockConcurrencyWhile(async () => {
      try {
        const config = await Effect.runPromise(configuration(env.NATIVE));
        const product = await Effect.runPromise(
          prepare(state, env).pipe(
            Effect.provideService(Scope.Scope, this.#scope),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
            Effect.provide(FetchHttpClient.layer),
          ),
        );
        await state.storage.setAlarm(Date.now() + 30_000);
        return product;
      } catch {
        await Effect.runPromise(Scope.close(this.#scope, Exit.void));
        throw new Error(
          "Executor product storage could not open. The original PostgreSQL directory has been preserved.",
        );
      }
    });
    this.state = state;
  }
  private readonly state: DurableObjectState;
  /** Dispatch the existing authenticated product routes. */
  async fetch(request: Request): Promise<Response> {
    return (await this.#ready).fetch(request);
  }
  /** Private workflow callbacks are reached only through the named service entrypoint. */
  async workflow(request: Request): Promise<Response> {
    return (await this.#ready).workflow(request);
  }
  /** The offline export process owns the volume lock; no public socket serves this method. */
  async exportDatabase(): Promise<Response> {
    return (await this.#ready).exportDatabase();
  }
  /** Restore the background owner after a restart even when no public request arrives. */
  async alarm(): Promise<void> {
    await this.#ready;
    await this.state.storage.setAlarm(Date.now() + 30_000);
  }
}

/** Private service binding used by the workerd workflow engine. */
export class WorkflowCallbacks extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    return this.env.PRODUCT.getByName("product").workflow(request);
  }
}

/** Only the offline supervisor binds a socket to this entrypoint. */
export class ProductExport extends WorkerEntrypoint<Environment> {
  async fetch(): Promise<Response> {
    return this.env.PRODUCT.getByName("product").exportDatabase();
  }
}

/** Public traffic can only reach the product's authenticated route map. */
export default {
  fetch(request: Request, env: Environment): Promise<Response> {
    return env.PRODUCT.getByName("product").fetch(request);
  },
};
