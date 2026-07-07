// ---------------------------------------------------------------------------
// The cloud MCP auth provider's organization-authorization branch.
//
// The load-bearing property under test is the failure CLASSIFICATION, in both
// directions:
//
//   - a TRANSIENT WorkOS failure (429/5xx/timeout/network — retrying can help)
//     must resolve to a retryable `Unavailable` (503), NOT a `Forbidden`. Only
//     `Forbidden` reaches the session-destroy path in agent-handler, so
//     misclassifying a blip as Forbidden permanently condemns a live session DO.
//   - a DEFINITIVE WorkOS denial (401 revoked/invalid API key, 403, 404 deleted
//     org — WorkOS answered and said no) must fail CLOSED as `Forbidden`, NOT
//     be misread as transient. Misclassifying it as Unavailable would preserve
//     sessions indefinitely for a revoked customer (fail-open inversion).
//
// The definitive/transient split rides on `WorkOSError.status`, threaded from
// the WorkOS SDK exception at the service boundary (auth/workos.ts). A lookup
// that SUCCEEDS with no membership is a genuine `Forbidden` (destroy allowed);
// a lookup that succeeds with an org id is `Authenticated`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Layer, Predicate } from "effect";

import { McpAuthProvider } from "@executor-js/host-mcp";

import { WorkOSError } from "../auth/errors";
import { cloudMcpAuthProviderLayer } from "./auth-provider";
import {
  MCP_ORGANIZATION_HEADER,
  McpAuth,
  McpOrganizationAuth,
  mcpAuthorized,
  mcpUnauthorized,
} from "./auth";

const ACCOUNT_ID = "user_test";
const ORG_ID = "org_test";

const request = () =>
  new Request("https://executor.sh/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer token_fixture",
      [MCP_ORGANIZATION_HEADER]: ORG_ID,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
  });

// A verified bearer that carries an account + org — the org-authorize branch is
// what we exercise, so verifyBearer succeeds here.
const stubAuth = Layer.succeed(McpAuth)({
  verifyBearer: () =>
    Effect.succeed(mcpAuthorized({ accountId: ACCOUNT_ID, organizationId: ORG_ID })),
});

const stubAuthMissingBearer = Layer.succeed(McpAuth)({
  verifyBearer: () => Effect.succeed(mcpUnauthorized("missing_bearer")),
});

// `authorize` failing with the REAL `WorkOSError` the service boundary mints:
// with `status` when WorkOS answered (its SDK exceptions all carry one), without
// when the failure never reached WorkOS (network error / timeout).
const stubOrgAuthFailing = (error: unknown): Layer.Layer<McpOrganizationAuth> =>
  Layer.succeed(McpOrganizationAuth)({ authorize: () => Effect.fail(error) });

// `authorize` SUCCEEDS with `null` — the caller genuinely holds no membership.
const stubOrgAuthNoMembership = Layer.succeed(McpOrganizationAuth)({
  authorize: () => Effect.succeed(null),
});

// `authorize` SUCCEEDS with an org id — active membership.
const stubOrgAuthActive = Layer.succeed(McpOrganizationAuth)({
  authorize: () => Effect.succeed(ORG_ID),
});

// A failure that is not a WorkOSError at all (e.g. the per-request DB layer
// failing before the WorkOS call) — no status to read, must stay transient.
class StubInfraError extends Data.TaggedError("StubInfraError")<{
  readonly detail: string;
}> {}

const authenticateWith = (
  orgAuth: Layer.Layer<McpOrganizationAuth>,
  auth: Layer.Layer<McpAuth> = stubAuth,
) =>
  Effect.gen(function* () {
    const provider = yield* McpAuthProvider;
    return yield* provider.authenticate(request());
  }).pipe(
    Effect.provide(cloudMcpAuthProviderLayer.pipe(Layer.provide(Layer.mergeAll(auth, orgAuth)))),
  );

describe("cloud MCP org-authorization classification", () => {
  it.effect("WorkOS 5xx -> Unavailable (retryable 503, session preserved)", () =>
    Effect.gen(function* () {
      const outcome = yield* authenticateWith(stubOrgAuthFailing(new WorkOSError({ status: 503 })));
      expect(Predicate.isTagged(outcome, "Unavailable")).toBe(true);
    }),
  );

  it.effect("WorkOS 429 rate limit -> Unavailable (retryable, session preserved)", () =>
    Effect.gen(function* () {
      const outcome = yield* authenticateWith(stubOrgAuthFailing(new WorkOSError({ status: 429 })));
      expect(Predicate.isTagged(outcome, "Unavailable")).toBe(true);
    }),
  );

  it.effect("WorkOS unreachable (no HTTP status) -> Unavailable (session preserved)", () =>
    Effect.gen(function* () {
      const outcome = yield* authenticateWith(stubOrgAuthFailing(new WorkOSError({})));
      expect(Predicate.isTagged(outcome, "Unavailable")).toBe(true);
    }),
  );

  it.effect("non-WorkOS infra failure -> Unavailable (no status to read, stay retryable)", () =>
    Effect.gen(function* () {
      const outcome = yield* authenticateWith(
        stubOrgAuthFailing(new StubInfraError({ detail: "db layer failed" })),
      );
      expect(Predicate.isTagged(outcome, "Unavailable")).toBe(true);
    }),
  );

  it.effect(
    "WorkOS 401 (revoked/invalid API key) -> Forbidden (fail closed, destroy allowed)",
    () =>
      Effect.gen(function* () {
        const outcome = yield* authenticateWith(
          stubOrgAuthFailing(new WorkOSError({ status: 401 })),
        );
        expect(Predicate.isTagged(outcome, "Forbidden")).toBe(true);
      }),
  );

  it.effect("WorkOS 403 -> Forbidden (fail closed, destroy allowed)", () =>
    Effect.gen(function* () {
      const outcome = yield* authenticateWith(stubOrgAuthFailing(new WorkOSError({ status: 403 })));
      expect(Predicate.isTagged(outcome, "Forbidden")).toBe(true);
    }),
  );

  it.effect("WorkOS 404 (deleted org/user) -> Forbidden (fail closed, destroy allowed)", () =>
    Effect.gen(function* () {
      const outcome = yield* authenticateWith(stubOrgAuthFailing(new WorkOSError({ status: 404 })));
      expect(Predicate.isTagged(outcome, "Forbidden")).toBe(true);
    }),
  );

  it.effect("lookup succeeds with no membership -> Forbidden (destroy allowed)", () =>
    Effect.gen(function* () {
      const outcome = yield* authenticateWith(stubOrgAuthNoMembership);
      expect(Predicate.isTagged(outcome, "Forbidden")).toBe(true);
    }),
  );

  it.effect("active membership -> Authenticated (principal carries the resolved org)", () =>
    Effect.gen(function* () {
      const outcome = yield* authenticateWith(stubOrgAuthActive);
      const principal = Predicate.isTagged(outcome, "Authenticated") ? outcome.principal : null;
      expect(principal?.accountId).toBe(ACCOUNT_ID);
      expect(principal?.organizationId).toBe(ORG_ID);
    }),
  );

  it.effect("missing bearer still short-circuits to Unauthorized", () =>
    Effect.gen(function* () {
      const outcome = yield* authenticateWith(stubOrgAuthActive, stubAuthMissingBearer);
      expect(Predicate.isTagged(outcome, "Unauthorized")).toBe(true);
    }),
  );
});
