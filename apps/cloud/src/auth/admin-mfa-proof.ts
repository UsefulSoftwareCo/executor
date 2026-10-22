import { Data, Effect, Option, Schema } from "effect";
import { SignJWT, jwtVerify } from "jose";

/** HttpOnly cookies used only for the administrative verification flow. */
export const ADMIN_MFA_COOKIE = "__Host-executor-admin-mfa";
/** The pending challenge is bound to the same user and WorkOS session. */
export const ADMIN_MFA_CHALLENGE_COOKIE = "__Host-executor-admin-challenge";
/** Verification is session-bound, with a seven-day maximum matching the login cookie. */
export const ADMIN_MFA_TTL_SECONDS = 7 * 24 * 60 * 60;

/** A verified WorkOS session, supplied by the authentication adapter. */
export interface AdminMfaIdentity {
  readonly userId: string;
  readonly sessionId: string;
}

const Proof = Schema.Struct({
  factorId: Schema.String,
  challengeId: Schema.String,
  mode: Schema.Literals(["enroll", "challenge"]),
  exp: Schema.Number,
});
const decodeProof = Schema.decodeUnknownOption(Proof);

/** Signing failures are server failures; invalid input cookies are simply refused. */
export class AdminMfaProofError extends Data.TaggedError("AdminMfaProofError")<{
  readonly cause: unknown;
}> {}

type Purpose = "challenge" | "verified";
const issuer = (purpose: Purpose) => `executor:admin-mfa:${purpose}`;
const key = (secret: string) => new TextEncoder().encode(secret);

/** Sign a purpose-specific, session-bound proof with an explicit expiration. */
export const signAdminMfaProof = (
  secret: string,
  identity: AdminMfaIdentity,
  purpose: Purpose,
  proof: typeof Proof.Type,
  now: number,
) =>
  Effect.tryPromise({
    try: () =>
      new SignJWT({ factorId: proof.factorId, challengeId: proof.challengeId, mode: proof.mode })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(issuer(purpose))
        .setSubject(identity.userId)
        .setAudience(identity.sessionId)
        .setIssuedAt(Math.floor(now / 1000))
        .setExpirationTime(proof.exp)
        .sign(key(secret)),
    catch: (cause) => new AdminMfaProofError({ cause }),
  });

/** Reject expired, tampered, cross-user, cross-session, and wrong-purpose proofs. */
export const readAdminMfaProof = (
  secret: string,
  identity: AdminMfaIdentity,
  purpose: Purpose,
  token: string | undefined,
  now: number,
): Effect.Effect<typeof Proof.Type | null> =>
  readAdminMfaProofDetails(secret, identity, purpose, token, now).pipe(
    Effect.map((details) => details?.proof ?? null),
  );

const readAdminMfaProofDetails = (
  secret: string,
  identity: AdminMfaIdentity,
  purpose: Purpose,
  token: string | undefined,
  now: number,
): Effect.Effect<{ readonly proof: typeof Proof.Type; readonly issuedAt: number } | null> => {
  if (!token) return Effect.succeed(null);
  return Effect.tryPromise({
    try: () =>
      jwtVerify(token, key(secret), {
        algorithms: ["HS256"],
        issuer: issuer(purpose),
        subject: identity.userId,
        audience: identity.sessionId,
        requiredClaims: ["exp", "iat", "sub", "aud"],
        maxTokenAge: purpose === "challenge" ? 300 : ADMIN_MFA_TTL_SECONDS,
        currentDate: new Date(now),
      }),
    catch: (cause) => new AdminMfaProofError({ cause }),
  }).pipe(
    Effect.map(({ payload }) => {
      const maxAge = purpose === "challenge" ? 300 : ADMIN_MFA_TTL_SECONDS;
      if (
        typeof payload.iat !== "number" ||
        typeof payload.exp !== "number" ||
        payload.exp > payload.iat + maxAge
      )
        return null;
      const proof = Option.getOrNull(decodeProof(payload));
      return proof === null ? null : { proof, issuedAt: payload.iat * 1000 };
    }),
    Effect.catchTag("AdminMfaProofError", () => Effect.succeed(null)),
  );
};

/**
 * A verified MFA cookie remains useful for the administrative unlock flow for
 * seven days, but delegation issuance and expansion require a fresh assurance
 * event. The age check uses the signed `iat` from the MFA proof itself; a
 * session-cookie timestamp is not an authentication event.
 */
export const readRecentAdminMfaProof = (
  secret: string,
  identity: AdminMfaIdentity,
  token: string | undefined,
  now: number,
  maxAgeMs: number,
): Effect.Effect<typeof Proof.Type | null> =>
  readAdminMfaProofDetails(secret, identity, "verified", token, now).pipe(
    Effect.map((details) =>
      details !== null && details.issuedAt <= now && now - details.issuedAt <= maxAgeMs
        ? details.proof
        : null,
    ),
  );
