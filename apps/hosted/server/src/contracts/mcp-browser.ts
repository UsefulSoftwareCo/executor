/** Browser routing metadata. Identity always comes from the authenticated cookie, never from these fields. */
import { Schema } from "effect";
import { BrowserApprovalMode, BrowserSessionId } from "@executor-js/mcp/browser";
import { GrantId } from "@executor-js/mcp-auth";
export const HostedApprovalQuery = Schema.Struct({
  sessionId: BrowserSessionId,
  /** The grant, sealed by the host; links issued before references existed name it as `grantId`. */
  grant: Schema.optionalKey(Schema.NonEmptyString),
  grantId: Schema.optionalKey(GrantId),
  /** A caller-mode request that requires a person. */
  mode: Schema.optionalKey(BrowserApprovalMode),
});
