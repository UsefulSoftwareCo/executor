import { createHash, createHmac } from "node:crypto";
import { Schema } from "effect";
import { heldValue } from "./failure-text.ts";

export const V1McpForwardSecret = Schema.Struct({ secret: heldValue(Schema.String) });
export const v1McpForwardFile = "v1-mcp-forward.json";

export const v1ToolkitConnectionId = (organization: string, toolkit: string, member: string) =>
  `v1-${createHash("sha256")
    .update(JSON.stringify([organization, toolkit, member]))
    .digest("hex")
    .slice(0, 40)}`;

export interface V1ForwardClaims {
  readonly account: string;
  readonly organization: string;
  readonly exp: number;
  readonly toolkit?: string;
  readonly connection?: string;
}

export const v1ForwardBearer = (secret: string, claims: V1ForwardClaims) => {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...claims })).toString("base64url");
  const signature = createHmac("sha256", secret).update(`v1fwd.${payload}`).digest("base64url");
  return `v1fwd.${payload}.${signature}`;
};
