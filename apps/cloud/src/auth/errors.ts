import { Data, Effect, Option, Predicate, Schema } from "effect";

export class UserStoreError extends Schema.TaggedErrorClass<UserStoreError>()(
  "UserStoreError",
  {},
  { httpApiStatus: 500 },
) {}

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
