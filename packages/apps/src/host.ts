/** Public host adapter. No product auth, server listener or app-authored routes. */
import { Effect, Schema, Scheduler } from "effect";
import { collectTelemetry, withRemoteSpan } from "@executor-js/telemetry";
import {
  HostAccountsInvalid,
  HostInputInvalid,
  HostResponse,
  TrustedToolApproval,
  ResolvedAccounts,
  type HostContext,
  type ResolvedAccountsInput,
} from "./contracts/host.ts";
import { createAppHandler as createNativeHandler } from "./implementation/host.ts";
import {
  ElicitationFailed,
  ElicitationReply,
  type ElicitationHandler,
} from "./contracts/elicitation.ts";

export type { HostContext, ResolvedAccountsInput } from "./contracts/host.ts";
export { isolatedCacheSession } from "./implementation/cache-session.ts";

/** Parse trusted account bindings and an optional exact-call approval. Throws safe boundary errors on invalid input. */
export const hostContext = (accounts: ResolvedAccountsInput, approval?: unknown): HostContext => ({
  ...(approval === undefined
    ? {}
    : {
        approval: Effect.runSync(
          Schema.decodeUnknownEffect(TrustedToolApproval)(approval).pipe(
            Effect.mapError(() => new HostInputInvalid()),
          ),
        ),
      }),
  accounts: Effect.runSync(
    Schema.decodeUnknownEffect(Schema.RedactedFromValue(ResolvedAccounts))(accounts).pipe(
      Effect.mapError(() => new HostAccountsInvalid()),
    ),
  ),
});

/** Portable Promise handler. Invoke only after the host has authorized and resolved accounts. */
export const createAppHandler = (
  app: unknown,
): ((request: Request, context: HostContext) => Promise<Response>) => {
  const handler = createNativeHandler(app);
  return (request, context) => {
    const operation = handler(request, context).pipe(withRemoteSpan(request, "app.dispatch"));
    return Effect.runPromise(
      context.telemetry === undefined
        ? operation
        : operation.pipe(Effect.provideContext(context.telemetry.context)),
      { signal: request.signal },
    );
  };
};

/** Isolates return bounded, telemetry beside the protocol result; no exporter secret enters app code. */
export const createIsolatedAppHandler = (app: unknown) => {
  const handler = createNativeHandler(app);
  return (request: Request, context: HostContext): Promise<Response> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { value, telemetry } = yield* collectTelemetry(
          handler(request, context).pipe(withRemoteSpan(request, "app.dispatch")),
        );
        const body = yield* Effect.promise(() => value.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(HostResponse)),
        );
        return Response.json({ ...body, telemetry }, { status: value.status });
      }),
      {
        signal: request.signal,
        // workerd delivers timers in order. A scheduler timer outside a transaction
        // can block timers inside its closed input gate; microtasks avoid that queue.
        scheduler: new Scheduler.MixedScheduler("sync"),
      },
    );
};

/**
 * Adapt a host-owned RPC callback into the handler an isolated app expects. Generated entry
 * points call this instead of depending on Effect, which the app bundle cannot resolve.
 * A transport failure aborts the lifetime so the invocation stops waiting.
 */
export const isolatedElicitation =
  (
    deliver: (request: unknown) => Promise<unknown>,
    lifetime: AbortController,
  ): ElicitationHandler =>
  (request) =>
    Effect.tryPromise({
      try: () => deliver(request),
      catch: () => {
        lifetime.abort();
        return new ElicitationFailed({ reason: "transport" });
      },
    }).pipe(
      Effect.flatMap((reply) =>
        Schema.decodeUnknownEffect(ElicitationReply)(reply).pipe(
          Effect.mapError(() => new ElicitationFailed({ reason: "transport" })),
        ),
      ),
      Effect.flatMap((reply) =>
        reply.ok ? Effect.succeed(reply.response) : Effect.fail(reply.error),
      ),
    );

export {
  isolatedWorkflowExecution,
  isolatedWorkflowControls,
} from "./implementation/workflow-rpc.ts";
