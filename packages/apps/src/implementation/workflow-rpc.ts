import { WorkflowInput } from "../contracts/workflow-input.ts";
/** RPC adapters expose only parsed values and safe failures to isolated app code. */
import { Cause, Effect, Redacted, Schema } from "effect";
import { ResolvedAccounts } from "../contracts/host.ts";
import {
  WorkflowFailure,
  WorkflowRpcCommand,
  WorkflowRpcResult,
  WorkflowRun,
  WorkflowRunPage,
  WorkflowRunId,
  type WorkflowExecution,
  type WorkflowRpc,
  type WorkflowHostControls,
} from "../contracts/workflows.ts";

/** Bind a private host callback to this invocation; no workflow capability survives cancellation. */
export const isolatedWorkflowExecution = (
  run: string,
  deliver: WorkflowRpc,
  signal: AbortSignal,
): WorkflowExecution => {
  const runId = Schema.decodeUnknownSync(WorkflowRunId)(run);
  const request = (input: typeof WorkflowRpcCommand.Type, callback?: () => Promise<unknown>) =>
    // oxlint-disable-next-line executor/authored-code-through-adapter -- the host's workflow RPC
    Effect.tryPromise({
      try: () => deliver(input, callback),
      catch: () => new WorkflowFailure({ reason: "engine", retryable: true }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(WorkflowRpcResult)),
      Effect.mapError(() => new WorkflowFailure({ reason: "engine", retryable: true })),
      Effect.flatMap((reply) =>
        reply.ok ? Effect.succeed(reply.value) : Effect.fail(reply.error),
      ),
    );
  return {
    runId,
    input: (command) =>
      request({ operation: "input", command }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(WorkflowInput)),
        Effect.mapError(() => new WorkflowFailure({ reason: "engine", retryable: true })),
      ),
    driver: {
      waitForInput: (name, id, expiresAt) =>
        request({ operation: "input-wait", name, id, expiresAt }).pipe(Effect.asVoid),
      do: (name, options, work) =>
        Effect.gen(function* () {
          const services = yield* Effect.context<never>();
          return yield* request({ operation: "do", name, options }, () =>
            Effect.runPromiseWith(services)(
              work().pipe(
                Effect.matchCause({
                  onSuccess: (value) => ({ ok: true as const, value }),
                  onFailure: (cause) => {
                    const error = Cause.squash(cause);
                    return {
                      ok: false as const,
                      error: Schema.is(WorkflowFailure)(error)
                        ? error
                        : new WorkflowFailure({ reason: "execution", retryable: true }),
                    };
                  },
                }),
                Effect.flatMap(Schema.encodeEffect(WorkflowRpcResult)),
              ),
              { signal },
            ),
          );
        }),
      sleep: (name, duration) =>
        request({ operation: "sleep", name, duration }).pipe(Effect.asVoid),
      sleepUntil: (name, timestamp) =>
        request({ operation: "until", name, timestamp }).pipe(Effect.asVoid),
    },
    resolve: () =>
      request({ operation: "context" }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ResolvedAccounts)),
        Effect.map((accounts) => ({ accounts: Redacted.make(accounts) })),
        Effect.mapError((error) =>
          Schema.is(WorkflowFailure)(error)
            ? error
            : new WorkflowFailure({ reason: "credentials", retryable: false }),
        ),
      ),
    invoke: (input) => request({ operation: "invoke", ...input }),
  };
};

/**
 * Why a control call has no answer: Executor did not reply, or this framework could not read the
 * reply. Either way a start or terminate may have taken effect, so neither is reported as a failure
 * to repeat.
 */
type Operation = "start" | "get" | "list" | "terminate";
const unanswered = (
  { operation, key }: { readonly operation: Operation; readonly key?: string | undefined },
  unread: boolean,
) => {
  const cause = unread
    ? `This app's apps release could not read Executor's reply to ctx.workflows.${operation}; redeploy the app on the current apps release.`
    : `Executor did not answer ctx.workflows.${operation}.`;
  switch (operation) {
    case "start":
      return new WorkflowFailure({
        reason: "engine",
        retryable: false,
        message:
          key === undefined
            ? `${cause} The run may have started. This start had no key, so check ctx.workflows.list before starting again: another start creates another run.`
            : `${cause} The run may have started. Start it again with the same key and input, which returns the run if it exists, or check ctx.workflows.list before starting another.`,
      });
    case "terminate":
      return new WorkflowFailure({
        reason: "engine",
        retryable: false,
        message: `${cause} The run may have stopped. Read it with ctx.workflows.get before terminating it again.`,
      });
    default:
      return new WorkflowFailure({
        reason: "engine",
        retryable: !unread,
        message: unread ? cause : `${cause} Try again.`,
      });
  }
};

/** Reconstruct app-scoped controls from one invocation-owned RPC function. */
export const isolatedWorkflowControls = (
  deliver: (input: unknown) => Promise<unknown>,
): WorkflowHostControls => {
  const request = <A>(
    input: { readonly operation: Operation; readonly key?: string | undefined },
    schema: Schema.Decoder<A>,
  ) =>
    // oxlint-disable-next-line executor/authored-code-through-adapter -- the host's workflow RPC
    Effect.tryPromise({
      try: () => deliver(input),
      catch: () => unanswered(input, false),
    }).pipe(
      Effect.flatMap((reply) =>
        Schema.decodeUnknownEffect(WorkflowRpcResult)(reply).pipe(
          Effect.mapError(() => unanswered(input, true)),
        ),
      ),
      Effect.flatMap((result) =>
        result.ok
          ? Schema.decodeUnknownEffect(schema)(result.value).pipe(
              Effect.mapError(() => unanswered(input, true)),
            )
          : Effect.fail(result.error),
      ),
    );
  return {
    start: (input) => request({ operation: "start", ...input }, WorkflowRun),
    get: (input) => request({ operation: "get", ...input }, WorkflowRun),
    terminate: (input) => request({ operation: "terminate", ...input }, WorkflowRun),
    list: (input) => request({ operation: "list", ...input }, WorkflowRunPage),
  };
};
