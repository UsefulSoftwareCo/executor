// ---------------------------------------------------------------------------
// Shared execution stack — the wiring that turns an organization into a
// runnable executor + engine. Used by the protected HTTP API (per-request)
// and the MCP session DO (per-session) so changes to the stack flow to both.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Effect } from "effect";

import { createExecutionEngine } from "@executor-js/execution";
import { makeDynamicWorkerExecutor } from "@executor-js/runtime-dynamic-worker";

import { withExecutionUsageTracking } from "../api/execution-usage";
import { AutumnService } from "./autumn";
import { createCloudPlugins, createScopedExecutor } from "./executor";

export const makeExecutionStack = (
  userId: string,
  organizationId: string,
  organizationName: string,
) =>
  Effect.gen(function* () {
    const plugins = createCloudPlugins();
    const executor = yield* createScopedExecutor(
      userId,
      organizationId,
      organizationName,
      plugins,
    ).pipe(Effect.withSpan("McpSessionDO.createScopedExecutor"));
    const codeExecutor = makeDynamicWorkerExecutor({ loader: env.LOADER });
    const autumn = yield* AutumnService;
    const engine = withExecutionUsageTracking(
      organizationId,
      createExecutionEngine({ executor, codeExecutor }),
      (orgId) => Effect.runFork(autumn.trackExecution(orgId)),
    );
    return { executor, engine, plugins };
  }).pipe(Effect.withSpan("McpSessionDO.makeExecutionStack"));
