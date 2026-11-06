/** Product analytics at the shared hosted Executor boundary, used by Cloud and self-host. */
import type { Executor, ToolCallResult, ToolResumeResult } from "@executor-js/sdk/core";
import { toolCompletion } from "@executor-js/telemetry/product-analytics";
import { Clock, Effect, Exit } from "effect";
import {
  observeUsage,
  recordUsage,
  usageFailure,
  type UsageProperties,
} from "../contracts/product-analytics.ts";

/** A first-page query with no matches, excluding browsing, pagination and lost listings. */
export const observeToolSearch = <E, R>(
  input: Parameters<Executor["tools"]["search"]>[0],
  work: Effect.Effect<Effect.Success<ReturnType<Executor["tools"]["search"]>>, E, R>,
) =>
  work.pipe(
    Effect.tap((page) =>
      input.query.trim() !== "" &&
      input.offset === 0 &&
      page.items.length === 0 &&
      page.remaining === 0 &&
      page.missing.length === 0
        ? recordUsage("tool_search_empty", { result_count: 0 })
        : Effect.void,
    ),
  );

/** Instrument completed tool work while keeping approval pauses out of completion counts. */
const observeTool = <A extends ToolCallResult | ToolResumeResult, E, R>(
  properties: UsageProperties,
  work: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    yield* recordUsage("tool_execution_started", properties);
    return yield* work.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const timed = {
            ...properties,
            duration_ms: Math.max(0, (yield* Clock.currentTimeMillis) - started),
          };
          if (Exit.isFailure(exit)) {
            yield* recordUsage("tool_execution_completed", {
              ...timed,
              ...usageFailure(exit.cause),
            });
            return;
          }
          const status = exit.value.status;
          if (status !== "approval-required") {
            yield* recordUsage("tool_execution_completed", {
              ...timed,
              status,
              ...toolCompletion(exit.value),
            });
          } else {
            yield* recordUsage("tool_approval_requested", { ...timed, status });
          }
        }),
      ),
    );
  }).pipe(Effect.withSpan("product.tool.execution"));

/** Product host boundaries cover API/MCP work and private app queries without inspecting payloads. */
export const withExecutorAnalytics = (executor: Executor): Executor => ({
  ...executor,
  tools: {
    ...executor.tools,
    call: (input, options) =>
      observeTool(
        { app_id: input.app, tool_name: input.tool },
        executor.tools.call(input, options),
      ),
    resume: (input, options) =>
      observeTool({ resumed: true }, executor.tools.resume(input, options)),
  },
  appData: {
    ...executor.appData,
    query: (input) =>
      observeUsage(
        "app_query_completed",
        { app_id: input.app, operation: input.name },
        executor.appData.query(input),
      ),
    mutate: (input) =>
      observeUsage(
        "app_mutation_completed",
        { app_id: input.app, operation: input.name },
        executor.appData.mutate(input),
      ),
    subscribe: (input) =>
      observeUsage(
        "app_subscription_started",
        { app_id: input.app, operation: input.name },
        executor.appData.subscribe(input),
      ),
  },
  accountConnections: {
    ...executor.accountConnections,
    submit: (input) =>
      executor.accountConnections.submit(input).pipe(
        Effect.tap((account) =>
          recordUsage("account_connected", {
            method: "credentials",
            account_id: account.id,
            provider_id: account.provider,
          }),
        ),
      ),
    completeOAuth: (input) =>
      executor.accountConnections.completeOAuth(input).pipe(
        Effect.tap((account) =>
          recordUsage("account_connected", {
            method: "oauth",
            account_id: account.id,
            provider_id: account.provider,
          }),
        ),
      ),
  },
  apps: {
    ...executor.apps,
    deploy: (input) =>
      executor.apps.deploy(input).pipe(
        Effect.tap((result) =>
          recordUsage("app_deployed", {
            app_id: result.app.id,
            version_id: result.version.id,
          }),
        ),
      ),
  },
});
