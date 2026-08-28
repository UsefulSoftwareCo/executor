// ---------------------------------------------------------------------------
// Autumn billing service — wraps the autumn-js SDK with Effect
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Autumn } from "autumn-js";
import { Context, Data, Effect, Layer } from "effect";

import { captureCauseEffect } from "../../observability";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AutumnError extends Data.TaggedError("AutumnError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Autumn has no customer record for the organization. Split out from
 * `AutumnError` because it is not an outage and must not be treated like one:
 * an outage is transient and the right answer is to fail open and page, while
 * a missing customer is a PERMANENT provisioning gap — every subsequent
 * balance call 404s the same way, so the org runs unbilled and unmetered
 * forever. Callers that own an organization id repair it (see
 * `withProvisionedCustomer`); everything else still surfaces as `AutumnError`.
 */
export class AutumnCustomerNotFoundError extends Data.TaggedError("AutumnCustomerNotFoundError")<{
  message: string;
  cause?: unknown;
}> {}

export type AutumnFailure = AutumnError | AutumnCustomerNotFoundError;

// Autumn's own error code for "no such customer", carried in the JSON body of
// a 404 (`{"message":"Customer <id> not found","code":"customer_not_found"}`).
const CUSTOMER_NOT_FOUND_CODE = "customer_not_found";

/**
 * True when `cause` is Autumn's "no such customer" answer. The autumn-js SDK
 * throws an `AutumnError` carrying the raw HTTP `statusCode` and `body`; match
 * on the code rather than the status alone so an unrelated 404 (a removed
 * endpoint, a proxy) is still reported as a genuine failure.
 */
const isCustomerNotFoundCause = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) return false;
  const { statusCode, body } = cause as { readonly statusCode?: unknown; readonly body?: unknown };
  if (statusCode !== 404 || typeof body !== "string") return false;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: classifying a third-party SDK's raw response body; a body that isn't JSON simply isn't this error
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: the autumn-js SDK hands back the response body as an unvalidated string
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return false;
    return (parsed as { readonly code?: unknown }).code === CUSTOMER_NOT_FOUND_CODE;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export type IAutumnService = Readonly<{
  use: <A>(fn: (client: Autumn) => Promise<A>) => Effect.Effect<A, AutumnFailure, never>;
  /**
   * Provision the organization's Autumn customer, creating it if Autumn has
   * never seen it. Idempotent — safe to call on every org creation.
   */
  ensureCustomer: (organizationId: string) => Effect.Effect<void, AutumnFailure, never>;
  checkExecutionBalance: (
    organizationId: string,
  ) => Effect.Effect<{ readonly allowed: boolean }, AutumnFailure, never>;
  /**
   * Fire-and-forget-safe execution usage tracker. Errors are caught and
   * logged; the returned Effect never fails. Callers typically
   * `Effect.runFork` it at the boundary so the billing call can't stall a
   * user-facing request.
   */
  trackExecution: (organizationId: string) => Effect.Effect<void, never, never>;
}>;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const make = Effect.sync(() => {
  const secretKey = env.AUTUMN_SECRET_KEY;

  if (!secretKey) {
    const notConfigured = Effect.fail(
      new AutumnError({ message: "Autumn not configured: AUTUMN_SECRET_KEY is empty" }),
    );
    return {
      use: () => notConfigured,
      ensureCustomer: () => notConfigured,
      checkExecutionBalance: () => notConfigured,
      trackExecution: () => Effect.void,
    } satisfies IAutumnService;
  }

  // AUTUMN_API_URL points the real SDK at an Autumn emulator in tests/dev.
  const client = new Autumn({
    secretKey,
    ...(env.AUTUMN_API_URL ? { serverURL: env.AUTUMN_API_URL } : {}),
  });

  const use = <A>(fn: (client: Autumn) => Promise<A>) =>
    Effect.tryPromise({
      try: () => fn(client),
      catch: (cause): AutumnFailure =>
        isCustomerNotFoundCause(cause)
          ? new AutumnCustomerNotFoundError({
              message: "Autumn has no customer for this organization",
              cause,
            })
          : new AutumnError({ message: "Autumn SDK request failed", cause }),
      // An inline arrow's `name` is "" — not nullish — so `??` left every
      // Autumn call tracing as the bare span `autumn.`.
    }).pipe(Effect.withSpan(`autumn.${fn.name || "use"}`));

  const ensureCustomer = (organizationId: string) =>
    Effect.asVoid(use((c) => c.customers.getOrCreate({ customerId: organizationId })));

  /**
   * Run `operation`; if Autumn answers "no such customer", provision the
   * organization's customer and run it ONCE more.
   *
   * This is the seam that closes the provisioning hole. Both billing paths use
   * non-creating endpoints, so an organization Autumn never learned about
   * 404s here forever: the balance gate fails open (correct for an outage,
   * catastrophic as a steady state) and every usage track is lost. Repairing
   * the customer makes the retry land the call — and a genuine Autumn outage
   * still fails with `AutumnError` and still pages, unretried.
   */
  const withProvisionedCustomer = <A>(
    organizationId: string,
    operation: Effect.Effect<A, AutumnFailure>,
  ) =>
    operation.pipe(
      Effect.catchTag("AutumnCustomerNotFoundError", () =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({ "autumn.customer.provisioned": true });
          yield* ensureCustomer(organizationId);
          return yield* operation;
        }),
      ),
    );

  const trackExecution = (organizationId: string) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ "autumn.customer.id": organizationId });
      yield* withProvisionedCustomer(
        organizationId,
        use((c) => c.track({ customerId: organizationId, featureId: "executions", value: 1 })),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            // Silent billing data loss is worth paging on: autumn.trackExecution
            // is fire-and-forget so the caller doesn't handle it themselves.
            yield* Effect.sync(() => {
              console.error("[billing] track failed:", error);
            });
            yield* captureCauseEffect(error);
            yield* Effect.annotateCurrentSpan({ "autumn.track.failed": true });
          }),
        ),
      );
    }).pipe(Effect.withSpan("autumn.trackExecution"));

  const checkExecutionBalance = (organizationId: string) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ "autumn.customer.id": organizationId });
      const check = yield* withProvisionedCustomer(
        organizationId,
        use((c) => c.check({ customerId: organizationId, featureId: "executions" })),
      );
      return { allowed: check.allowed };
    }).pipe(Effect.withSpan("autumn.checkExecutionBalance"));

  return { use, ensureCustomer, checkExecutionBalance, trackExecution } satisfies IAutumnService;
});

export class AutumnService extends Context.Service<AutumnService, IAutumnService>()(
  "@executor-js/cloud/AutumnService",
) {
  static Default = Layer.effect(this)(make);
}
