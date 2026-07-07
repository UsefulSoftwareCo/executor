// ---------------------------------------------------------------------------
// The cloud MCP auth provider's organization-authorization branch.
//
// The load-bearing property under test: a TRANSIENT WorkOS failure during the
// live membership lookup must resolve to a retryable `Unavailable` (503), NOT a
// `Forbidden`. Only `Forbidden` reaches the session-destroy path in
// agent-handler, so misclassifying a WorkOS blip as Forbidden permanently
// condemns a live session DO. A lookup that SUCCEEDS with no membership is a
// genuine `Forbidden` (destroy allowed); a lookup that succeeds with an org id
// is `Authenticated`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Layer, Predicate } from "effect";

import { McpAuthProvider } from "@executor-js/host-mcp";

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

// Mirrors the real failure channel: `authorizeOrganization`'s WorkOS call maps
// upstream 429/5xx/timeout to a tagged `WorkOSError` before it reaches here.
class StubWorkOSError extends Data.TaggedError("StubWorkOSError")<{
  readonly detail: string;
}> {}

// `authorize` FAILS (transient WorkOS error) — the blip we must classify as 503.
const stubOrgAuthTransientFailure = Layer.succeed(McpOrganizationAuth)({
  authorize: () => Effect.fail(new StubWorkOSError({ detail: "workos 503: upstream timeout" })),
});

// `authorize` SUCCEEDS with `null` — the caller genuinely holds no membership.
const stubOrgAuthNoMembership = Layer.succeed(McpOrganizationAuth)({
  authorize: () => Effect.succeed(null),
});

// `authorize` SUCCEEDS with an org id — active membership.
const stubOrgAuthActive = Layer.succeed(McpOrganizationAuth)({
  authorize: () => Effect.succeed(ORG_ID),
});

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
  it.effect("transient WorkOS failure -> Unavailable (retryable 503, session preserved)", () =>
    Effect.gen(function* () {
      const outcome = yield* authenticateWith(stubOrgAuthTransientFailure);
      expect(Predicate.isTagged(outcome, "Unavailable")).toBe(true);
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
