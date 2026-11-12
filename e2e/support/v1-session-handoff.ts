import { createHmac, randomBytes } from "node:crypto";
import { Schema } from "effect";
import { heldValue } from "./failure-text.ts";

/** The secret a managed Cloud run shares with its synthetic v1 for session handoffs. */
export const V1SessionHandoffSecret = Schema.Struct({ secret: heldValue(Schema.String) });
/** Where a managed Cloud run records the secret it verifies v1 session handoffs with. */
export const v1SessionHandoffFile = "v1-session-handoff.json";

/** What v1 vouches for in a session handoff; times are Unix seconds. */
export interface V1HandoffClaims {
  readonly user: string;
  readonly organization: string;
  readonly slug: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
  readonly v?: number;
  readonly aud?: string;
}

/** A handoff token as v1's dashboard signs it, before redirecting a moved workspace's member. */
export const v1HandoffToken = (secret: string, claims: V1HandoffClaims) => {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, aud: "v2-session-handoff", ...claims }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(`v1hnd.${payload}`).digest("base64url");
  return `v1hnd.${payload}.${signature}`;
};

/** A fresh token id, as v1 draws one for each handoff. */
export const v1HandoffId = () => randomBytes(18).toString("base64url");
