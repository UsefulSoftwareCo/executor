import { hostedAppCapabilities } from "@executor-js/hosted-server/app-management";
import { AppManagementHost } from "@executor-js/app-management";
import { createAppRegistry, makeRegistryStorage, storedRegistry } from "@executor-js/app-registry";
/** Cloud composition: Postgres is authoritative; no organization data is stored in a DO. */
import { urlPolicyConfig, type HostEgress } from "@executor-js/utils/url-policy";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { PgClient } from "@effect/sql-pg";
import {
  HostedExecutor,
  ScheduledAuthority,
  makeScheduledAuthority,
  OrganizationIcons,
  makeOrganizationIcons,
  OrganizationDefaults,
} from "@executor-js/hosted-server";
import { GroupDatabase, GroupsUnavailable } from "@executor-js/hosted-server/groups";
import { postgresExecutor } from "@executor-js/hosted-server/database";
import { HostedAppRuntime } from "@executor-js/hosted-server/app-ui";
import { StorageError, BlobStore, makeExecutorStorage } from "@executor-js/sdk/core";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Context, Effect, Layer, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { cloudBuildAsset } from "../implementation/build-storage.ts";
import { cachedBuildAssets } from "../implementation/asset-cache.ts";
import { withExecutorAnalytics } from "../implementation/product-analytics.ts";
import { cloudAppSources } from "./source.ts";
import { cloudBlobs } from "./blobs.ts";
import { cloudWorkflows } from "./workflows.ts";
import { cloudRuntime } from "./runtime.ts";
import { DatabaseConnection } from "./database.ts";
import { cloudSecrets } from "./secrets.ts";
import { cloudOrigin } from "./stage.ts";
import type { AppDataSupervisor } from "./app-data.ts";

/**
 * Cloudflare offers no connect hook for global fetch, so this host cannot re-check a resolved
 * address. `global_fetch_strictly_public` on the app isolates and `parseDestination` on every
 * host-side fetch are the controls here.
 */
export const cloudEgress = Effect.gen(function* () {
  const policy = yield* urlPolicyConfig;
  const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
  return { policy, client } satisfies HostEgress;
});

/**
 * Alchemy owns one concrete Effect SQL client per invocation, closed with that invocation.
 * Its SQL.PostgresLayer currently returns a lazy proxy: FumaDB's synchronous Statement.join
 * cannot inspect those deferred fragments. Resolve the native client before composing ORM
 * queries, using Alchemy's execution memo rather than an isolate-global pool.
 */
export const cloudExecutor = Effect.fn(function* (
  databases: Cloudflare.DurableObject<AppDataSupervisor>,
) {
  // Resolve during initialization so Alchemy binds every value into the Worker environment.
  const secrets = yield* cloudSecrets.pipe(Effect.orDie);
  const origin = yield* cloudOrigin.pipe(Effect.orDie);
  const egress = yield* cloudEgress;
  const clientMetadataUrl = yield* Config.String("EXECUTOR_OAUTH_CLIENT_METADATA_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  );
  const connection = yield* Cloudflare.Hyperdrive.Connect(yield* DatabaseConnection);
  const makeRuntime = yield* cloudRuntime(databases);
  const workflows = yield* cloudWorkflows;
  const blobs = yield* cloudBlobs;
  const assets = yield* makeExecutionMemo(
    cachedBuildAssets(origin, (build, path) =>
      cloudBuildAsset(build, path).pipe(Effect.provideService(BlobStore, blobs)),
    ),
  );
  const { sources, repositories } = yield* cloudAppSources;
  // App storage and hosted permission checks use the same database. Share its
  // client only inside this execution; the event scope owns all connections.
  const database = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const url = yield* connection.connectionString;
      return yield* Layer.build(PgClient.layer({ url, maxConnections: 1, prepare: false }));
    }).pipe(Effect.withSpan("runtime.cloud.database.initialize")),
  );
  const executor = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const key = yield* secrets.encryptionKey;
      const services = yield* database;
      const storage = yield* makeExecutorStorage({ provider: "postgresql" }).pipe(
        Effect.provideContext(services),
      );
      const registryStorage = yield* makeRegistryStorage.pipe(Effect.provideContext(services));
      const registry = storedRegistry(registryStorage, sources, origin);
      const runtime = yield* makeRuntime;
      const executor = yield* postgresExecutor(
        key,
        runtime,
        blobs,
        sources,
        {
          httpClient: egress.client,
          urlPolicy: egress.policy,
          ...(clientMetadataUrl === undefined ? {} : { clientMetadataUrl }),
        },
        { storage, webhookOrigin: origin, workflows },
      ).pipe(Effect.provideContext(services), Effect.provide(BrowserCrypto.layer));
      const scheduleAuthority = yield* makeScheduledAuthority(executor).pipe(
        Effect.provideContext(services),
      );
      return {
        executor,
        storage,
        scheduleAuthority,
        management: {
          executor,
          sources,
          repositories,
          registry,
          blobs,
          publisher: createAppRegistry({ storage: registryStorage, executor, sources }),
          access: yield* hostedAppCapabilities.pipe(Effect.provideContext(services)),
        },
      };
    }).pipe(
      Effect.mapError(() => new StorageError()),
      Effect.withSpan("runtime.cloud.executor.initialize"),
    ),
  );
  // Serving an app does not install the default management app. Keep its API
  // document, templates and authoring files off the app-serving startup path.
  const defaults = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const { defaultApp } = yield* Effect.promise(
        () => import("../implementation/default-app.ts"),
      );
      const resources = yield* executor;
      return yield* defaultApp(resources.executor, origin, resources.storage).pipe(
        Effect.provideContext(yield* database),
      );
    }).pipe(
      Effect.mapError(() => new StorageError()),
      Effect.withSpan("runtime.cloud.defaults.initialize"),
    ),
  );
  // Alchemy's runtime requirement marks event-only operations; it is not a
  // service supplied to request fibers. Keep the live caller scope and tracer.
  return Layer.mergeAll(
    Layer.succeed(
      GroupDatabase,
      database.pipe(
        Effect.map((services) => Context.get(services, SqlClient.SqlClient)),
        Effect.provide(RuntimeContext.phantom),
        Effect.mapError(() => new GroupsUnavailable()),
      ),
    ),
    Layer.succeed(ScheduledAuthority, (target) =>
      executor.pipe(
        Effect.flatMap((resources) => resources.scheduleAuthority(target)),
        Effect.provide(RuntimeContext.phantom),
      ),
    ),
    Layer.succeed(OrganizationIcons, makeOrganizationIcons(blobs)),
    Layer.succeed(HostedAppRuntime, {
      asset: ({ build, path }) =>
        assets.pipe(
          Effect.flatMap((read) => read(build, path)),
          Effect.provide(RuntimeContext.phantom),
        ),
    }),
    Layer.succeed(
      AppManagementHost,
      executor.pipe(
        Effect.map((resources) => ({
          ...resources.management,
          executor: withExecutorAnalytics(resources.management.executor),
        })),
        Effect.provide(RuntimeContext.phantom),
      ),
    ),
    Layer.succeed(
      HostedExecutor,
      executor.pipe(
        Effect.map((resources) => withExecutorAnalytics(resources.executor)),
        Effect.provide(RuntimeContext.phantom),
      ),
    ),
    Layer.succeed(
      OrganizationDefaults,
      OrganizationDefaults.of((organization, user) =>
        defaults.pipe(
          Effect.flatMap((initialize) => initialize(organization, user)),
          Effect.provide(RuntimeContext.phantom),
        ),
      ),
    ),
  );
}, Effect.provide(Cloudflare.Hyperdrive.ConnectBinding));
