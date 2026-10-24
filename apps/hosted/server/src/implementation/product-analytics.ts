/** Product analytics at the shared hosted Executor boundary, used by Cloud and self-host. */
import type { Executor, ToolCallResult, ToolResumeResult } from "@executor-js/sdk/core";
import { toolCompletion } from "@executor-js/telemetry/product-analytics";
import { Clock, Effect, Exit, Option } from "effect";
import {
  observeUsage,
  recordUsage,
  usageFailure,
  type UsageProperties,
} from "../contracts/product-analytics.ts";

/** Instrument completed tool work while keeping approval pauses out of completion counts. */
const observeTool = <A extends ToolCallResult | ToolResumeResult, E, R>(
  properties: UsageProperties,
  work: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const { app_id: _requestedAppId, ...requestedProperties } = properties;
    // Before the SDK call resolves, `app` is still caller input.
    yield* recordUsage("tool_execution_started", requestedProperties);
    return yield* work.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const timed = {
            ...requestedProperties,
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
          // A pending invocation carries the SDK-resolved ID; a completed call proves the SDK
          // resolved the requested ID from stored app state before dispatching the tool.
          const appId =
            status === "approval-required" ? exit.value.invocation.app : properties.app_id;
          const attributed = appId === undefined ? timed : { ...timed, app_id: appId };
          if (status !== "approval-required") {
            yield* recordUsage("tool_execution_completed", {
              ...attributed,
              status,
              ...toolCompletion(exit.value),
            });
          } else {
            yield* recordUsage("tool_approval_requested", { ...attributed, status });
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
      Effect.gen(function* () {
        // Resume input carries only a request ID. Read the stored SDK invocation so the relay
        // gets the authoritative app identity, without trusting request-local caller metadata.
        const approval = yield* executor.tools
          .approval({
            requestId: input.requestId,
            ...(input.owner === undefined ? {} : { owner: input.owner }),
          })
          .pipe(Effect.option);
        return yield* observeTool(
          {
            resumed: true,
            ...(Option.isSome(approval) ? { app_id: approval.value.invocation.app } : {}),
          },
          executor.tools.resume(input, options),
        );
      }),
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
