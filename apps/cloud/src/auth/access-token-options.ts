import type { JWTVerifyOptions } from "jose";

/** WorkOS credentials may authorize a request for at most 24 hours after issuance. */
export const WORKOS_ACCESS_TOKEN_MAX_AGE_SECONDS = 24 * 60 * 60;

/** Require signed, expiring tokens and cap their effective lifetime even if the issuer sets a later exp. */
export const workosAccessTokenOptions: JWTVerifyOptions = {
  requiredClaims: ["exp", "iat"],
  maxTokenAge: WORKOS_ACCESS_TOKEN_MAX_AGE_SECONDS,
};
