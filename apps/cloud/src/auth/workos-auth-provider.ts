// ---------------------------------------------------------------------------
// Cloud's identity provider — folds the three former `protected.ts` resolvers
// (`resolveApiKeyPrincipal`, `resolveSessionPrincipal`, `resolveProtectedPrincipal`)
// into one `authenticate(request)` that the shared `ExecutionStackMiddleware`
// consumes. The credential precedence (Bearer api-key BEATS sealed-session
// cookie) stays INSIDE this adapter — it is WorkOS-specific and deliberately not
// abstracted into the shared seam.
//
// Cloud now provides the NEUTRAL `IdentityProvider` tag (same as self-host), not
// a forked one. Each rejected path raises the SHARED identity error carrying the
// SAME machine `code` + `message` it always emitted, so cloud's failure strategy
// reproduces the exact `{ error, code }` JSON bytes at the SAME status:
//   - non-Bearer header          -> Unauthorized  401 invalid_authorization_header
//   - empty Bearer token         -> Unauthorized  401 invalid_api_key
//   - api-key validate outage    -> Unavailable   503 api_key_validation_unavailable
//   - invalid api key            -> Unauthorized  401 invalid_api_key
//   - api-key org not authorized -> NoOrganization 403 no_organization
//   - no/invalid session         -> NoOrganization 403 no_organization
//   - session without org header -> NoOrganization 403 no_organization (fail closed)
//   - session org not authorized -> NoOrganization 403 no_organization
//   - no auth header             -> falls through to the sealed-session path
// The org-resolution infra errors (`UserStoreError` / `WorkOSError`) are
// `Effect.die`d so they surface as 500 defects — the same status the old inline
// resolver produced when those bubbled up.
//
// The per-request `UserStoreService` (read by the org-resolution path) stays a
// REQUIREMENT OF THE LAYER, satisfied by the facade's per-request DB combine —
// NOT a function-level requirement (that is what forced a forked tag before).
// ---------------------------------------------------------------------------

import { Effect, Layer } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import type { JWTVerifyGetKey } from "jose";

import {
  IdentityProvider,
  NoOrganization,
  Unauthorized,
  Unavailable,
} from "@executor-js/api/server";
import type {
  FailureRenderingStrategy,
  IdentityFailure,
  PlatformPrincipal,
  Principal,
  ResolvedPrincipal,
} from "@executor-js/api/server";

import { ApiKeyService } from "./api-keys";
import { workosApiJwtBearerConfig } from "./api-jwt-bearer";
import { BEARER_PREFIX } from "./bearer";
import {
  authorizeOrganization,
  authorizeOrganizationSelector,
  orgSelectorFromRequest,
  resolveOrganization,
} from "./organization";
import { UserStoreService } from "./context";
import { sealedSessionDisplayName } from "./middleware";
import type { UserStoreError, WorkOSError } from "./errors";
import { WorkOSClient } from "./workos";
import { verifyWorkosUserManagementToken } from "../mcp/jwt";

/**
 * The config the bearer-JWT branch needs to verify a WorkOS device-login
 * (user_management) access token: the client-scoped SSO JWKS resolver. Issuer
 * and audience are NOT pinned (the client-scoped JWKS binds the token to this
 * app; user_management tokens carry no audience and an app-specific issuer) and
 * org membership is re-checked live downstream. Passed in as a plain value so
 * this module stays `cloudflare:workers`-free and the node-pool resolver tests
 * can inject a local JWKS. Production supplies {@link workosApiJwtBearerConfig}.
 */
export interface JwtBearerConfig {
  readonly jwks: JWTVerifyGetKey;
}

// The exact machine codes + messages each rejected path has always emitted.
// Carried on the shared identity error so the failure strategy renders the
// byte-identical `{ error, code }` body.
const INVALID_AUTHORIZATION_HEADER = {
  code: "invalid_authorization_header",
  message: "Authorization header must use Bearer authentication",
};
const INVALID_API_KEY = { code: "invalid_api_key", message: "Invalid API key" };
const API_KEY_VALIDATION_UNAVAILABLE = {
  code: "api_key_validation_unavailable",
  message: "API key validation is temporarily unavailable",
};
const NO_ORGANIZATION_IN_API_KEY = {
  code: "no_organization",
  message: "No organization in API key",
};
const NO_ORGANIZATION_IN_SESSION = {
  code: "no_organization",
  message: "No organization in session",
};
const NO_ORGANIZATION_SELECTOR = {
  code: "no_organization",
  message: "No organization selector in request",
};
const INVALID_ACCESS_TOKEN = {
  code: "invalid_access_token",
  message: "Invalid or expired access token",
};
const ACCESS_TOKEN_VERIFICATION_UNAVAILABLE = {
  code: "access_token_verification_unavailable",
  message: "Access token verification is temporarily unavailable",
};
const NO_ORGANIZATION_IN_ACCESS_TOKEN = {
  code: "no_organization",
  message: "No organization in access token",
};
// A bearer value with three dot-separated segments is a JWT (a WorkOS access
// token from the CLI device-login); anything else is treated as an API key.
// Same discriminator the MCP plane uses (`mcp/auth.ts`).
const looksLikeJwt = (token: string): boolean => token.split(".").length === 3;

/**
 * Resolve a WorkOS device-login (user_management) access token into a protected
 * `Principal`. Verifies the token's signature + expiry against the client-scoped
 * SSO JWKS, then live-checks org membership, exactly like the api-key path. The
 * `org_id` claim must be present (a token with no org context is rejected as
 * `NoOrganization`). NOTE: this is a different WorkOS token domain than the MCP
 * `/oauth2` tokens (different keyset, no audience), so it does NOT reuse the MCP
 * verifier or its JWKS, audience, and issuer.
 */
const resolveJwtPrincipal = (token: string, jwt: JwtBearerConfig) =>
  Effect.gen(function* () {
    const verified = yield* verifyWorkosUserManagementToken(token, jwt.jwks).pipe(
      Effect.catchTag("McpJwtVerificationError", (error) =>
        Effect.fail(
          error.reason === "system"
            ? new Unavailable(ACCESS_TOKEN_VERIFICATION_UNAVAILABLE)
            : new Unauthorized(INVALID_ACCESS_TOKEN),
        ),
      ),
    );

    if (!verified || !verified.accountId) return yield* new Unauthorized(INVALID_ACCESS_TOKEN);
    if (!verified.organizationId) {
      return yield* new NoOrganization(NO_ORGANIZATION_IN_ACCESS_TOKEN);
    }

    const org = yield* authorizeOrganization(verified.accountId, verified.organizationId);
    if (!org) return yield* new NoOrganization(NO_ORGANIZATION_IN_ACCESS_TOKEN);

    return {
      kind: "member",
      accountId: verified.accountId,
      organizationId: org.id,
      organizationName: org.name,
      organizationSlug: org.slug,
      email: "",
      name: null,
      avatarUrl: null,
      roles: [],
      orgRole: org.memberRole,
    } satisfies Principal;
  });

/**
 * What an ORG-level API key resolves to: the platform view. Deliberately NOT a
 * `Principal` — a `Principal` names an acting member (`accountId: string`), and
 * an org key has none. Keeping it a separate shape means no product code path
 * can accidentally treat it as a member, and the executor built from it binds
 * `subject: null` + the read-only tenant reach rather than inventing a subject.
 *
 * The `/admin/*` mount turns this into an executor with `{ tenant:
 * organizationId, subject: undefined, platformView: true }`.
 */
export interface PlatformAuth {
  readonly kind: "platform";
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug?: string;
  readonly keyId: string;
}

/** A resolved bearer credential: an acting member, or the org-level platform
 *  view. `null` means no `Authorization` header at all. */
export type BearerAuth = Principal | PlatformAuth | null;

export const isPlatformAuth = (value: BearerAuth): value is PlatformAuth =>
  value !== null && "kind" in value && value.kind === "platform";

/**
 * Resolve a `Bearer` credential into either a member `Principal` or the
 * org-level {@link PlatformAuth}. Returns `null` when there is no
 * `Authorization` header, so the caller falls through to the sealed-session
 * path.
 *
 * The org branch does NOT call `authorizeOrganization`: that checks a USER's
 * live membership, and there is no user here. The key itself is the authority —
 * WorkOS validated it and reported which org owns it — so the org row is merely
 * resolved (mirrored on first read) for its name and slug.
 */
export const resolveBearerAuth = (
  request: Request,
  jwt: JwtBearerConfig | null = null,
): Effect.Effect<
  BearerAuth,
  Unauthorized | NoOrganization | Unavailable | UserStoreError | WorkOSError,
  WorkOSClient | ApiKeyService | UserStoreService
> =>
  Effect.gen(function* () {
    const authHeader = request.headers.get("authorization");
    if (!authHeader) return null;

    if (!authHeader.startsWith(BEARER_PREFIX)) {
      return yield* new Unauthorized(INVALID_AUTHORIZATION_HEADER);
    }

    const value = authHeader.slice(BEARER_PREFIX.length).trim();
    if (!value) return yield* new Unauthorized(INVALID_API_KEY);

    if (jwt && looksLikeJwt(value)) return yield* resolveJwtPrincipal(value, jwt);

    const apiKeys = yield* ApiKeyService;
    const owner = yield* apiKeys
      .validate(value)
      .pipe(
        Effect.catchTag("ApiKeyValidationError", () =>
          Effect.fail(new Unavailable(API_KEY_VALIDATION_UNAVAILABLE)),
        ),
      );

    if (!owner) return yield* new Unauthorized(INVALID_API_KEY);

    if (owner.scope === "org") {
      const org = yield* resolveOrganization(owner.organizationId);
      return {
        kind: "platform",
        organizationId: org.id,
        organizationName: org.name,
        ...(org.slug === undefined || org.slug === null ? {} : { organizationSlug: org.slug }),
        keyId: owner.keyId,
      } satisfies PlatformAuth;
    }

    // A `"user"` key always carries an accountId (see `ownerFromApiKey`); the
    // guard keeps the narrowing honest rather than asserting.
    if (owner.accountId == null) return yield* new Unauthorized(INVALID_API_KEY);

    const org = yield* authorizeOrganization(owner.accountId, owner.organizationId);
    if (!org) return yield* new NoOrganization(NO_ORGANIZATION_IN_API_KEY);

    return {
      kind: "member",
      accountId: owner.accountId,
      organizationId: org.id,
      organizationName: org.name,
      organizationSlug: org.slug,
      email: "",
      name: null,
      avatarUrl: null,
      roles: [],
      orgRole: org.memberRole,
    } satisfies Principal;
  });

/**
 * The PRODUCT-plane bearer resolver. An org-level key resolves to the neutral
 * seam's {@link PlatformPrincipal} — NOT a member `Principal` — and the shared
 * middleware routes it to the subject-less, read-only platform executor
 * (refusing non-GET up front). Previously the product plane rejected org keys
 * outright; serving tenant-level READS to them is deliberate: the catalog,
 * tools, policies, and org-owned connection listings are tenant-shared answers
 * a machine credential can honestly receive, while everything subject-bound
 * stays structurally out of reach (a platform executor binds no subject, so no
 * member's personal rows resolve). (Kept the historical name; the re-export and
 * resolver tests reference it.)
 */
export const resolveApiKeyPrincipal = (
  request: Request,
  jwt: JwtBearerConfig | null = null,
): Effect.Effect<
  ResolvedPrincipal | null,
  Unauthorized | NoOrganization | Unavailable | UserStoreError | WorkOSError,
  WorkOSClient | ApiKeyService | UserStoreService
> =>
  Effect.gen(function* () {
    const auth = yield* resolveBearerAuth(request, jwt);
    if (isPlatformAuth(auth)) {
      return {
        kind: "platform",
        organizationId: auth.organizationId,
        organizationName: auth.organizationName,
        ...(auth.organizationSlug === undefined ? {} : { organizationSlug: auth.organizationSlug }),
        keyId: auth.keyId,
      } satisfies PlatformPrincipal;
    }
    return auth;
  });

export const resolveSessionPrincipal = (request: Request) =>
  Effect.gen(function* () {
    const workos = yield* WorkOSClient;
    const session = yield* workos.authenticateRequest(request);
    if (!session) {
      return yield* new NoOrganization(NO_ORGANIZATION_IN_SESSION);
    }
    // The console URL's org is the scope authority, sent as a header on every
    // request. FAIL CLOSED when it's missing: the sealed cookie's org is
    // browser-global and pinned to whichever org WorkOS last touched, so
    // falling back to it silently serves ANOTHER org's data to a multi-org
    // user (the wrong-tenant connection-list bug, 2026-07). A header-less
    // session call gets a clear 403 instead. Membership is re-checked live —
    // the header is a selector, not a trust boundary (see organization.ts).
    // A bare-URL first paint (no org in the path yet) may 403 here; that's
    // the safe outcome — OrgSlugGate immediately canonicalizes the URL onto
    // an org slug, the org-keyed atom registry remounts, and everything
    // refetches with the header. `/account/me` — which deliberately DOES fall
    // back to the session org to pick that landing org — lives on the account
    // plane, not here.
    const selector = orgSelectorFromRequest(request);
    if (!selector) {
      return yield* new NoOrganization(NO_ORGANIZATION_SELECTOR);
    }
    const org = yield* authorizeOrganizationSelector(session.userId, selector);
    if (!org) return yield* new NoOrganization(NO_ORGANIZATION_IN_SESSION);
    return {
      kind: "member",
      accountId: session.userId,
      organizationId: org.id,
      organizationName: org.name,
      organizationSlug: org.slug,
      email: session.email,
      name: sealedSessionDisplayName(session),
      avatarUrl: session.avatarUrl ?? null,
      roles: [],
      orgRole: org.memberRole,
    } satisfies Principal;
  });

/**
 * Resolve to the neutral `Principal` (api-key BEATS sealed-session). Cloud has
 * no roles to resolve, so each leaf already carries `roles: []`. Raises the
 * SHARED identity errors directly (`Unauthorized | NoOrganization | Unavailable`,
 * each carrying its machine `code` + `message`); the org-resolution infra errors
 * (`UserStoreError` / `WorkOSError`) bubble for `workosIdentityLayer` to `die`.
 * Keeps `WorkOSClient` / `ApiKeyService` / `UserStoreService` as requirements (the
 * org-resolution path reads them) so it stays request-scoped. Re-exported for
 * `protected-api-key-auth.node.test.ts`, which asserts the per-path principal +
 * shared error codes this folded resolver emits.
 */
export const resolveProtectedPrincipal = (
  request: Request,
  jwt: JwtBearerConfig | null = null,
): Effect.Effect<
  ResolvedPrincipal,
  Unauthorized | NoOrganization | Unavailable | UserStoreError | WorkOSError,
  WorkOSClient | ApiKeyService | UserStoreService
> =>
  Effect.gen(function* () {
    const bearerPrincipal = yield* resolveApiKeyPrincipal(request, jwt);
    if (bearerPrincipal) return bearerPrincipal;
    return yield* resolveSessionPrincipal(request);
  });

/**
 * Cloud's NEUTRAL `IdentityProvider` Layer. Closes over the long-lived
 * `WorkOSClient` + `ApiKeyService`; the request-scoped `UserStoreService` stays a
 * REQUIREMENT OF THE LAYER, satisfied per request by the facade's DB combine.
 * `authenticate` matches the neutral shape exactly (`Effect<Principal,
 * Unauthorized | NoOrganization | Unavailable>`): rejected credentials already
 * carry the shared errors; the org-resolution infra errors (`UserStoreError` /
 * `WorkOSError`) are `Effect.die`d so they surface as 500 defects, never on the
 * error channel.
 */
export const workosIdentityLayer: Layer.Layer<
  IdentityProvider,
  never,
  WorkOSClient | ApiKeyService | UserStoreService
> = Layer.effect(
  IdentityProvider,
  Effect.gen(function* () {
    const context = yield* Effect.context<WorkOSClient | ApiKeyService | UserStoreService>();
    return IdentityProvider.of({
      authenticate: (request) =>
        resolveProtectedPrincipal(request, workosApiJwtBearerConfig).pipe(
          // `UserStoreError` / `WorkOSError` are org-resolution infra failures —
          // surface as a 500 defect, exactly as the old inline resolver let them
          // bubble. The narrow `die` here is the runtime edge for that infra
          // failure; the shared identity errors stay typed on the channel.
          Effect.catchTags({
            // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: org-resolution infra failure -> 500 defect, matches prior inline-resolver behavior
            UserStoreError: (error) => Effect.die(error),
            // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: org-resolution infra failure -> 500 defect, matches prior inline-resolver behavior
            WorkOSError: (error) => Effect.die(error),
          }),
          Effect.provide(context),
        ),
    });
  }),
);

// Render a shared identity failure as cloud's exact `{ error, code }` JSON body
// at the given status. `code` + `message` ride on the shared error (cloud always
// supplies both); the defaults only guard the self-host-produced bare errors.
const renderIdentityFailure =
  (status: number, fallbackCode: string, fallbackMessage: string) =>
  (failure: { readonly code?: string; readonly message?: string }) =>
    Effect.succeed(
      HttpServerResponse.jsonUnsafe(
        {
          error: failure.message ?? fallbackMessage,
          code: failure.code ?? fallbackCode,
        },
        { status },
      ),
    );

/**
 * Cloud's failure-rendering STRATEGY. Where self-host's `textFailureStrategy`
 * renders the shared identity errors as plain text, cloud renders them as its
 * exact `{ error, code }` JSON at 401 / 403 / 503 — BYTE-IDENTICAL to the old
 * `HttpResponseError` responses. The `code` + `message` carried on each shared
 * error reproduce the precise body; the tag fixes the status.
 */
export const cloudIdentityFailureStrategy: FailureRenderingStrategy<IdentityFailure> = {
  renderFailure: (effect) =>
    effect.pipe(
      Effect.catchTags({
        Unauthorized: renderIdentityFailure(401, "unauthorized", "Unauthorized"),
        NoOrganization: renderIdentityFailure(403, "no_organization", "No organization"),
        Unavailable: renderIdentityFailure(
          503,
          "service_unavailable",
          "Service temporarily unavailable",
        ),
        ReadOnlyCredential: renderIdentityFailure(
          403,
          "read_only_credential",
          "Organization API keys are read-only",
        ),
      }),
    ),
};
