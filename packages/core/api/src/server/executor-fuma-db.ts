// ---------------------------------------------------------------------------
// The DbProvider seam — host-composition over the shared FumaDB assembly.
//
// `DbProvider` is the Effect seam P3's `makeScopedExecutor` reads the handle
// from. Each app provides a Layer wrapping its existing connection +
// schema-ensure strategy; the handle shape is uniform (`{ db, fuma, close }`)
// while the bring-up impl stays per-provider.
//
// The pure assembly (`createExecutorFumaDb` + its types) lives in the SDK
// because the SDK's own sqlite test backend shares it; it is re-exported from
// `@executor-js/api/server` so hosts import the assembly AND the seam from one
// host surface. This module owns only the host-composition seam.
// ---------------------------------------------------------------------------

import { Context, Effect, Layer } from "effect";

import type { ExecutorDbHandle } from "@executor-js/sdk/host-internal";

// Re-export the pure FumaDB assembly + its types from the SDK so hosts get the
// whole DB surface from one place (`@executor-js/api/server`).
export {
  createExecutorFumaDb,
  type CreateExecutorFumaDbOptions,
  type ExecutorDbHandle,
  type ExecutorDbProvider,
  type ExecutorFumaDb,
  type ExecutorFumaSchema,
} from "@executor-js/sdk/host-internal";

/**
 * The injection point for the executor's FumaDB handle. P3's
 * `makeScopedExecutor` reads `db` from here. Each app supplies a Layer wrapping
 * its existing driver-open + schema-ensure; the bring-up strategy stays
 * per-provider.
 */
export class DbProvider extends Context.Service<DbProvider, ExecutorDbHandle>()(
  "@executor-js/sdk/DbProvider",
) {}

/**
 * Build a scoped `DbProvider` Layer from an acquire that opens the host's
 * driver and assembles the handle (typically by calling `createExecutorFumaDb`
 * after its own driver-open + schema bring-up). The handle's `close` runs on
 * scope teardown.
 */
export const dbProviderLayer = (
  acquire: Effect.Effect<ExecutorDbHandle>,
): Layer.Layer<DbProvider> =>
  Layer.effect(DbProvider)(
    Effect.acquireRelease(acquire, (handle) => Effect.promise(() => handle.close())),
  );
