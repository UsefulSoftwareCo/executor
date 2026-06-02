import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { Schema } from "effect";

import { ExecutorApi } from "../api";
import { type ExecuteRequest, type ResumeRequest } from "../executions/api";
import { formatExecuteResult, formatPausedExecution } from "@executor-js/execution";
import { ExecutionEngineService } from "../services";
import { capture, captureEngineError } from "@executor-js/api";

class ExecutionNotFoundError extends Schema.TaggedErrorClass<ExecutionNotFoundError>()(
  "ExecutionNotFoundError",
  {
    executionId: Schema.String,
  },
) {}

export const ExecutionsHandlers = HttpApiBuilder.group(ExecutorApi, "executions", (handlers) =>
  handlers
    .handle(
      "getPaused",
      Effect.fn("executions.getPaused")(function* (ctx: { params: { executionId: string } }) {
        return yield* capture(
          Effect.gen(function* () {
            const engine = yield* ExecutionEngineService;
            const paused = yield* captureEngineError(
              engine.getPausedExecution(ctx.params.executionId),
            );

            if (!paused) {
              return yield* new ExecutionNotFoundError({ executionId: ctx.params.executionId });
            }

            return formatPausedExecution(paused);
          }),
        );
      }),
    )
    .handle(
      "execute",
      Effect.fn("executions.execute")(function* (ctx: { payload: typeof ExecuteRequest.Type }) {
        return yield* capture(
          Effect.gen(function* () {
            const engine = yield* ExecutionEngineService;
            const outcome = yield* captureEngineError(engine.executeWithPause(ctx.payload.code));

            if (outcome.status === "completed") {
              const formatted = formatExecuteResult(outcome.result);
              return {
                status: "completed" as const,
                text: formatted.text,
                structured: formatted.structured,
                isError: formatted.isError,
              };
            }

            const formatted = formatPausedExecution(outcome.execution);
            return {
              status: "paused" as const,
              text: formatted.text,
              structured: formatted.structured,
            };
          }),
        );
      }),
    )
    .handle(
      "resume",
      Effect.fn("executions.resume")(function* (ctx: {
        params: { executionId: string };
        payload: typeof ResumeRequest.Type;
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const engine = yield* ExecutionEngineService;
            const result = yield* captureEngineError(
              engine.resume(ctx.params.executionId, {
                action: ctx.payload.action,
                content: ctx.payload.content as Record<string, unknown> | undefined,
              }),
            );

            if (!result) {
              return yield* new ExecutionNotFoundError({ executionId: ctx.params.executionId });
            }

            if (result.status === "completed") {
              const formatted = formatExecuteResult(result.result);
              return {
                status: "completed" as const,
                text: formatted.text,
                structured: formatted.structured,
                isError: formatted.isError,
              };
            }

            const formatted = formatPausedExecution(result.execution);
            return {
              status: "paused" as const,
              text: formatted.text,
              structured: formatted.structured,
            };
          }),
        );
      }),
    ),
);
