import type { JWTVerifyOptions } from "jose";

/** Require expiring WorkOS tokens and cap local verification at 24 hours. */
export const workosAccessTokenOptions: JWTVerifyOptions = {
  requiredClaims: ["exp", "iat"],
  maxTokenAge: "24h",
};
