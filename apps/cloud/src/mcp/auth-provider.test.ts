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

import { createHash } from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Layer, Predicate } from "effect";

import {
  McpAuthProvider,
  orgWriteAccessForPrincipal,
  type AuthOutcome,
} from "@executor-js/host-mcp";

import { ApiKeyService } from "../auth/api-keys";
import { WorkOSError } from "../auth/errors";
import { cloudMcpAuthProviderLayer, type CloudPrincipal } from "./auth-provider";
import {
  MCP_ORGANIZATION_HEADER,
  McpAuth,
  McpAuthLive,
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

// The bare `/mcp`, which pins no organization in the URL.
const bareRequest = () =>
  new Request("https://executor.sh/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer token_fixture",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
  });

// A verified bearer that carries an account + org — the org-authorize branch is
// what we exercise, so verifyBearer succeeds here.
const stubAuth = Layer.succeed(McpAuth)({
  verifyBearer: () =>
    Effect.succeed(mcpAuthorized({ accountId: ACCOUNT_ID, organizationId: ORG_ID })),
});

// A verified bearer whose token names no organization: an account signed in
// through an MCP client's OAuth with no v1 organization.
const stubAuthNoOrganization = Layer.succeed(McpAuth)({
  verifyBearer: () =>
    Effect.succeed(mcpAuthorized({ accountId: ACCOUNT_ID, organizationId: null })),
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

// `authorize` SUCCEEDS with the resolved org record — active membership. The
// record, not just the id: the session props carry the org's name and slug so
// the session DO never re-reads the row.
const stubOrgAuthActive = Layer.succeed(McpOrganizationAuth)({
  authorize: () =>
    Effect.succeed({ id: ORG_ID, name: "Stub Org", slug: "stub-org", memberRole: "admin" }),
});

// A failure that is not a WorkOSError at all (e.g. the per-request DB layer
// failing before the WorkOS call) — no status to read, must stay transient.
class StubInfraError extends Data.TaggedError("StubInfraError")<{
  readonly detail: string;
}> {}

const authenticateWith = (
  orgAuth: Layer.Layer<McpOrganizationAuth>,
  auth: Layer.Layer<McpAuth> = stubAuth,
  makeRequest: () => Request = request,
) =>
  Effect.gen(function* () {
    const provider = yield* McpAuthProvider;
    return yield* provider.authenticate(makeRequest());
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
      expect(principal?.orgRoleModel).toBe("organization");
      expect(principal?.orgRole, "the live membership role reaches the MCP session").toBe("admin");
      const legacyAccess = principal
        ? orgWriteAccessForPrincipal(
            (({ orgRole: _orgRole, ...legacyMissingRole }) => legacyMissingRole)(principal),
          )
        : null;
      expect(legacyAccess).toBe("denied");
    }),
  );

  it.effect("a moved org's mark rides on the principal; an unmoved org carries none", () =>
    Effect.gen(function* () {
      const moved = yield* authenticateWith(
        Layer.succeed(McpOrganizationAuth)({
          authorize: () =>
            Effect.succeed({
              id: ORG_ID,
              name: "Stub Org",
              memberRole: "member",
              movedToV2: { v2OrganizationId: "v2-org" },
            }),
        }),
      );
      const unmoved = yield* authenticateWith(stubOrgAuthActive);
      const movedMark = Predicate.isTagged(moved, "Authenticated")
        ? (moved.principal as CloudPrincipal).movedToV2
        : "not authenticated";
      const unmovedMark = Predicate.isTagged(unmoved, "Authenticated")
        ? (unmoved.principal as CloudPrincipal).movedToV2
        : "not authenticated";
      expect(movedMark).toEqual({ v2OrganizationId: "v2-org" });
      expect(unmovedMark).toBeUndefined();
    }),
  );

  it.effect(
    "no organization in the token or the URL -> Forbidden naming Executor v2's MCP URL, with no lookup",
    () =>
      Effect.gen(function* () {
        const selectors: Array<string> = [];
        const outcome = yield* authenticateWith(
          Layer.succeed(McpOrganizationAuth)({
            authorize: (_accountId, selector) => {
              selectors.push(selector);
              return Effect.succeed(null);
            },
          }),
          stubAuthNoOrganization,
          bareRequest,
        );
        expect(outcome).toEqual({
          _tag: "Forbidden",
          code: -32001,
          message:
            "Executor has moved. This account has no organization on executor.sh/mcp: connect https://mcp.executor.sh/mcp instead. If you belong to an organization on executor.sh, reconnect this server and sign in again to choose it.",
        });
        expect(selectors, "nothing names an organization to look up").toEqual([]);
      }),
  );

  it.effect("a token naming no organization still opens the organization its URL pins", () =>
    Effect.gen(function* () {
      const selectors: Array<string> = [];
      const outcome = yield* authenticateWith(
        Layer.succeed(McpOrganizationAuth)({
          authorize: (_accountId, selector) => {
            selectors.push(selector);
            return Effect.succeed({ id: ORG_ID, name: "Stub Org", memberRole: "member" });
          },
        }),
        stubAuthNoOrganization,
      );
      const principal = Predicate.isTagged(outcome, "Authenticated") ? outcome.principal : null;
      expect(principal?.organizationId).toBe(ORG_ID);
      expect(selectors).toEqual([ORG_ID]);
    }),
  );

  it.effect("a revoked membership keeps its own Forbidden copy", () =>
    Effect.gen(function* () {
      const outcome = yield* authenticateWith(stubOrgAuthNoMembership);
      expect(outcome).toEqual({
        _tag: "Forbidden",
        code: -32001,
        message: "No organization in session — log in via the web app first",
      });
    }),
  );

  it.effect("missing bearer still short-circuits to Unauthorized", () =>
    Effect.gen(function* () {
      const outcome = yield* authenticateWith(stubOrgAuthActive, stubAuthMissingBearer);
      expect(Predicate.isTagged(outcome, "Unauthorized")).toBe(true);
    }),
  );
});

describe("cloud MCP API-key callers", () => {
  const API_KEY = "sk_test_synthetic_key_value";
  // The key belongs to another organization than the one the URL selects.
  const KEY_ORG_ID = "org_key_owner";

  // The real `McpAuthLive` bearer dispatch over a stubbed WorkOS key lookup.
  const apiKeyAuth = McpAuthLive.pipe(
    Layer.provide(
      Layer.succeed(ApiKeyService)({
        validate: (value) =>
          Effect.succeed(
            value === API_KEY
              ? {
                  scope: "user" as const,
                  accountId: ACCOUNT_ID,
                  organizationId: KEY_ORG_ID,
                  keyId: "api_key_test",
                }
              : null,
          ),
        listUserKeys: () => Effect.die("MCP auth test does not list API keys"),
        createUserKey: () => Effect.die("MCP auth test does not create API keys"),
        revokeUserKey: () => Effect.die("MCP auth test does not revoke API keys"),
        listOrgKeys: () => Effect.die("MCP auth test does not list org API keys"),
        createOrgKey: () => Effect.die("MCP auth test does not create org API keys"),
        revokeOrgKey: () => Effect.die("MCP auth test does not revoke org API keys"),
      }),
    ),
  );

  const apiKeyRequest = () =>
    new Request("https://executor.sh/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer  ${API_KEY} `,
        [MCP_ORGANIZATION_HEADER]: ORG_ID,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

  const apiKeyOf = (outcome: AuthOutcome) =>
    Predicate.isTagged(outcome, "Authenticated")
      ? (outcome.principal as CloudPrincipal).apiKey
      : "not authenticated";

  it.effect("the principal carries the key id, the key's organization and its hash", () =>
    Effect.gen(function* () {
      const outcome = yield* authenticateWith(stubOrgAuthActive, apiKeyAuth, apiKeyRequest);
      const hash = createHash("sha256").update(API_KEY).digest("base64url");
      expect(hash).toHaveLength(43);
      expect(apiKeyOf(outcome)).toEqual({
        id: "api_key_test",
        organizationId: KEY_ORG_ID,
        hash,
      });
      const principal = Predicate.isTagged(outcome, "Authenticated") ? outcome.principal : null;
      expect(principal?.organizationId, "the URL selector still picks the organization").toBe(
        ORG_ID,
      );
    }),
  );

  it.effect("a JWT caller's principal carries no API key", () =>
    Effect.gen(function* () {
      const outcome = yield* authenticateWith(stubOrgAuthActive);
      expect(Predicate.isTagged(outcome, "Authenticated")).toBe(true);
      expect(apiKeyOf(outcome)).toBeUndefined();
    }),
  );
});
