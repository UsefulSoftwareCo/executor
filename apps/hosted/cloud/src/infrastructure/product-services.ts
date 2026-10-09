/** The executor and the services every cloud Worker shares, including app pages. */
import {
  HostedExecutor,
  withDeploySetupWake,
  withExecutorAnalytics,
} from "@executor-js/hosted-server";
import { GroupDatabase, GroupsUnavailable } from "@executor-js/hosted-server/groups";
import { HostedAppRuntime } from "@executor-js/hosted-server/app-ui";
import { BlobStore } from "@executor-js/sdk/core";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { RuntimeContext } from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { cloudBuildAsset } from "../implementation/build-storage.ts";
import { cachedBuildAssets } from "../implementation/asset-cache.ts";
import { cloudBlobs } from "./blobs.ts";
import { cloudExecutor } from "./executor.ts";
import type { AppSources } from "./source.ts";
import { cloudOrigin } from "./stage.ts";
import type { AppDataSupervisor } from "./app-data.ts";

/**
 * The executor, its per-event SQL client and the services every cloud Worker serves from them.
 * App pages compose only this; `product.ts` adds management, provisioning and source services.
 */
export const cloudProductServices = Effect.fn(function* (
  databases: Cloudflare.DurableObject<AppDataSupervisor>,
  sources: AppSources,
) {
  const origin = yield* cloudOrigin.pipe(Effect.orDie);
  const blobs = yield* cloudBlobs;
  const { executor, database } = yield* cloudExecutor(databases, sources);
  const assets = yield* makeExecutionMemo(
    cachedBuildAssets(origin, (build, path) =>
      cloudBuildAsset(build, path).pipe(Effect.provideService(BlobStore, blobs)),
    ),
  );
  // Alchemy's runtime requirement marks event-only operations; it is not a
  // service supplied to request fibers. Keep the live caller scope and tracer.
  const sdk = executor.pipe(Effect.provide(RuntimeContext.phantom));
  const sql = database.pipe(
    Effect.map((services) => Context.get(services, SqlClient.SqlClient)),
    Effect.provide(RuntimeContext.phantom),
  );
  // Product checks run on the event's connection, beside the executor's own reads.
  const withDatabase = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    database.pipe(
      Effect.flatMap((services) => work.pipe(Effect.provideContext(services))),
      Effect.provide(RuntimeContext.phantom),
    );
  const services = Layer.mergeAll(
    Layer.succeed(
      HostedExecutor,
      sdk.pipe(Effect.map((executor) => withDeploySetupWake(withExecutorAnalytics(executor)))),
    ),
    Layer.succeed(GroupDatabase, sql.pipe(Effect.mapError(() => new GroupsUnavailable()))),
    Layer.succeed(HostedAppRuntime, {
      asset: ({ build, path }) =>
        assets.pipe(
          Effect.flatMap((read) => read(build, path)),
          Effect.provide(RuntimeContext.phantom),
        ),
    }),
  );
  return { origin, blobs, sdk, sql, withDatabase, services };
});
