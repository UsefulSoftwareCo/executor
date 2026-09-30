import { Context, Data, type Effect } from "effect";
import type * as Cause from "effect/Cause";
import type { Executor } from "@executor-js/sdk";
import type { ExecutionEngine } from "@executor-js/execution";

export class ExecutorService extends Context.Service<ExecutorService, Executor>()(
  "ExecutorService",
) {}

/** A user-meaningful artifact operation on the HTTP plane — the console UI's
 *  data layer. `viewed` is the detail read (`get`), not `list`; `updated`
 *  covers both save-overwrite and rename; `setPreview` is a render side
 *  effect, not a user action, and deliberately absent. */
export type ArtifactUsageAction = "created" | "viewed" | "updated" | "deleted";

/**
 * Optional observer for artifact operations served by the artifacts HTTP
 * handlers. A `Context.Reference` (default null) rather than a required
 * service: hosts that record product analytics provide one at boot; every
 * other host — and every test — composes unchanged. Observers are best-effort:
 * the handlers swallow their failures.
 */
export const ArtifactUsageObserver = Context.Reference<
  ((action: ArtifactUsageAction) => Effect.Effect<void>) | null
>("@executor-js/api/ArtifactUsageObserver", { defaultValue: () => null });

/** A host could not serve the loopback callback an OAuth app declares. */
export class OAuthLoopbackListenError extends Data.TaggedError("OAuthLoopbackListenError")<{
  /** The callback URL that could not be served. */
  readonly url: string;
  /** User-facing reason. The connect dialog renders it verbatim. */
  readonly message: string;
}> {}

/** What a host must implement to serve a declared loopback callback. */
export interface OAuthLoopbackListenerShape {
  /** Serve `url` — always `http://127.0.0.1:<port><path>` — so the provider's
   *  redirect reaches this Executor. Idempotent for the same URL within its
   *  TTL, since retrying a flow must reuse the listener already bound rather
   *  than fail on its own port. */
  readonly listen: (url: string) => Effect.Effect<void, OAuthLoopbackListenError>;
}

/**
 * Optional host capability: serve the loopback callback a registered OAuth app
 * declares (RFC 8252 §7.3).
 *
 * A provider that does not support dynamic client registration only accepts a
 * redirect URI registered on its own OAuth app, and Executor can only use that
 * URI if something is listening there. Only a host whose browser shares the
 * machine with the server can serve one — the CLI and the desktop app — so this
 * is a `Context.Reference` (default null) rather than a required service: cloud,
 * remote self-host, and every test compose unchanged, and a flow that NEEDS the
 * callback fails with an actionable message instead of sending a redirect URI
 * that nothing answers.
 */
export const OAuthLoopbackListener = Context.Reference<OAuthLoopbackListenerShape | null>(
  "@executor-js/api/OAuthLoopbackListener",
  { defaultValue: () => null },
);

// Error channel widened to `Cause.YieldableError` so callers that plug
// in a runtime-specific tagged error (e.g.
// `ExecutionEngine<DynamicWorkerExecutionError>`) assign structurally.
// Handlers yield directly; defects flow through `Effect.catchAllCause`
// at the edge.
export class ExecutionEngineService extends Context.Service<
  ExecutionEngineService,
  ExecutionEngine<Cause.YieldableError>
>()("ExecutionEngineService") {}
