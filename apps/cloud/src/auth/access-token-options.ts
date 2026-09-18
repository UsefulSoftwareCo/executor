import type { JWTVerifyOptions } from "jose";

/**
 * Require expiring WorkOS tokens. Token lifetime is controlled by WorkOS via
 * `exp`; do not cap the age locally, since AuthKit issues MCP access tokens
 * that live for several days.
 */
export const workosAccessTokenOptions: JWTVerifyOptions = {
  algorithms: ["RS256"],
  requiredClaims: ["exp", "iat"],
};
