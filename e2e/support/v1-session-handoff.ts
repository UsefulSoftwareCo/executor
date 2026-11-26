import { createHmac, randomBytes } from "node:crypto";
import { Schema } from "effect";
import { heldValue } from "./failure-text.ts";

export const V1SessionHandoffSecret = Schema.Struct({ secret: heldValue(Schema.String) });
export const v1SessionHandoffFile = "v1-session-handoff.json";

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

export const v1HandoffToken = (secret: string, claims: V1HandoffClaims) => {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, aud: "v2-session-handoff", ...claims }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(`v1hnd.${payload}`).digest("base64url");
  return `v1hnd.${payload}.${signature}`;
};

export const v1HandoffId = () => randomBytes(18).toString("base64url");
