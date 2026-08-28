// ---------------------------------------------------------------------------
// Cloud's rollout gate for MCP Enterprise-Managed Authorization.
//
// Implements the vendor-free `EnterpriseManagedRollout` port from
// `@executor-js/sdk` against PostHog, which is the only flag/analytics service
// this deployment operates. Two deliberate shapes:
//
// 1. NO SDK. This is a hand-written `fetch` against two documented PostHog
//    endpoints, not `posthog-node`. Cloud already ate an unexplained 3-5s
//    page-load regression from adding one dependency to the worker bundle and
//    the mechanism was never identified (see the notes on the MCP SDK v2
//    revert). Until that is understood, a new runtime dependency in this bundle
//    is a cost we are not willing to pay for a boolean, and the whole client we
//    would be importing is two POSTs wide.
//
// 2. FAIL CLOSED, ALWAYS. Every way of not getting an answer — timeout,
//    transport failure, non-2xx, a body we cannot parse, no PostHog key
//    configured, no acting user to key the rollout on — withholds the
//    enterprise-managed path and falls back to ordinary interactive OAuth. A
//    PostHog outage therefore degrades the rollout and never fails a connect,
//    and (because the SDK freezes the verdict onto the connection) never
//    touches an enterprise-managed connection that already exists.
//
// The rollout UNIT is the user: `distinct_id` is the acting user's id, the same
// id `posthog.identify(user.id, …)` uses in the browser, so a percentage
// rollout here means the same population it means everywhere else in the
// project. The organization rides along as group context so org-level targeting
// stays available in the PostHog UI without changing that unit.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Effect, Schema } from "effect";

import type {
  EnterpriseManagedRollout,
  EnterpriseManagedRolloutContext,
  EnterpriseManagedRolloutDecision,
  EnterpriseManagedRolloutEvent,
} from "@executor-js/sdk";

import { POSTHOG_INGEST_HOST } from "../edge/passthrough";

/** The flag that gates enterprise-managed authorization. */
export const ENTERPRISE_MANAGED_AUTH_FLAG_KEY = "mcp-enterprise-managed-auth";

/** PostHog group type for organizations — the same one
 *  `posthog.group("organization", …)` establishes in the browser. */
const ORGANIZATION_GROUP_TYPE = "organization";

/**
 * How long a flag evaluation may take before the gate gives up and withholds.
 * Short on purpose: this call sits in front of an interactive connect, and the
 * safe answer is already known, so waiting is strictly worse than answering.
 */
export const DEFAULT_FLAG_EVALUATION_TIMEOUT_MS = 1_000;

/** Wire names of the rollout events, in the product's `object_verb` style. */
const EVENT_NAMES = {
  attempted: "ema_connect_attempted",
  connected: "ema_connect_connected",
  "blocked-by-admin": "ema_connect_blocked_by_admin",
} as const satisfies Record<EnterpriseManagedRolloutEvent["kind"], string>;

// ---------------------------------------------------------------------------
// Boundary parsing
// ---------------------------------------------------------------------------

/** The slice of PostHog's `POST /flags?v=2` response this gate reads. Unknown
 *  keys are ignored, so PostHog adding fields cannot make the gate fail closed;
 *  a body that is not this shape at all can, which is the intent. */
const FlagsResponse = Schema.Struct({
  flags: Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.Boolean })),
});

const decodeFlagsResponse = Schema.decodeUnknownEffect(FlagsResponse);

// ---------------------------------------------------------------------------
// Detached work
// ---------------------------------------------------------------------------

/**
 * Hand a request to the platform and stop caring about it.
 *
 * `waitUntil` is the correct owner when the caller has an `ExecutionContext`;
 * the executor composition seam this gate is installed through does not receive
 * one, so the default owner attaches a terminal rejection handler and lets the
 * in-flight request ride out the rest of the response. Either way the promise
 * is owned by something that cannot report back, which is what makes an event
 * structurally unable to fail or delay a connect.
 */
const detach = (
  work: Promise<unknown>,
  waitUntil: ((work: Promise<unknown>) => void) | undefined,
): void => {
  const settled = work.then(
    () => undefined,
    () => undefined,
  );
  if (waitUntil) waitUntil(settled);
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface PostHogRolloutConfig {
  /** Public project key (`phc_…`). Public by design — it is already shipped to
   *  every browser — so this is a var, not a secret. */
  readonly projectKey: string;
  /** PostHog API origin (no trailing slash), e.g. `https://us.i.posthog.com`. */
  readonly host: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** Platform post-response hook, when the caller has one. */
  readonly waitUntil?: (work: Promise<unknown>) => void;
}

const withheld = (
  reason: "disabled" | "evaluation-unavailable",
): EnterpriseManagedRolloutDecision => ({ kind: "withheld", reason });

const ENABLED: EnterpriseManagedRolloutDecision = { kind: "enabled" };

/** Group context for a connect whose organization the host named. */
const groupsFor = (context: EnterpriseManagedRolloutContext): Record<string, string> | undefined =>
  context.organizationId === null
    ? undefined
    : { [ORGANIZATION_GROUP_TYPE]: context.organizationId };

/**
 * Build cloud's enterprise-managed rollout gate over an explicit PostHog
 * configuration. Everything environmental is a parameter so the composition
 * root parses it once and tests drive the real code path with an injected
 * `fetch`.
 */
export const makePostHogEnterpriseManagedRollout = (
  config: PostHogRolloutConfig,
): EnterpriseManagedRollout => {
  const timeoutMs = config.timeoutMs ?? DEFAULT_FLAG_EVALUATION_TIMEOUT_MS;

  const evaluate = Effect.fn("Cloud.EnterpriseManagedRollout.decide")(function* (
    context: EnterpriseManagedRolloutContext,
  ) {
    // The rollout unit is the user. With no acting user there is no
    // `distinct_id` to key it on, so there is no answer to be had — withhold
    // rather than invent a rollout bucket.
    const distinctId = context.userId;
    if (distinctId === null) return withheld("evaluation-unavailable");

    const groups = groupsFor(context);
    const response = yield* Effect.tryPromise(() =>
      config.fetch(`${config.host}/flags?v=2`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Declares this a server-side evaluation, which is what selects
          // server-runtime flags in PostHog's runtime detection.
          "user-agent": "executor-cloud",
        },
        body: JSON.stringify({
          api_key: config.projectKey,
          distinct_id: distinctId,
          ...(groups === undefined ? {} : { groups }),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    if (!response.ok) return withheld("evaluation-unavailable");

    const body = yield* Effect.tryPromise(() => response.json() as Promise<unknown>);
    const decoded = yield* decodeFlagsResponse(body);
    const flag = decoded.flags[ENTERPRISE_MANAGED_AUTH_FLAG_KEY];
    // A flag PostHog did not return is a flag that is not on for this user
    // (it may not exist yet, or the project may be quota-limited). That is a
    // real "no", not a failure to answer.
    if (flag === undefined || !flag.enabled) return withheld("disabled");
    return ENABLED;
  });

  return {
    decide: (context) =>
      evaluate(context).pipe(
        // Timeout, transport failure and an unparseable body all land here and
        // all mean the same thing: no answer, so no enterprise-managed attempt.
        // `catchCause` rather than `catchAll` because a defect in this adapter
        // must not become a failed connect either.
        Effect.catchCause(() => Effect.succeed(withheld("evaluation-unavailable"))),
      ),
    record: (event) =>
      Effect.sync(() => {
        const distinctId = event.context.userId;
        // Same reason `decide` withholds: an event with no person to attach to
        // would only pollute the project with anonymous rows.
        if (distinctId === null) return;
        const groups = groupsFor(event.context);
        const decision = event.decision;
        detach(
          config.fetch(`${config.host}/i/v0/e/`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              api_key: config.projectKey,
              event: EVENT_NAMES[event.kind],
              distinct_id: distinctId,
              properties: {
                // Product metadata only. There is no field on
                // `EnterpriseManagedRolloutEvent` that can carry a token, an
                // identity assertion, a client secret or a scope, and none is
                // synthesized here.
                integration_slug: String(event.context.integration),
                ema_flag_enabled: decision.kind === "enabled",
                ...(decision.kind === "withheld"
                  ? { ema_flag_withheld_reason: decision.reason }
                  : {}),
                // PostHog's own convention, so these events can be filtered by
                // flag value in the UI alongside every other flag.
                [`$feature/${ENTERPRISE_MANAGED_AUTH_FLAG_KEY}`]: decision.kind === "enabled",
                ...(event.kind === "blocked-by-admin" && event.oauthErrorCode !== undefined
                  ? { oauth_error_code: event.oauthErrorCode }
                  : {}),
                ...(groups === undefined ? {} : { $groups: groups }),
              },
            }),
          }),
          config.waitUntil,
        );
      }),
  };
};

/** A gate that answers "no" to everything, for a deployment that has no PostHog
 *  configuration to evaluate against. Cloud is SUPPOSED to have one, so a
 *  missing key is a misconfiguration, and failing closed is the same choice the
 *  outage paths make. This is NOT the same as injecting no gate at all, which
 *  is how the hosts with no flag service (local, desktop, CLI, self-host) keep
 *  their existing behavior. */
export const unavailableEnterpriseManagedRollout: EnterpriseManagedRollout = {
  decide: () => Effect.succeed(withheld("evaluation-unavailable")),
  record: () => Effect.void,
};

/**
 * The gate as the cloud worker composes it: the public project key already
 * shipped in `wrangler.jsonc`, and the same PostHog ingest origin the
 * adblock-dodging passthrough proxies to.
 */
export const cloudEnterpriseManagedRollout = (): EnterpriseManagedRollout => {
  const projectKey = env.VITE_PUBLIC_POSTHOG_KEY;
  if (!projectKey) return unavailableEnterpriseManagedRollout;
  return makePostHogEnterpriseManagedRollout({
    projectKey,
    host: env.VITE_PUBLIC_POSTHOG_HOST ?? `https://${POSTHOG_INGEST_HOST}`,
    fetch: (input, init) => globalThis.fetch(input, init),
  });
};
