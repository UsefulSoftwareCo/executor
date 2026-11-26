import { Schema } from "effect";
import { BrowserSessionId } from "@executor-js/mcp/browser";
import { GrantId } from "@executor-js/mcp-auth";
export const HostedApprovalQuery = Schema.Struct({
  sessionId: BrowserSessionId,
  grantId: GrantId,
});
