// ---------------------------------------------------------------------------
// Metered execution stack — the HTTP executor plane's billing overlay.
//
// Cloud is the only host that meters executions, and only the HTTP `/api/*`
// executor plane does so (the MCP session DO never bills). This module is where
// the billing decorator binds to the neutral `CloudExecutionStackLayer`: it
// overrides the base stack's no-op `EngineDecorator` with one that calls
// `AutumnService.trackExecution` after each execution.
//
// Keeping this in the cloud APP layer (not the neutral `services/execution-stack.ts`)
// is the billing-boundary line: the neutral stack the DO shares names no billing
// service; the metered overlay — provided ONLY here — does.
// ---------------------------------------------------------------------------

import { Effect, Layer } from "effect";

import {
  CodeExecutorProvider,
  DbProvider,
  EngineDecorator,
  HostConfig,
  PluginsProvider,
  type EngineStackIdentity,
} from "@executor-js/api/server";

import { AutumnService } from "../services/autumn";
import type { DbService } from "../services/db";
import { CloudExecutionSeamsLayer } from "../services/execution-stack";
import { withExecutionUsageTracking } from "./execution-usage";

// Usage-metering decorator bound to the billing service. `trackExecution` is
// fire-and-forget (`Effect.runFork`) so the billing call can't stall a
// user-facing execution.
export const CloudMeteringEngineDecorator: Layer.Layer<EngineDecorator, never, AutumnService> =
  Layer.effect(EngineDecorator)(
    Effect.map(AutumnService.asEffect(), (autumn): EngineDecorator["Service"] => ({
      decorate: (engine, identity: EngineStackIdentity) =>
        withExecutionUsageTracking(identity.organizationId, engine, (organizationId) =>
          Effect.runFork(autumn.trackExecution(organizationId)),
        ),
    })),
  );

/**
 * The execution-stack seams for the metered HTTP executor plane: the four
 * billing-free `CloudExecutionSeamsLayer` seams plus the billing decorator.
 * Requires `DbService` (per-request Hyperdrive db) and `AutumnService` (usage
 * metering) from the surrounding context.
 */
export const CloudMeteredExecutionStackLayer: Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator,
  never,
  AutumnService | DbService
> = Layer.merge(CloudExecutionSeamsLayer, CloudMeteringEngineDecorator);
