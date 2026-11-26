import { Digest } from "effect/crypto";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { DurableObjectState, Fetcher } from "@cloudflare/workers-types";
import { PGlite } from "@electric-sql/pglite";
import { PgliteClient } from "@effect/sql-pglite";
import { executorSkillFiles } from "@executor-js/app-templates/executor";
import { bindingWorkerdApps } from "@executor-js/sdk/workerd";
import { ScheduleHostReady } from "@executor-js/sdk/scheduling";
import { telemetryConfig, telemetryLayer } from "@executor-js/telemetry";
import { CurrentTelemetryClient } from "@executor-js/telemetry/transport";
import { urlPolicyConfig } from "@executor-js/utils/url-policy";
import {
  Cause,
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
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
} from "effect/http";
import { FirstPartyOAuthClientsInvalid } from "@executor-js/hosted-server";
import { selfHostDatabaseSchema } from "./implementation/database-schema.ts";
import {
  selfHostExecutorServices,
  SelfHostWorkflowRequests,
} from "./implementation/executor-services.ts";
import { selfHostRouteMap } from "./implementation/routes.ts";
import { UpdateCheckNotRecorded } from "./implementation/update-check.ts";
import { SelfHostSettingInvalid } from "./contracts/config.ts";
import {
  bindingBlobStore,
  bindingDashboard,
  bindingHttpClient,
  bindingRepositories,
  bindingTelemetryClient,
  collectorOrigin,
  type HttpBinding,
} from "./implementation/workerd/bindings.ts";
import {
  prepareProductFilesystem,
  completeProductBootstrap,
} from "./implementation/workerd/storage-migration.ts";
import { endsWithRequest } from "./implementation/workerd/request-lifetime.ts";
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
  readonly COLLECTOR: HttpBinding;
  readonly SELF: HttpBinding;
  readonly APPS: Fetcher;
}

class HostConfigurationUnavailable extends Schema.TaggedError<HostConfigurationUnavailable>()(
  "HostConfigurationUnavailable",
  { status: Schema.optionalKey(Schema.Int), cause: Schema.optionalKey(Schema.Defect()) },
) {}

const configuration = (native: HttpBinding) =>
  Effect.tryPromise({
    try: () => native.fetch(new Request("http://native.internal/configuration")),
    catch: (cause) => new HostConfigurationUnavailable({ cause }),
  }).pipe(
    Effect.filterOrFail(
      (response) => response.ok,
      (response) => new HostConfigurationUnavailable({ status: response.status }),
    ),
    Effect.flatMap((response) =>
      Effect.tryPromise(() => response.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))),
        Effect.mapError(() => new HostConfigurationUnavailable({})),
      ),
    ),
  );

const updateCheckKey = "update-check";

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
        telemetry.traces === undefined && telemetry.logs === undefined
          ? telemetryLayer({
              ...telemetry,
              traces: { url: `${collectorOrigin}/v1/traces` },
              logs: { url: `${collectorOrigin}/v1/logs` },
            }).pipe(
              Layer.provideMerge(
                Layer.effect(CurrentTelemetryClient, bindingTelemetryClient(env.COLLECTOR)),
              ),
            )
          : telemetryLayer(telemetry),
        HttpServer.layerServices,
        Digest.layerWebCrypto,
        Layer.succeed(ScheduleHostReady, Effect.void),
      ),
    );
    return yield* Effect.gen(function* () {
      const policy = yield* urlPolicyConfig;
      const egress = {
        policy,
        client: yield* bindingHttpClient(policy, env.PUBLIC_FETCH, env.PRIVATE_FETCH, {
          origin: yield* Config.String("BETTER_AUTH_URL"),
          binding: env.SELF,
        }),
      };
      const blobs = bindingBlobStore(env.BLOBS);
      const directory = yield* Config.NonEmptyString("EXECUTOR_REPOSITORIES_DIR");
      const services = yield* Layer.build(
        selfHostExecutorServices(egress, () =>
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
        updateCheckStore: {
          location: `the product's storage under the data volume's product directory, key "${updateCheckKey}"`,
          read: Effect.promise(() => state.storage.get<string>(updateCheckKey)).pipe(
            Effect.map(Option.fromUndefinedOr),
          ),
          write: (value) =>
            Effect.tryPromise({
              try: () => state.storage.put(updateCheckKey, value),
              catch: (error) =>
                new UpdateCheckNotRecorded({
                  reason: error instanceof Error ? error.message : String(error),
                }),
            }),
        },
      });
      const http = yield* HttpRouter.toHttpEffect(routes).pipe(
        Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
      );
      const workflow = Context.get(services, SelfHostWorkflowRequests);
      const context = yield* Effect.context<never>();
      const addressed = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const response = yield* http.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            request.modify({
              remoteAddress: Option.fromUndefinedOr(request.headers["x-executor-client-ip"]),
            }),
          ),
        );
        return endsWithRequest(request, response);
      });
      return {
        fetch: HttpEffect.toWebHandlerWith<never, Effect.Services<typeof addressed>>(
          Context.add(context, HttpMiddleware.TracerDisabledWhen, isHostProbe),
        )(addressed),
        workflow: HttpEffect.toWebHandlerWith<never, Effect.Services<typeof workflow>>(context)(
          workflow,
        ),
        exportDatabase,
      };
    }).pipe(Effect.provideContext(common));
  });

const hostProbeHeader = "x-executor-host-probe";
const isHostProbe = (request: HttpServerRequest.HttpServerRequest) =>
  request.url === "/health" && request.headers[hostProbeHeader] === "1";

export class ExecutorProduct extends DurableObject<Environment> implements ProductStub {
  readonly #state: DurableObjectState;
  readonly #env: Environment;
  #opening: Promise<Effect.Success<ReturnType<typeof prepare>>> | undefined;
  constructor(state: DurableObjectState, env: Environment) {
    super(state, env);
    this.#state = state;
    this.#env = env;
    this.#product().catch(() => undefined);
  }
  #product() {
    this.#opening ??= this.#open().catch((error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    return this.#opening;
  }
  async #open() {
    const scope = Scope.makeUnsafe();
    let settings: string | undefined;
    let failure: unknown;
    try {
      const config = await Effect.runPromise(configuration(this.#env.NATIVE));
      const opened = await Effect.runPromiseExit(
        prepare(this.#state, this.#env).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
          Effect.provide(FetchHttpClient.layer),
        ),
      );
      if (Exit.isSuccess(opened)) {
        await this.#state.storage.setAlarm(Date.now() + 30_000);
        return opened.value;
      }
      const squashed = Cause.squash(opened.cause);
      if (
        Schema.is(FirstPartyOAuthClientsInvalid)(squashed) ||
        Schema.is(SelfHostSettingInvalid)(squashed)
      )
        settings = squashed.message;
      failure = opened.cause;
    } catch (error) {
      failure = error;
    }
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw new Error(
      settings ??
        "Executor product storage could not open. The original PostgreSQL directory has been preserved.",
      { cause: failure },
    );
  }
  async fetch(request: Request): Promise<Response> {
    return (await this.#product()).fetch(request);
  }
  async workflow(request: Request): Promise<Response> {
    return (await this.#product()).workflow(request);
  }
  async exportDatabase(): Promise<Response> {
    return (await this.#product()).exportDatabase();
  }
  async alarm(): Promise<void> {
    await this.#product();
    await this.#state.storage.setAlarm(Date.now() + 30_000);
  }
}

export class WorkflowCallbacks extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    return this.env.PRODUCT.getByName("product").workflow(request);
  }
}

export class SelfOrigin extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    const internal = new Request(request);
    internal.headers.set("x-executor-client-ip", "127.0.0.1");
    internal.headers.delete(hostProbeHeader);
    return this.env.PRODUCT.getByName("product").fetch(internal);
  }
}

export class ProductExport extends WorkerEntrypoint<Environment> {
  async fetch(): Promise<Response> {
    return this.env.PRODUCT.getByName("product").exportDatabase();
  }
}

export default {
  fetch(request: Request, env: Environment): Promise<Response> {
    return env.PRODUCT.getByName("product").fetch(request);
  },
};
