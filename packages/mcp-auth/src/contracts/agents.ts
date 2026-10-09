/**
 * Connected agents: the OAuth clients a user authorized, one per grant that still holds a usable
 * token. Revoking one ends its grant and deletes its tokens; the client must authorize again to
 * reconnect.
 */
import { ApiError } from "@executor-js/utils/api-error";
import { Schema } from "effect";
import { ConnectionName } from "./connection.ts";
import { ApprovalMode, ConnectionId, GrantId } from "./grant.ts";

/** What the grant lets the agent reach, as the user approved it. */
export const ConnectedAgentAccess = Schema.Union([
  /** Every app the user can use, through the plain MCP URL. */
  Schema.Struct({ kind: Schema.Literal("all") }),
  /** Tools of the listed number of apps, chosen on the consent page. */
  Schema.Struct({ kind: Schema.Literal("tools"), apps: Schema.Number }),
  /** Whatever the named scoped connection currently allows. */
  Schema.Struct({
    kind: Schema.Literal("connection"),
    connection: ConnectionId,
    name: ConnectionName,
  }),
  /** The Executor HTTP API rather than MCP. */
  Schema.Struct({ kind: Schema.Literal("api") }),
]);
export type ConnectedAgentAccess = typeof ConnectedAgentAccess.Type;

/** One authorized client. Its name is self-declared at registration, so it is not an identity. */
export const ConnectedAgent = Schema.Struct({
  id: GrantId,
  name: Schema.NullOr(Schema.String),
  connectedAt: Schema.String,
  /**
   * When the client last received an access token, by sign-in or refresh; tokens last an hour,
   * so this is coarse. Null when it holds only a refresh token whose access tokens are gone.
   */
  lastActiveAt: Schema.NullOr(Schema.String),
  access: ConnectedAgentAccess,
  /** How tool approvals reach the user; absent for API grants. */
  mode: Schema.optionalKey(ApprovalMode),
});
export type ConnectedAgent = typeof ConnectedAgent.Type;

/** The grant does not exist, is already revoked, or belongs to someone else. */
export const ConnectedAgentNotFound = ApiError.define({
  tag: "ConnectedAgentNotFound",
  status: 404,
  fields: { agent: GrantId },
  message: "This agent is no longer connected.",
});
export type ConnectedAgentNotFound = typeof ConnectedAgentNotFound.Type;
