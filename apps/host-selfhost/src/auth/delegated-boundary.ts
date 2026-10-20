import { Effect } from "effect";

import type { VerifiedDelegatedCredential } from "@executor-js/sdk";

import { makeSelfHostDelegationServiceForHeaders } from "../account/delegation-provider";
import type { SelfHostConfig } from "../config";
import type { SelfHostDbHandle } from "../db/self-host-db";
import { type BetterAuthHandle } from "./better-auth";
import { SELF_HOST_DELEGATED_KEY_PREFIX, selfHostCredentialToken } from "./delegated-key";

/**
 * Result of checking a credential at a boundary which can create a Better Auth
 * session or invoke a privileged account operation.
 *
 * `unmapped` is the compatibility case for a normal, unbound Better Auth API
 * key. `delegated` is a live binding and must be refused by the boundary;
 * `denied` covers every known binding which is revoked/expired as well as any
 * lookup or verifier failure. The latter deliberately fails closed because a
 * valid browser cookie must never turn an unresolvable bearer into a session.
 */
export type SelfHostDelegatedBoundaryResult = "unmapped" | "delegated" | "denied";

const isProviderIssuedDelegationKey = (metadata: unknown): boolean => {
  if (typeof metadata !== "object" || metadata === null) return false;
  const value = (metadata as Record<string, unknown>).executorDelegationCredentialId;
  return typeof value === "string" && value.length > 0;
};

/**
 * Resolve a Better Auth bearer/API key against the authoritative delegation
 * service before allowing a raw auth/account/admin boundary to proceed.
 *
 * This intentionally verifies every key format. The `exec_` prefix is only a
 * fast path for newly-issued provider keys; proof-bound existing Better Auth
 * PATs retain their ordinary format and therefore must still reach the live
 * delegation lookup. An ordinary PAT which has never been bound remains
 * compatible (`unmapped`).
 */
export const classifySelfHostDelegatedBoundary = (
  db: SelfHostDbHandle,
  betterAuth: BetterAuthHandle,
  config: SelfHostConfig,
  headers: Headers | Record<string, string>,
): Effect.Effect<SelfHostDelegatedBoundaryResult> => {
  const token = selfHostCredentialToken(headers);
  if (!token) return Effect.succeed("unmapped" as const);
  if (token.startsWith(SELF_HOST_DELEGATED_KEY_PREFIX)) return Effect.succeed("denied" as const);

  const requestHeaders = headers instanceof Headers ? headers : new Headers(headers);
  const resolveKey = (
    key: NonNullable<Awaited<ReturnType<BetterAuthHandle["auth"]["api"]["verifyApiKey"]>>["key"]>,
  ) => {
    const credential: VerifiedDelegatedCredential = {
      kind: isProviderIssuedDelegationKey(key.metadata) ? "issued-key" : "external",
      adapter: "better-auth-api-key",
      issuer: betterAuth.auth.options.baseURL,
      audience: betterAuth.organizationId,
      subject: key.referenceId,
      credentialRef: key.id,
    };
    return makeSelfHostDelegationServiceForHeaders(db, betterAuth, config, requestHeaders)
      .resolve(credential)
      .pipe(
        Effect.map(() => "delegated" as const),
        Effect.catchTag("DelegationDeniedError", (error) =>
          Effect.succeed(error.reason === "unmapped" ? ("unmapped" as const) : ("denied" as const)),
        ),
        Effect.catch(() => Effect.succeed("denied" as const)),
      );
  };
  const sessionHeaders = new Headers(
    requestHeaders.has("x-api-key") ? { "x-api-key": token } : { authorization: `Bearer ${token}` },
  );
  return Effect.tryPromise({
    try: () =>
      betterAuth.auth.api.verifyApiKey({
        body: { key: token },
        headers: requestHeaders,
      }),
    // A verifier/storage outage cannot fall through to the cookie session.
    catch: () => "delegated credential lookup failed",
  }).pipe(
    Effect.flatMap((result) => {
      if (!result || result.valid !== true) {
        // Better Auth returns no stable key tuple for disabled, expired, or
        // deleted keys. Preserve legitimate Better Auth session bearer
        // compatibility by checking the token alone; never pass the browser
        // cookie into this lookup, or an invalid bearer could fall through to
        // that human session.
        return Effect.tryPromise({
          try: () => betterAuth.auth.api.getSession({ headers: sessionHeaders }),
          catch: () => null,
        }).pipe(Effect.map((session) => (session ? ("unmapped" as const) : ("denied" as const))));
      }
      if (!result.key) return Effect.succeed("denied" as const);
      return resolveKey(result.key);
    }),
    Effect.catch(() => Effect.succeed("denied" as const)),
  );
};
