import { Clock, Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { capture, captureEngineError } from "@executor-js/api";
import { formatExecuteResult, formatPausedExecution } from "@executor-js/execution";
import { resolveArtifactAction } from "@executor-js/host-mcp/artifact-action";
import { TOOL_CALL_CONTRACT_MESSAGE } from "@executor-js/host-mcp/tool-call-code";
import {
  CompletedExecutionReceipt,
  PENDING_APPROVAL_TTL_MS,
  PausedExecutionReceipt,
  RunningResumeReservation,
  SettledResumeReservation,
  sha256Hex,
  StorageError,
  type ExecutionIdempotencyKey,
  type ExecutionReceipt,
  type PausedExecutionReceipt as PausedReceipt,
  type RunningExecution,
} from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutionEngineService, ExecutorService } from "../services";

class ExecutionNotFoundError extends Schema.TaggedErrorClass<ExecutionNotFoundError>()(
  "ExecutionNotFoundError",
  { executionId: Schema.String },
) {}

class ExecutionInProgressError extends Schema.TaggedErrorClass<ExecutionInProgressError>()(
  "ExecutionInProgressError",
  { executionId: Schema.String },
  { httpApiStatus: 409 },
) {}

class ExecutionIdempotencyConflictError extends Schema.TaggedErrorClass<ExecutionIdempotencyConflictError>()(
  "ExecutionIdempotencyConflictError",
  { executionId: Schema.String, idempotencyKey: Schema.String },
  { httpApiStatus: 409 },
) {}

class ExecutionResumeConflictError extends Schema.TaggedErrorClass<ExecutionResumeConflictError>()(
  "ExecutionResumeConflictError",
  { executionId: Schema.String, pauseSequence: Schema.Number },
  { httpApiStatus: 409 },
) {}

class ArtifactActionError extends Schema.TaggedErrorClass<ArtifactActionError>()(
  "ArtifactActionError",
  {
    error: Schema.Literals(["invalid_action_code", "artifact_unavailable", "binding_unresolved"]),
    reason: Schema.String,
    role: Schema.optional(Schema.String),
    integration: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    return this.reason;
  }
}

class ApprovalExpiredError extends Schema.TaggedErrorClass<ApprovalExpiredError>()(
  "ApprovalExpiredError",
  { executionId: Schema.String },
  { httpApiStatus: 410 },
) {
  override get message(): string {
    return "This approval expired. Trigger the action again.";
  }
}

const jsonEncode = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const digest = (value: unknown) =>
  jsonEncode(value).pipe(
    Effect.mapError(
      (cause) =>
        new StorageError({
          message: "Execution receipt value is not JSON serializable",
          cause,
        }),
    ),
    Effect.flatMap(sha256Hex),
    Effect.map((hash) => `sha256:${hash}`),
  );

const resolveArtifactCode = (
  code: string,
  artifactId: string,
): Effect.Effect<string, ArtifactActionError, ExecutorService> =>
  Effect.gen(function* () {
    const executor = yield* ExecutorService;
    const resolution = yield* resolveArtifactAction({
      code,
      artifactId,
      loadArtifact: (id) =>
        executor.artifacts.get(id).pipe(Effect.catchCause(() => Effect.succeed(null))),
    });

    if (resolution.status === "ok") return resolution.code;
    if (resolution.status === "binding_unresolved") {
      return yield* new ArtifactActionError({
        error: "binding_unresolved",
        reason: resolution.message,
        role: resolution.role,
        integration: resolution.integration,
      });
    }
    return yield* new ArtifactActionError({
      error: resolution.status,
      reason:
        resolution.status === "artifact_unavailable"
          ? "This action refers to an artifact that isn't available on this account."
          : TOOL_CALL_CONTRACT_MESSAGE,
    });
  });

const recordPendingApproval = (approval: {
  readonly executionId: string;
  readonly artifactId: string;
  readonly code: string;
  readonly address: string;
}): Effect.Effect<void, never, ExecutorService> =>
  Effect.gen(function* () {
    const executor = yield* ExecutorService;
    yield* executor.pendingApprovals
      .put({ ...approval, expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS })
      .pipe(Effect.catchCause(() => Effect.void));
  });

const resumeFromPendingApproval = (executionId: string, action: "accept" | "decline" | "cancel") =>
  Effect.gen(function* () {
    const executor = yield* ExecutorService;
    const engine = yield* ExecutionEngineService;
    const approval = yield* executor.pendingApprovals
      .consume(executionId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (!approval) return null;

    if (action !== "accept") {
      return {
        status: "completed" as const,
        text: `Approval ${action === "decline" ? "declined" : "cancelled"}. Nothing ran.`,
        structured: {
          status: "declined",
          executionId,
          address: approval.address,
        },
        isError: false,
      };
    }

    const outcome = yield* captureEngineError(
      engine.executeWithPause(approval.code, {
        autoApprove: true,
        executionId,
      }),
    );
    if (outcome.status === "completed") {
      const formatted = formatExecuteResult(outcome.result);
      return { status: "completed" as const, ...formatted };
    }
    const formatted = formatPausedExecution(outcome.execution);
    return { status: "paused" as const, ...formatted };
  });

const completedReceipt = (
  execution: RunningExecution | PausedReceipt,
  formatted: {
    readonly text: string;
    readonly structured: unknown;
    readonly isError: boolean;
  },
) =>
  Effect.gen(function* () {
    const resultHash = yield* digest(formatted);
    const completedAt = yield* Clock.currentTimeMillis;
    return CompletedExecutionReceipt.make({
      executionId: execution.executionId,
      idempotencyKey: execution.idempotencyKey,
      requestHash: execution.requestHash,
      startedAt: execution.startedAt,
      status: "completed",
      ...formatted,
      resultHash,
      completedAt,
    });
  });

const pausedReceipt = (
  execution: RunningExecution | PausedReceipt,
  formatted: { readonly text: string; readonly structured: unknown },
  pauseSequence: number,
) => {
  const structured =
    typeof formatted.structured === "object" &&
    formatted.structured !== null &&
    !Array.isArray(formatted.structured)
      ? { ...formatted.structured, pauseSequence }
      : formatted.structured;
  return PausedExecutionReceipt.make({
    executionId: execution.executionId,
    idempotencyKey: execution.idempotencyKey,
    requestHash: execution.requestHash,
    startedAt: execution.startedAt,
    status: "paused",
    text: formatted.text,
    structured,
    pauseSequence,
  });
};

const replayOrConflict = (
  execution: RunningExecution | ExecutionReceipt,
  idempotencyKey: ExecutionIdempotencyKey,
  requestHash: string,
) => {
  if (execution.idempotencyKey !== idempotencyKey || execution.requestHash !== requestHash) {
    return Effect.fail(
      new ExecutionIdempotencyConflictError({
        executionId: execution.executionId,
        idempotencyKey,
      }),
    );
  }
  if (execution.status === "running") {
    return Effect.fail(new ExecutionInProgressError({ executionId: execution.executionId }));
  }
  return Effect.succeed(execution);
};

export const ExecutionsHandlers = HttpApiBuilder.group(ExecutorApi, "executions", (handlers) =>
  handlers
    .handle("get", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const execution = yield* executor.executionReceipts.get(path.executionId);
          if (execution === null) {
            return yield* new ExecutionNotFoundError({
              executionId: path.executionId,
            });
          }
          if (execution.status === "running") {
            return yield* new ExecutionInProgressError({
              executionId: path.executionId,
            });
          }
          if (execution.status === "paused") {
            const resume = yield* executor.executionReceipts.getResume(
              execution.executionId,
              execution.pauseSequence,
            );
            if (resume?.status === "running") {
              return yield* new ExecutionInProgressError({
                executionId: path.executionId,
              });
            }
          }
          return execution;
        }),
      ),
    )
    .handle("execute", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const engine = yield* ExecutionEngineService;
          const code =
            payload.artifactId === undefined
              ? payload.code
              : yield* resolveArtifactCode(payload.code, payload.artifactId);
          const requestHash = yield* digest({
            code: payload.code,
            autoApprove: payload.autoApprove,
            artifactId: payload.artifactId,
          });
          const startedAt = yield* Clock.currentTimeMillis;
          const reservation = yield* executor.executionReceipts.reserve({
            idempotencyKey: payload.idempotencyKey,
            requestHash,
            startedAt,
          });
          if (!reservation.created) {
            return yield* replayOrConflict(
              reservation.execution,
              payload.idempotencyKey,
              requestHash,
            );
          }

          const outcome = yield* captureEngineError(
            engine.executeWithPause(code, {
              autoApprove: payload.autoApprove,
              executionId: reservation.execution.executionId,
            }),
          );
          if (outcome.status === "completed") {
            const receipt = yield* completedReceipt(
              reservation.execution,
              formatExecuteResult(outcome.result),
            );
            yield* executor.executionReceipts.put(receipt);
            return receipt;
          }

          if (payload.artifactId !== undefined) {
            yield* recordPendingApproval({
              executionId: outcome.execution.id,
              artifactId: payload.artifactId,
              code,
              address: String(outcome.execution.elicitationContext.address),
            });
          }
          const receipt = pausedReceipt(
            reservation.execution,
            formatPausedExecution(outcome.execution),
            0,
          );
          yield* executor.executionReceipts.put(receipt);
          return receipt;
        }),
      ),
    )
    .handle("resume", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const engine = yield* ExecutionEngineService;
          const execution = yield* executor.executionReceipts.get(path.executionId);
          if (execution === null) {
            return yield* new ExecutionNotFoundError({
              executionId: path.executionId,
            });
          }
          if (execution.status === "running") {
            return yield* new ExecutionInProgressError({
              executionId: path.executionId,
            });
          }

          const requestHash = yield* digest({
            action: payload.action,
            content: payload.content,
          });
          const prior = yield* executor.executionReceipts.getResume(
            path.executionId,
            payload.pauseSequence,
          );
          if (prior !== null) {
            if (
              prior.idempotencyKey !== payload.idempotencyKey ||
              prior.requestHash !== requestHash
            ) {
              return yield* new ExecutionResumeConflictError({
                executionId: path.executionId,
                pauseSequence: payload.pauseSequence,
              });
            }
            if (prior.status === "settled") return prior.response;
            if (
              execution.status === "completed" ||
              (execution.status === "paused" && execution.pauseSequence > payload.pauseSequence)
            ) {
              const settled = SettledResumeReservation.make({
                ...prior,
                status: "settled",
                response: execution,
                completedAt: yield* Clock.currentTimeMillis,
              });
              yield* executor.executionReceipts.settleResume(settled);
              return execution;
            }
            return yield* new ExecutionInProgressError({
              executionId: path.executionId,
            });
          }

          if (execution.status === "completed") return execution;
          if (execution.pauseSequence !== payload.pauseSequence) {
            return yield* new ExecutionResumeConflictError({
              executionId: path.executionId,
              pauseSequence: payload.pauseSequence,
            });
          }

          const resumeStartedAt = yield* Clock.currentTimeMillis;
          const reservation = RunningResumeReservation.make({
            status: "running",
            executionId: path.executionId,
            pauseSequence: payload.pauseSequence,
            idempotencyKey: payload.idempotencyKey,
            requestHash,
            startedAt: resumeStartedAt,
          });
          const reserved = yield* executor.executionReceipts.reserveResume(reservation);
          if (!reserved.created) {
            if (
              reserved.reservation.idempotencyKey !== payload.idempotencyKey ||
              reserved.reservation.requestHash !== requestHash
            ) {
              return yield* new ExecutionResumeConflictError({
                executionId: path.executionId,
                pauseSequence: payload.pauseSequence,
              });
            }
            if (reserved.reservation.status === "settled") return reserved.reservation.response;
            return yield* new ExecutionInProgressError({
              executionId: path.executionId,
            });
          }

          const result = yield* captureEngineError(
            engine.resume(path.executionId, {
              action: payload.action,
              content: payload.content,
            }),
          );
          const recovered =
            result ?? (yield* resumeFromPendingApproval(path.executionId, payload.action));
          if (!recovered) {
            yield* executor.executionReceipts.discardResume(
              path.executionId,
              payload.pauseSequence,
            );
            return yield* new ApprovalExpiredError({
              executionId: path.executionId,
            });
          }

          const response =
            recovered.status === "completed"
              ? yield* completedReceipt(
                  execution,
                  "result" in recovered
                    ? formatExecuteResult(recovered.result)
                    : {
                        text: recovered.text,
                        structured: recovered.structured,
                        isError: recovered.isError,
                      },
                )
              : pausedReceipt(
                  execution,
                  "execution" in recovered
                    ? formatPausedExecution(recovered.execution)
                    : {
                        text: recovered.text,
                        structured: recovered.structured,
                      },
                  execution.pauseSequence + 1,
                );
          yield* executor.executionReceipts.put(response);
          yield* executor.executionReceipts.settleResume(
            SettledResumeReservation.make({
              ...reservation,
              status: "settled",
              response,
              completedAt: yield* Clock.currentTimeMillis,
            }),
          );
          return response;
        }),
      ),
    ),
);
