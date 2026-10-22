import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { Effect } from "effect";

import { type Principal } from "@executor-js/api/server";
import type { VerifiedDelegatedCredential } from "@executor-js/sdk";

import type { CloudflareConfig } from "../config";

export type AccessVerifierOptions = {
  /** Test/edge seam for a fixed local key set; production uses Access JWKS. */
  readonly keySet?: JWTVerifyGetKey;
  readonly onVerifiedHuman?: (
    claims: Readonly<Record<string, unknown>>,
    principal: Principal,
    request: Request,
  ) => Effect.Effect<void>;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `auth_time` is the IdP authentication event, unlike `iat`, which is only
 * token issuance time. Missing or stale values fail the recent-auth check
 * used by delegated credential management. */
export const hasRecentAccessAuthentication = (
  claims: Readonly<Record<string, unknown>>,
  maxAgeMs: number,
  now = Date.now(),
  claimName = "auth_time",
): boolean => {
  const custom = claims.custom;
  const customClaims = isRecord(custom) ? custom : undefined;
  const raw = claims[claimName] ?? customClaims?.[claimName];
  const authTime =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw.trim())
        ? Number(raw)
        : null;
  if (authTime === null || !Number.isFinite(authTime) || authTime <= 0) return false;
  const authMs = authTime * 1000;
  return authMs <= now && now - authMs <= maxAgeMs;
};

// ---------------------------------------------------------------------------
// Cloudflare Access assertion verifier — the CF-native swap for self-host's
// Better Auth. Cloudflare Access (Zero Trust) sits IN FRONT of the Worker and
// authenticates the human; it forwards a signed `Cf-Access-Jwt-Assertion` JWT.
// This provider verifies that JWT against the team's public JWKS and maps its
// claims onto the neutral `Principal`. There is no app-level login, no session
// store, no password — the IdP is the gate.
//
// Single-tenant: every verified principal belongs to the one configured org.
// Roles come from the admin allowlist + the Access groups claim.
// ---------------------------------------------------------------------------

/**
 * Access assertions have two positively identified forms. A service token is
 * accepted only when the signed assertion says `type: "app"` and carries a
 * non-empty signed `common_name`; a human assertion must carry both a stable
 * signed `sub` and an email. A caller cannot turn an arbitrary client-id
 * header into a principal by omitting the signed machine claims.
 */
export type AccessAssertionKind = "human" | "service-token" | "invalid";

/** Convert a verified, positively classified Access app assertion into the
 * carrier-neutral credential tuple used by the delegation service. The
 * common_name is a signed stable provider reference; no client secret is ever
 * accepted or returned here. */
export const delegatedCredentialFromAccessClaims = (
  claims: Readonly<Record<string, unknown>>,
  config: CloudflareConfig,
): VerifiedDelegatedCredential | null => {
  if (classifyAccessClaims(claims) !== "service-token") return null;
  const reference = typeof claims.common_name === "string" ? claims.common_name.trim() : "";
  if (!reference) return null;
  return {
    kind: "external",
    adapter: "cloudflare-access",
    issuer: `https://${config.accessTeamDomain}`,
    audience: config.accessAud,
    subject: reference,
    credentialRef: reference,
  };
};

export const classifyAccessClaims = (
  claims: Readonly<Record<string, unknown>>,
): AccessAssertionKind => {
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  const sub = typeof claims.sub === "string" ? claims.sub.trim() : "";
  const commonName = typeof claims.common_name === "string" ? claims.common_name.trim() : "";
  const type = typeof claims.type === "string" ? claims.type : "";
  // `type=app` + a signed common_name is the positive machine assertion. Do
  // not let incidental claims supplied by an Access deployment (including a
  // subject or email) turn a service token into a human or grant it human
  // groups/admin authority.
  if (type === "app" && commonName.length > 0) {
    return "service-token";
  }
  if (sub.length > 0 && email.length > 0 && commonName.length === 0) return "human";
  return "invalid";
};

export const principalFromAccessClaims = (
  claims: Readonly<Record<string, unknown>>,
  config: CloudflareConfig,
): Principal | null => {
  const kind = classifyAccessClaims(claims);
  const email = kind === "human" && typeof claims.email === "string" ? claims.email : "";
  const sub =
    kind === "human" && typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : "";
  const commonName = typeof claims.common_name === "string" ? claims.common_name : "";
  if (classifyAccessClaims(claims) === "invalid") return null;
  const nameClaim = claims[config.accessNameClaim];
  const groupsClaim = kind === "human" ? claims[config.accessGroupsClaim] : undefined;
  const groups = Array.isArray(groupsClaim)
    ? groupsClaim.filter((value): value is string => typeof value === "string")
    : [];
  const isAdmin =
    kind === "human" && email.length > 0 && config.adminEmails.includes(email.toLowerCase());

  return {
    kind: "member",
    accountId: kind === "service-token" ? commonName : sub || email,
    organizationId: config.organizationId,
    organizationName: config.organizationName,
    organizationSlug: config.organizationSlug,
    email,
    name: kind === "service-token" ? commonName : typeof nameClaim === "string" ? nameClaim : null,
    avatarUrl: null,
    roles:
      kind === "service-token"
        ? ["member"]
        : isAdmin
          ? ["admin", ...groups]
          : groups.length > 0
            ? groups
            : ["member"],
    orgRoleModel: "organization",
    orgRole: isAdmin ? "admin" : "member",
  };
};

/**
 * Resolve a request to its verified `Principal`, or `null` when the Access
 * assertion is missing/invalid. The single source of truth for "who is this
 * request", shared by the `IdentityProvider` (the API gate) and the MCP auth
 * provider (the `/mcp` gate) so both enforce Access identically.
 *
 * `jose` caches + rotates the team JWKS, so build the verifier once per config.
 */
export const makeAccessVerifier = (
  config: CloudflareConfig,
  options: AccessVerifierOptions = {},
) => {
  const issuer = `https://${config.accessTeamDomain}`;
  // Cached, lazily-fetched team signing keys; jose handles rotation + caching.
  const jwks = config.enableDevAuth
    ? null
    : (options.keySet ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));

  // Dev/single-user escape hatch: bypass Access entirely, every request is a
  // fixed admin. Only when explicitly enabled (and the instance is otherwise
  // unprotected). Mirrors the local app's single-user model.
  const devPrincipal: Principal = {
    kind: "member",
    accountId: "dev",
    organizationId: config.organizationId,
    organizationName: config.organizationName,
    organizationSlug: config.organizationSlug,
    email: config.adminEmails[0] ?? "dev@local",
    name: "Dev",
    avatarUrl: null,
    roles: ["admin"],
    orgRoleModel: "organization",
    orgRole: "admin",
  };

  const verifyWithClaims = (
    request: Request,
  ): Effect.Effect<{
    readonly claims: Readonly<Record<string, unknown>>;
    readonly principal: Principal;
  } | null> =>
    Effect.gen(function* () {
      if (config.enableDevAuth) return { claims: {}, principal: devPrincipal };
      if (!jwks) return null;
      const token = request.headers.get("Cf-Access-Jwt-Assertion");
      if (!token) return null;

      const verified = yield* Effect.tryPromise({
        try: () => jwtVerify(token, jwks, { issuer, audience: config.accessAud }),
        catch: () => "invalid access assertion",
      }).pipe(Effect.orElseSucceed(() => null));
      if (!verified) return null;

      const claims = verified.payload;
      const principal = principalFromAccessClaims(claims, config);
      if (principal?.kind === "member" && classifyAccessClaims(claims) === "human") {
        yield* (options.onVerifiedHuman?.(claims, principal, request) ?? Effect.void).pipe(
          Effect.orElseSucceed(() => undefined),
        );
      }
      return principal ? { claims, principal } : null;
    });

  const verify = (request: Request): Effect.Effect<Principal | null> =>
    verifyWithClaims(request).pipe(Effect.map((verified) => verified?.principal ?? null));

  return { verify, verifyWithClaims };
};
