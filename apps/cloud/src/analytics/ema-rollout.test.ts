// ---------------------------------------------------------------------------
// Cloud's PostHog-backed enterprise-managed rollout gate.
//
// The gate is exercised through its production seam: the real
// `makePostHogEnterpriseManagedRollout` with an injected `fetch` and an
// injected `waitUntil`, exactly as `auth/jwks-cache.node.test.ts` drives the
// JWKS client. Nothing is module-mocked, so the request these tests read is the
// request PostHog would receive.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { EnterpriseManagedRolloutContext } from "@executor-js/sdk";

import {
  ENTERPRISE_MANAGED_AUTH_FLAG_KEY,
  cloudEnterpriseManagedRollout,
  makePostHogEnterpriseManagedRollout,
} from "./ema-rollout";

const HOST = "https://us.i.posthog.com";
const PROJECT_KEY = "phc_test_project_key";

const CONTEXT: EnterpriseManagedRolloutContext = {
  userId: "user_01ABC",
  organizationId: "org_01XYZ",
  integration: "slack" as EnterpriseManagedRolloutContext["integration"],
};

interface CapturedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
  /** The bound the gate put on this call, when it set one. */
  readonly signal: AbortSignal | null;
}

interface FetchHarness {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: () => readonly CapturedRequest[];
  /** Resolve every request the gate detached, so an assertion cannot race it. */
  readonly settle: () => Promise<void>;
  readonly waitUntil: (work: Promise<unknown>) => void;
}

/**
 * Stands in for PostHog. `respond` decides what each call returns; throwing
 * from it models a transport failure, and an aborted signal models the timeout.
 */
const makeFetchHarness = (
  respond: (request: CapturedRequest) => Response | Promise<Response>,
): FetchHarness => {
  const requests: CapturedRequest[] = [];
  const detached: Promise<unknown>[] = [];
  return {
    requests: () => requests,
    settle: async () => {
      await Promise.all(detached);
    },
    waitUntil: (work) => {
      detached.push(work);
    },
    fetch: async (input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "{}";
      const captured: CapturedRequest = {
        url: String(input),
        // oxlint-disable-next-line executor/no-json-parse -- boundary: test fixture reads back the exact JSON body the gate serialized for PostHog
        body: JSON.parse(raw) as Record<string, unknown>,
        signal: init?.signal instanceof AbortSignal ? init.signal : null,
      };
      requests.push(captured);
      return respond(captured);
    },
  };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const flagsBody = (enabled: boolean) => ({
  flags: {
    [ENTERPRISE_MANAGED_AUTH_FLAG_KEY]: {
      key: ENTERPRISE_MANAGED_AUTH_FLAG_KEY,
      enabled,
      reason: { code: "condition_match" },
    },
  },
  errorsWhileComputingFlags: false,
});

const gate = (harness: FetchHarness, timeoutMs?: number) =>
  makePostHogEnterpriseManagedRollout({
    projectKey: PROJECT_KEY,
    host: HOST,
    fetch: harness.fetch,
    waitUntil: harness.waitUntil,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

describe("flag evaluation", () => {
  it.effect("keys the rollout on the user and carries the org as group context", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness(() => jsonResponse(flagsBody(true)));

      const decision = yield* gate(harness).decide(CONTEXT);

      expect(decision).toEqual({ kind: "enabled" });
      const [request] = harness.requests();
      expect(request?.url).toBe(`${HOST}/flags?v=2`);
      expect(
        request?.body.distinct_id,
        "the rollout unit is the user, matching posthog.identify(user.id) in the browser",
      ).toBe(CONTEXT.userId);
      expect(
        request?.body.groups,
        "the org rides along so group targeting stays available without changing the rollout unit",
      ).toEqual({ organization: CONTEXT.organizationId });
      expect(request?.body.api_key).toBe(PROJECT_KEY);
      expect(request?.signal, "the evaluation is always bounded").not.toBeNull();
    }),
  );

  it.effect("omits group context when the host named no organization", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness(() => jsonResponse(flagsBody(true)));

      yield* gate(harness).decide({ ...CONTEXT, organizationId: null });

      expect(harness.requests()[0]?.body.groups).toBeUndefined();
    }),
  );

  it.effect("withholds when the flag is off for this user", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness(() => jsonResponse(flagsBody(false)));

      expect(yield* gate(harness).decide(CONTEXT)).toEqual({
        kind: "withheld",
        reason: "disabled",
      });
    }),
  );

  it.effect("withholds when PostHog returned no verdict for the flag at all", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness(() =>
        // What a quota-limited project answers.
        jsonResponse({
          flags: {},
          errorsWhileComputingFlags: false,
          quotaLimited: ["feature_flags"],
        }),
      );

      expect(yield* gate(harness).decide(CONTEXT)).toEqual({
        kind: "withheld",
        reason: "disabled",
      });
    }),
  );
});

describe("failing closed", () => {
  it.effect("withholds on a non-2xx answer", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness(() => new Response("nope", { status: 503 }));

      expect(yield* gate(harness).decide(CONTEXT)).toEqual({
        kind: "withheld",
        reason: "evaluation-unavailable",
      });
    }),
  );

  it.effect("withholds on a transport failure", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness(() => {
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: models `fetch` rejecting with a TypeError, which is exactly how a Worker sees a dead upstream
        throw new TypeError("network error");
      });

      expect(yield* gate(harness).decide(CONTEXT)).toEqual({
        kind: "withheld",
        reason: "evaluation-unavailable",
      });
    }),
  );

  it.effect("withholds when the evaluation times out", () =>
    Effect.gen(function* () {
      // Never answers. Only the gate's own AbortSignal ends this call, so the
      // test fails by hanging if the gate ever stops bounding the evaluation.
      const harness = makeFetchHarness(
        (request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal?.addEventListener("abort", () =>
              // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: fetch-compatible fixture mirrors the platform's abort rejection semantics
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );

      expect(
        yield* gate(harness, 1).decide(CONTEXT),
        "a slow flag service must degrade the rollout, never hold up a connect",
      ).toEqual({ kind: "withheld", reason: "evaluation-unavailable" });
    }),
  );

  it.effect("withholds on a body that is not a flags response", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness(() => jsonResponse({ flags: "not-an-object" }));

      expect(yield* gate(harness).decide(CONTEXT)).toEqual({
        kind: "withheld",
        reason: "evaluation-unavailable",
      });
    }),
  );

  it.effect("withholds when there is no acting user to roll out by", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness(() => jsonResponse(flagsBody(true)));

      expect(yield* gate(harness).decide({ ...CONTEXT, userId: null })).toEqual({
        kind: "withheld",
        reason: "evaluation-unavailable",
      });
      expect(harness.requests().length, "and asks PostHog nothing").toBe(0);
    }),
  );

  it.effect("withholds when the deployment has no PostHog configuration", () =>
    Effect.gen(function* () {
      // The cloud test env carries no VITE_PUBLIC_POSTHOG_KEY, so this builds
      // the misconfigured-deployment gate — which is deliberately NOT the same
      // as a host that injects no gate at all.
      expect(yield* cloudEnterpriseManagedRollout().decide(CONTEXT)).toEqual({
        kind: "withheld",
        reason: "evaluation-unavailable",
      });
    }),
  );
});

describe("rollout events", () => {
  it.effect("captures the connect outcome with the flag decision attached", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness(() => jsonResponse({ status: 1 }));
      const rollout = gate(harness);

      yield* rollout.record({
        kind: "connected",
        context: CONTEXT,
        decision: { kind: "enabled" },
      });
      yield* Effect.promise(() => harness.settle());

      const [request] = harness.requests();
      expect(request?.url).toBe(`${HOST}/i/v0/e/`);
      expect(request?.body.event).toBe("ema_connect_connected");
      expect(request?.body.distinct_id).toBe(CONTEXT.userId);
      const properties = request?.body.properties as Record<string, unknown>;
      expect(properties.ema_flag_enabled).toBe(true);
      expect(properties[`$feature/${ENTERPRISE_MANAGED_AUTH_FLAG_KEY}`]).toBe(true);
      expect(properties.$groups).toEqual({
        organization: CONTEXT.organizationId,
      });
      expect(properties.integration_slug).toBe("slack");
    }),
  );

  it.effect("carries the withheld reason on the attempt that never ran", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness(() => jsonResponse({ status: 1 }));

      yield* gate(harness).record({
        kind: "attempted",
        context: CONTEXT,
        decision: { kind: "withheld", reason: "evaluation-unavailable" },
      });
      yield* Effect.promise(() => harness.settle());

      const properties = harness.requests()[0]?.body.properties as Record<string, unknown>;
      expect(harness.requests()[0]?.body.event).toBe("ema_connect_attempted");
      expect(properties.ema_flag_enabled).toBe(false);
      expect(properties.ema_flag_withheld_reason).toBe("evaluation-unavailable");
    }),
  );

  it.effect("carries the identity provider's own error code on a blocked connect", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness(() => jsonResponse({ status: 1 }));

      yield* gate(harness).record({
        kind: "blocked-by-admin",
        context: CONTEXT,
        decision: { kind: "enabled" },
        oauthErrorCode: "unauthorized_client",
      });
      yield* Effect.promise(() => harness.settle());

      const [request] = harness.requests();
      expect(request?.body.event).toBe("ema_connect_blocked_by_admin");
      const properties = request?.body.properties as Record<string, unknown> | undefined;
      expect(properties?.oauth_error_code).toBe("unauthorized_client");
    }),
  );

  it.effect("sends nothing beyond identity, the integration and the flag decision", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness(() => jsonResponse({ status: 1 }));

      yield* gate(harness).record({
        kind: "blocked-by-admin",
        context: CONTEXT,
        decision: { kind: "enabled" },
        oauthErrorCode: "access_denied",
      });
      yield* Effect.promise(() => harness.settle());

      const properties = harness.requests()[0]?.body.properties as Record<string, unknown>;
      expect(
        Object.keys(properties).sort(),
        "a closed property set is what keeps a token or an assertion from ever being added by accident",
      ).toEqual(
        [
          "$feature/mcp-enterprise-managed-auth",
          "$groups",
          "ema_flag_enabled",
          "integration_slug",
          "oauth_error_code",
        ].sort(),
      );
    }),
  );

  it.effect("hands the capture to the platform instead of awaiting it", () =>
    Effect.gen(function* () {
      let resolveCapture: (() => void) | undefined;
      const harness = makeFetchHarness(
        () =>
          new Promise<Response>((resolve) => {
            resolveCapture = () => resolve(jsonResponse({ status: 1 }));
          }),
      );

      // Returns while the capture is still in flight: an analytics call can
      // never be on the critical path of a connect.
      yield* gate(harness).record({
        kind: "attempted",
        context: CONTEXT,
        decision: { kind: "enabled" },
      });

      expect(harness.requests().length).toBe(1);
      resolveCapture?.();
      yield* Effect.promise(() => harness.settle());
    }),
  );

  it.effect("survives a capture that fails outright", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness(() => {
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: models the ingest endpoint being unreachable
        throw new TypeError("network error");
      });

      yield* gate(harness).record({
        kind: "connected",
        context: CONTEXT,
        decision: { kind: "enabled" },
      });
      yield* Effect.promise(() => harness.settle());
    }),
  );

  it.effect("records nothing when there is no person to attach the event to", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness(() => jsonResponse({ status: 1 }));

      yield* gate(harness).record({
        kind: "attempted",
        context: { ...CONTEXT, userId: null },
        decision: { kind: "withheld", reason: "evaluation-unavailable" },
      });

      expect(harness.requests().length).toBe(0);
    }),
  );
});
