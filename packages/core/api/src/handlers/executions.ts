import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect, Option } from "effect";
import { Schema } from "effect";

import { ExecutorApi } from "../api";
import {
  formatExecuteResult,
  formatPausedExecution,
  type ExecutionResult,
} from "@executor-js/execution";
import { resolveArtifactAction } from "@executor-js/host-mcp/artifact-action";
import { TOOL_CALL_CONTRACT_MESSAGE } from "@executor-js/host-mcp/tool-call-code";
import {
  PENDING_APPROVAL_TTL_MS,
  type DelegationBinding,
  type PendingApprovalRecord as PendingApproval,
} from "@executor-js/sdk";
import { DelegatedExecutionResumer, ExecutionEngineService, ExecutorService } from "../services";
import { AuthContext } from "../server/identity";
import { capture, captureEngineError } from "@executor-js/api";

class ExecutionNotFoundError extends Schema.TaggedErrorClass<ExecutionNotFoundError>()(
  "ExecutionNotFoundError",
  {
    executionId: Schema.String,
  },
) {}

/**
 * An artifact-originated execution that could not be resolved into a call.
 *
 * Carries the same vocabulary the MCP host's `execute-action` returns
 * (`invalid_action_code`, `artifact_unavailable`, `binding_unresolved`) so the
 * shell sees one contract whichever transport it reached the server through,
 * and the binding UI that ships with sharing can key off `role`/`integration`.
 */
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

/**
 * An approval that expired before the human answered.
 *
 * Distinct from `ExecutionNotFoundError` (an id that was never ours) so the
 * shell can tell the user their approval window closed and the action can simply
 * be triggered again — nothing ran. 410 Gone, because the resource existed and
 * deliberately no longer does.
 */
class ApprovalExpiredError extends Schema.TaggedErrorClass<ApprovalExpiredError>()(
  "ApprovalExpiredError",
  {
    executionId: Schema.String,
  },
  { httpApiStatus: 410 },
) {
  override get message(): string {
    return "This approval expired. Trigger the action again.";
  }
}

/**
 * Parse and bind one artifact-originated call, or fail with something the shell
 * can render inside the component that made it.
 *
 * The artifact is read through the request's own scoped executor, so an id that
 * isn't this caller's simply doesn't resolve.
 */
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

/**
 * Record a paused artifact call so a later request can honour the approval.
 *
 * Best-effort by design: the in-memory pause is still live and still the fast
 * path, so a storage hiccup here must not turn a working approval into a failed
 * execution. It degrades to exactly the behaviour we had before this record
 * existed.
 */
const recordPendingApproval = (approval: {
  readonly executionId: string;
  readonly artifactId: string;
  readonly code: string;
  readonly address: string;
  readonly delegationBinding?: DelegationBinding;
}): Effect.Effect<void, never, ExecutorService> =>
  Effect.gen(function* () {
    const executor = yield* ExecutorService;
    yield* executor.pendingApprovals
      .put({
        ...approval,
        expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
        ...(approval.delegationBinding === undefined
          ? {}
          : { delegationBinding: approval.delegationBinding }),
      })
      .pipe(Effect.catchCause(() => Effect.void));
  });

const sameDelegationBinding = (left: DelegationBinding, right: DelegationBinding): boolean =>
  String(left.tenant) === String(right.tenant) &&
  String(left.grantId) === String(right.grantId) &&
  String(left.credentialId) === String(right.credentialId) &&
  left.credentialRef === right.credentialRef &&
  String(left.actorSubject) === String(right.actorSubject) &&
  String(left.effectiveSubject) === String(right.effectiveSubject) &&
  String(left.scopeVersion) === String(right.scopeVersion);

const bindingFromAuth = (auth: AuthContext["Service"] | null): DelegationBinding | undefined => {
  if (auth === null) return undefined;
  if (auth.kind !== "delegated" || auth.delegation === undefined) return undefined;
  return {
    tenant: auth.delegation.tenant,
    grantId: auth.delegation.grantId,
    credentialId: auth.delegation.credentialId,
    credentialRef: auth.delegation.credentialRef,
    actorSubject: auth.delegation.actorSubject,
    effectiveSubject: auth.delegation.effectiveSubject,
    scopeVersion: auth.delegation.scopeVersion,
  };
};

/** The pending record is in the effective subject's owner partition. A
 * delegated machine must match every persisted grant field; a human target or
 * admin may approve a grant through the host resumer, which rebuilds the
 * original scoped engine. */
const canResumePending = (
  approval: PendingApproval,
  auth: AuthContext["Service"] | null,
): boolean => {
  const binding = approval.delegationBinding;
  if (binding === undefined) {
    return auth === null || (auth.kind !== "delegated" && auth.accountId !== null);
  }
  if (auth === null) return false;
  const current = bindingFromAuth(auth);
  if (current !== undefined) return sameDelegationBinding(current, binding);
  return (
    auth.kind === "member" &&
    auth.accountId !== null &&
    (auth.accountId === String(binding.effectiveSubject) || auth.roles.includes("admin"))
  );
};

const samePendingRecord = (left: PendingApproval, right: PendingApproval): boolean =>
  left.executionId === right.executionId &&
  left.artifactId === right.artifactId &&
  left.code === right.code &&
  left.address === right.address &&
  left.expiresAt === right.expiresAt &&
  (left.delegationBinding === undefined
    ? right.delegationBinding === undefined
    : right.delegationBinding !== undefined &&
      sameDelegationBinding(left.delegationBinding, right.delegationBinding));

/**
 * Honour an approval whose paused fiber is no longer reachable.
 *
 * The record is read through the caller's OWN scoped executor, so an execution
 * id that is not this caller's reads as absent — the same-query ownership rule
 * the artifact path already uses. It is consumed on read, so one approval
 * authorizes exactly one invocation.
 *
 * A non-accept answer discards the record and reports the decline, which is the
 * same observable outcome as declining a live pause: nothing runs.
 */
const resumeFromPendingApproval = (executionId: string, action: "accept" | "decline" | "cancel") =>
  Effect.gen(function* () {
    const executor = yield* ExecutorService;
    const engine = yield* ExecutionEngineService;
    const auth = yield* Effect.serviceOption(AuthContext).pipe(
      Effect.map((value) => Option.getOrElse(value, () => null)),
    );
    const resumer = yield* DelegatedExecutionResumer;

    const pending = yield* executor.pendingApprovals
      .get(executionId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (!pending || !canResumePending(pending, auth)) return null;

    const binding = pending.delegationBinding;
    if (binding !== undefined && auth?.kind === "member") {
      if (action === "accept" && resumer === null) return null;
      if (resumer !== null) {
        const authorized = yield* captureEngineError(
          resumer.authorize({
            binding,
            executionId,
            approver: {
              kind: "member",
              accountId: auth.accountId,
              organizationId: auth.organizationId,
              roles: auth.roles,
            },
          }),
        );
        if (!authorized) return null;
      }
    } else if (binding !== undefined && auth?.kind === "delegated" && auth.delegation) {
      // Revalidate before consuming the one-shot record. A revoked grant must
      // not lose its approval record and must never be dispatched.
      yield* auth.delegation.revalidate({ operation: "approval", executionId });
    }

    const approval = yield* executor.pendingApprovals
      .consume(executionId, (candidate) => samePendingRecord(candidate, pending))
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (!approval) return null;

    if (action !== "accept") {
      return {
        status: "completed" as const,
        text: `Approval ${action === "decline" ? "declined" : "cancelled"}. Nothing ran.`,
        structured: { status: "declined", executionId, address: approval.address },
        isError: false,
      };
    }

    if (binding !== undefined && auth?.kind === "member") {
      if (resumer === null) return null;
      const outcome = yield* captureEngineError(
        resumer.resume({
          code: approval.code,
          binding,
          executionId,
          approver: {
            kind: "member",
            accountId: auth.accountId,
            organizationId: auth.organizationId,
            roles: auth.roles,
          },
        }),
      );
      if (outcome === null) return null;
      return formatResumedOutcome(outcome);
    }

    // The exact delegated caller approved, so run the recorded call with the
    // gate satisfied on the already grant-scoped engine. A human never reaches
    // this branch: rebuilding their engine is the resumer path above.
    // `code` is the address the server itself resolved at pause time, so this
    // runs exactly the call that was described in the approval prompt.
    const outcome = yield* captureEngineError(
      engine.executeWithPause(approval.code, { autoApprove: true }),
    );

    return formatResumedOutcome(outcome);
  });

const formatResumedOutcome = (outcome: ExecutionResult) => {
  if (outcome.status === "completed") {
    const formatted = formatExecuteResult(outcome.result);
    return {
      status: "completed" as const,
      text: formatted.text,
      structured: formatted.structured,
      isError: formatted.isError,
    };
  }

  // `autoApprove` accepts every gate inline, so a second pause is not
  // reachable here; surface it rather than silently dropping the call.
  const formatted = formatPausedExecution(outcome.execution);
  return {
    status: "paused" as const,
    text: formatted.text,
    structured: formatted.structured,
  };
};

export const ExecutionsHandlers = HttpApiBuilder.group(ExecutorApi, "executions", (handlers) =>
  handlers
    .handle("getPaused", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const engine = yield* ExecutionEngineService;
          const paused = yield* captureEngineError(engine.getPausedExecution(path.executionId));

          if (!paused) {
            return yield* new ExecutionNotFoundError({ executionId: path.executionId });
          }

          return formatPausedExecution(paused);
        }),
      ),
    )
    .handle("execute", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const engine = yield* ExecutionEngineService;
          const auth = yield* Effect.serviceOption(AuthContext).pipe(
            Effect.map((value) => Option.getOrElse(value, () => null)),
          );
          const delegationBinding = bindingFromAuth(auth);
          // An artifact-originated request is not arbitrary code. It is parsed
          // against the shell proxy's one grammar and rewritten through the
          // artifact's connection bindings, exactly as `execute-action` does in
          // the MCP host — the console's artifact page must not be a wider door
          // onto the same iframe.
          const code =
            payload.artifactId === undefined
              ? payload.code
              : yield* resolveArtifactCode(payload.code, payload.artifactId);
          const outcome = yield* captureEngineError(
            engine.executeWithPause(code, {
              // `autoApprove` means the caller is a verified human approver.
              // A delegated credential is a machine actor and may never turn
              // an approval policy into an unconditional execution through a
              // request body flag. Durable human approval has its own
              // grant-bound resumer path above.
              autoApprove: auth?.kind === "delegated" ? false : payload.autoApprove,
            }),
          );

          if (outcome.status === "completed") {
            const formatted = formatExecuteResult(outcome.result);
            return {
              status: "completed" as const,
              text: formatted.text,
              structured: formatted.structured,
              isError: formatted.isError,
            };
          }

          // The pause is a live fiber in THIS engine, which on a host that
          // builds an engine per request is gone the moment this response is
          // written. Record the resolved call so the approval can be honoured by
          // whichever instance serves the resume. Artifact calls only: a general
          // codemode pause can sit anywhere inside arbitrary code and is not
          // reconstructible from one address.
          if (payload.artifactId !== undefined) {
            yield* recordPendingApproval({
              executionId: outcome.execution.id,
              artifactId: payload.artifactId,
              code,
              address: String(outcome.execution.elicitationContext.address),
              ...(delegationBinding === undefined ? {} : { delegationBinding }),
            });
          }

          const formatted = formatPausedExecution(outcome.execution);
          return {
            status: "paused" as const,
            text: formatted.text,
            structured: formatted.structured,
          };
        }),
      ),
    )
    .handle("resume", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const engine = yield* ExecutionEngineService;
          const result = yield* captureEngineError(
            engine
              .resume(path.executionId, {
                action: payload.action,
                content: payload.content as Record<string, unknown> | undefined,
                ...(payload.persist === undefined ? {} : { meta: { persist: payload.persist } }),
              })
              // A human may be answering a live delegated pause. Let the
              // durable path resolve the original binding instead of turning
              // the denial into an opaque engine error or running as human.
              .pipe(Effect.catchTag("DelegationDeniedError", () => Effect.succeed(null))),
          );

          // No live pause: either this resume landed on a different engine
          // instance than the pause did (the normal case on a host that builds
          // an engine per request), or the window really has closed.
          if (!result) {
            const honoured = yield* resumeFromPendingApproval(path.executionId, payload.action);
            if (honoured) return honoured;
            return yield* new ApprovalExpiredError({ executionId: path.executionId });
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
      ),
    ),
);
