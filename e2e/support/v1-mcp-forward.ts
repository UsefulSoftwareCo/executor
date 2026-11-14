import { createHash, createHmac } from "node:crypto";
import { Schema } from "effect";
import { heldValue } from "./failure-text.ts";

/** The secret a managed Cloud run shares with its synthetic v1, kept in the run directory. */
export const V1McpForwardSecret = Schema.Struct({ secret: heldValue(Schema.String) });
/** Where a managed Cloud run records the secret it verifies forwarded v1 bearers with. */
export const v1McpForwardFile = "v1-mcp-forward.json";

/**
 * The v2 connection id of a member's copy of a v1 toolkit in a v2 organization, as v1 computes it
 * from the moved flag's organization, the toolkit's row and the caller's WorkOS user id.
 */
export const v1ToolkitConnectionId = (organization: string, toolkit: string, member: string) =>
  `v1-${createHash("sha256")
    .update(JSON.stringify([organization, toolkit, member]))
    .digest("hex")
    .slice(0, 40)}`;

/** What v1 vouches for in a forwarded bearer; `exp` is in Unix seconds. */
export interface V1ForwardClaims {
  readonly account: string;
  readonly organization: string;
  readonly exp: number;
  readonly toolkit?: string;
  readonly connection?: string;
}

/** A bearer as v1 signs it for one forwarded request. */
export const v1ForwardBearer = (secret: string, claims: V1ForwardClaims) => {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...claims })).toString("base64url");
  const signature = createHmac("sha256", secret).update(`v1fwd.${payload}`).digest("base64url");
  return `v1fwd.${payload}.${signature}`;
};
