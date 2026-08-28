import { Data, Effect, Option, Predicate, Schema } from "effect";

// How a user-store call failed, classified from the driver cause. Safe to put
// on the wire and on a Sentry tag: it names a failure MODE, never a query, a
// value, or a customer.
export const USER_STORE_FAILURE_REASONS = [
  "connect_timeout",
  "connection_closed",
  "query",
  "unknown",
] as const;

export type UserStoreFailureReason = (typeof USER_STORE_FAILURE_REASONS)[number];

/**
 * The public failure of every cloud user-store call.
 *
 * It carries the two fields that make an issue diagnosable from the error
 * alone: which store call failed, and how. Before those existed the error had
 * an empty field set, so Sentry showed a titleless, messageless issue and the
 * only cause detail (the pretty-printed Effect cause in a Sentry `extra`) is
 * scrubbed server-side — the failing operation and the driver reason existed
 * only in the trace store. Same shape as `WorkOSError.status`: a small, safe
 * classification field threaded at the service boundary.
 */
export class UserStoreError extends Schema.TaggedErrorClass<UserStoreError>()(
  "UserStoreError",
  {
    /** The store call that failed, e.g. `getOrganization`. */
    operation: Schema.String,
    /** How it failed, classified from the driver cause chain. */
    reason: Schema.Literals(USER_STORE_FAILURE_REASONS),
  },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `user store ${this.operation} failed: ${this.reason}`;
  }
}

/** Reasons a retry can plausibly clear: the query never reached a healthy
 *  server. A `query` failure is deterministic and must not be retried. */
export const isTransientUserStoreReason = (reason: UserStoreFailureReason): boolean =>
  reason === "connect_timeout" || reason === "connection_closed";

// postgres.js tags its connection failures with a string `code`
// (`CONNECT_TIMEOUT`, `CONNECTION_CLOSED`, …) and its query failures with the
// SQLSTATE. Drizzle re-throws both wrapped in its own "Failed query" error with
// the driver error in `.cause`, and the service adapter wraps that again, so
// the classification walks the chain rather than inspecting one level.
const MAX_CAUSE_DEPTH = 8;

const REASON_BY_DRIVER_CODE: Readonly<Record<string, UserStoreFailureReason>> = {
  CONNECT_TIMEOUT: "connect_timeout",
  ETIMEDOUT: "connect_timeout",
  CONNECTION_CLOSED: "connection_closed",
  CONNECTION_ENDED: "connection_closed",
  CONNECTION_DESTROYED: "connection_closed",
  ECONNREFUSED: "connection_closed",
  ECONNRESET: "connection_closed",
};

const stringCodeOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const code = (value as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const driverCodesOf = (failure: unknown): readonly string[] => {
  const codes: string[] = [];
  let current: unknown = isServiceAdapterError(failure) ? failure.cause : failure;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null;
    depth++
  ) {
    const code = stringCodeOf(current);
    if (code !== undefined) codes.push(code);
    current =
      typeof current === "object" ? (current as { readonly cause?: unknown }).cause : undefined;
  }
  return codes;
};

/** Classify a raw store failure. A recognised connection code wins; any other
 *  driver code (a SQLSTATE) is a deterministic query failure; nothing at all is
 *  `unknown`. */
export const userStoreReasonFromCause = (failure: unknown): UserStoreFailureReason => {
  const codes = driverCodesOf(failure);
  for (const code of codes) {
    const reason = REASON_BY_DRIVER_CODE[code];
    if (reason !== undefined) return reason;
  }
  return codes.length > 0 ? "query" : "unknown";
};

/** Build the public `UserStoreError` for a store-adapter failure, naming the
 *  operation the call site already knows and classifying the driver cause. */
export const userStoreErrorFromFailure = (operation: string, failure: unknown): UserStoreError =>
  new UserStoreError({ operation, reason: userStoreReasonFromCause(failure) });

export class WorkOSError extends Schema.TaggedErrorClass<WorkOSError>()(
  "WorkOSError",
  {
    /**
     * The upstream HTTP status WorkOS answered with, when the failure WAS an
     * HTTP answer (the SDK sets `.status` on all its typed exceptions).
     * Absent for network errors / timeouts. Consumers that must distinguish
     * "WorkOS said no" (definitive 4xx) from "WorkOS was unreachable"
     * (transient) branch on this — see `isDefinitiveWorkOSDenialStatus`.
     */
    status: Schema.optional(Schema.Number),
  },
  { httpApiStatus: 500 },
) {}

// Statuses that are a DEFINITIVE denial from WorkOS — a deterministic "this
// request cannot be authorized" answer (invalid/revoked API key, forbidden,
// resource gone), not a blip. Retrying does not help, and auth decisions built
// on them must fail CLOSED. Everything else (429, 5xx, or no status at all —
// network error/timeout) is transient and must stay retryable.
const DEFINITIVE_DENIAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

export const isDefinitiveWorkOSDenialStatus = (status: number | undefined): boolean =>
  status !== undefined && DEFINITIVE_DENIAL_STATUSES.has(status);

// Tag-based guards (same pattern as `isOAuth2Error` in core/sdk/oauth-helpers):
// the untyped failure channels these run against carry values that crossed
// layer boundaries, so the discriminant is the `_tag`, not the prototype chain.
const isWorkOSError = Predicate.isTagged("WorkOSError") as (error: unknown) => error is WorkOSError;

/** A `WorkOSError` that is a definitive denial (see above), typed on `unknown`
 *  so auth code holding an untyped failure channel can branch safely. */
export const isDefinitiveWorkOSDenial = (error: unknown): boolean =>
  isWorkOSError(error) && isDefinitiveWorkOSDenialStatus(error.status);

// Every typed exception the WorkOS node SDK throws for an HTTP answer carries a
// numeric `.status` (UnauthorizedException 401, NotFoundException 404,
// RateLimitExceededException 429, GenericServerException/OauthException with the
// live status, ...). Network errors and timeouts throw non-SDK errors with no
// status. Same extraction pattern as the workos-vault plugin's
// `statusFromWorkOSCause` (packages/plugins/workos-vault/src/sdk/client.ts).
const CauseWithStatusSchema = Schema.Struct({ status: Schema.Number });
const decodeCauseWithStatusOption = Schema.decodeUnknownOption(CauseWithStatusSchema);

export const statusFromWorkOSCause = (cause: unknown): number | undefined =>
  Option.match(decodeCauseWithStatusOption(cause), {
    onNone: () => undefined,
    onSome: (decoded) => decoded.status,
  });

/**
 * Build the public `WorkOSError` for a WorkOS service-adapter failure,
 * threading the upstream HTTP status through when the underlying SDK exception
 * carried one. The failure is normally the `ServiceAdapterError` wrapper from
 * `tryPromiseService` (SDK exception in `.cause`); a bare cause also works.
 */
const isServiceAdapterError = Predicate.isTagged("ServiceAdapterError") as (
  failure: unknown,
) => failure is ServiceAdapterError;

export const workosErrorFromFailure = (failure: unknown): WorkOSError =>
  new WorkOSError({
    status: statusFromWorkOSCause(isServiceAdapterError(failure) ? failure.cause : failure),
  });

export class ApiKeyManagementError extends Schema.TaggedErrorClass<ApiKeyManagementError>()(
  "ApiKeyManagementError",
  { cause: Schema.Unknown },
  { httpApiStatus: 500 },
) {}

/**
 * Private wrapper used by service adapters that lift Promise APIs into
 * Effect. `withServiceLogging` immediately remaps these into a public-facing
 * tagged error, so callers never observe this tag directly — its only job is
 * to keep the internal failure channel typed instead of `unknown` / `Error`.
 */
export class ServiceAdapterError extends Data.TaggedError("ServiceAdapterError")<{
  readonly cause: unknown;
}> {}

/** Lift a Promise-returning function into Effect with a typed failure channel. */
export const tryPromiseService = <A>(fn: () => Promise<A>): Effect.Effect<A, ServiceAdapterError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => new ServiceAdapterError({ cause }),
  });

/**
 * Service-boundary error wrapper. Logs the full Cause chain (drizzle
 * query/params, pg error codes, nested Error.cause, etc.) via Effect's
 * structured logger, then maps to a tagged error so the HTTP wire
 * response contains only safe fields.
 *
 * Use this whenever a Promise-based API gets lifted into an Effect and
 * its failure needs both debuggable server-side logging and a safe
 * public shape.
 */
export const withServiceLogging = <A, E, R>(
  name: string,
  // Receives the raw failure (for service adapters: the `ServiceAdapterError`
  // whose `.cause` is the SDK exception) so the public error can carry safe
  // classification fields (e.g. `WorkOSError.status`). Zero-arg callers that
  // ignore the failure keep working unchanged.
  publicError: (failure: unknown) => E,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.tapCause((cause) => Effect.logError(`${name} failed`, cause)),
    Effect.mapError(publicError),
    Effect.withSpan(name),
  ) as Effect.Effect<A, E, R>;
