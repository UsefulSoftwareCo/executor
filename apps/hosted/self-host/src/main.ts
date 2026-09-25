/** Native development entry point. Runtime-specific imports stay at this edge. */
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { readExecutorSkills } from "@executor-js/app-templates/executor";
import { ScheduleHostReady } from "@executor-js/sdk/scheduling";
import { localTelemetry } from "@executor-js/telemetry/local";
import { safeHttpClient } from "@executor-js/utils/safe-fetch/bun";
import { urlPolicyConfig, type HostEgress } from "@executor-js/utils/url-policy";
import {
  Config,
  ConfigProvider,
  Console,
  Deferred,
  Effect,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { dataDirectory } from "./contracts/config.ts";
import { selfHostConfiguration } from "./implementation/bootstrap.ts";
import { dashboardFiles } from "./implementation/web.ts";
import { selfHostRouteMap } from "./implementation/routes.ts";
import { selfHostExecutor } from "./executor.ts";
import { selfHostDatabase } from "./database.ts";

const settings = Config.all({
  host: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
  port: Config.Number("PORT").pipe(Config.withDefault(4400)),
}).pipe(
  Effect.flatMap(
    Schema.decodeUnknownEffect(
      Schema.Struct({
        host: Schema.NonEmptyString,
        port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
      }),
    ),
  ),
);

/** Compose native resources without opening a listener; used by development and HTTP tests. */
export const selfHostRoutes = Effect.gen(function* () {
  const skills = yield* readExecutorSkills;
  const policy = yield* urlPolicyConfig;
  const egress: HostEgress = { policy, client: yield* safeHttpClient(policy) };
  const executorServices = Layer.succeedContext(
    yield* Layer.build(selfHostExecutor(skills, egress)),
  );
  const path = yield* Path.Path;
  const configured = yield* Config.String("DASHBOARD_DIR").pipe(Config.option);
  const directory = Option.isSome(configured)
    ? path.resolve(configured.value)
    : yield* path.fromFileUrl(new URL("../web/dist/", import.meta.url));
  const dashboard = yield* dashboardFiles(directory);
  return yield* selfHostRouteMap({ skills, egress, executorServices, dashboard });
});

const server = Layer.unwrap(
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const routes = yield* selfHostRoutes.pipe(
      Effect.provideService(ScheduleHostReady, Deferred.await(ready)),
    );
    return HttpRouter.serve(routes, { disableLogger: true }).pipe(
      Layer.tap(() => Deferred.succeed(ready, undefined)),
      Layer.tap(() => HttpServer.addressFormattedWith((url) => Console.log(`Executor: ${url}`))),
    );
  }),
).pipe(
  Layer.provide(selfHostDatabase),
  Layer.provide(
    Layer.unwrap(
      dataDirectory.pipe(Effect.map((directory) => localTelemetry(directory, "executor-selfhost"))),
    ),
  ),
  Layer.provide(BunHttpServer.layerHttpServices),
);

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Effect.gen(function* () {
        const { host, port } = yield* settings;
        const listener = yield* Layer.build(BunHttpServer.layer({ hostname: host, port }));
        const bound = yield* HttpServer.HttpServer.pipe(Effect.provideContext(listener));
        const address = bound.address;
        if (!("port" in address)) return yield* Effect.die("Self-host requires a TCP listener");
        const base = yield* ConfigProvider.ConfigProvider;
        const overrides: Record<string, string> = { PORT: String(address.port) };
        // Port zero is a real OS allocation, not a released-port probe. Resolve local URLs
        // before auth, managed app installation, or any callback is configured.
        for (const key of ["BETTER_AUTH_URL", "EXECUTOR_OAUTH_CALLBACK_URL"]) {
          const value = yield* Config.String(key).pipe(Config.option);
          if (Option.isSome(value)) {
            const url = URL.parse(value.value);
            if (url !== null && url.port === "0") {
              url.port = String(address.port);
              overrides[key] = key === "BETTER_AUTH_URL" ? url.origin : url.href;
            }
          }
        }
        const configuration = yield* selfHostConfiguration.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown(overrides).pipe(ConfigProvider.orElse(base)),
          ),
        );
        return yield* Layer.launch(server.pipe(Layer.provide(Layer.succeedContext(listener)))).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configuration),
        );
      }),
    ).pipe(Effect.provide(BunHttpServer.layerHttpServices)),
  );
