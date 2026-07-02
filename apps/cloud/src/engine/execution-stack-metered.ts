// ---------------------------------------------------------------------------
// Metered execution stack: cloud's billing overlay over the execution seams.
//
// Cloud is the only host that meters executions, and BOTH of its execution
// planes do so: the HTTP `/api/*` executor plane (api/protected.ts) and the MCP
// session Durable Object (mcp/session-durable-object.ts). This module composes
// the four billing-free `CloudExecutionSeamsLayer` seams with an `EngineDecorator`
// that calls `AutumnService.trackExecution` after each execution.
//
// Keeping this in the cloud APP layer (not the neutral `engine/execution-stack.ts`)
// is the billing-boundary line: the seams module names no billing service; the
// metered overlay, provided ONLY here, does. Both planes import THIS layer and
// supply `AutumnService` from their own context (boot for the HTTP plane,
// `AutumnService.Default` locally for the DO).
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

import { AutumnService } from "../extensions/billing/service";
import type { DbService } from "../db/db";
import { CloudExecutionSeamsLayer } from "../engine/execution-stack";
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
 * The metered execution stack used by BOTH cloud planes (HTTP executor plane and
 * MCP session DO): the four billing-free `CloudExecutionSeamsLayer` seams plus
 * the billing decorator. Requires `DbService` (per-request Hyperdrive db) and
 * `AutumnService` (usage metering) from the surrounding context.
 */
export const CloudMeteredExecutionStackLayer: Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator,
  never,
  AutumnService | DbService
> = Layer.merge(CloudExecutionSeamsLayer, CloudMeteringEngineDecorator);
