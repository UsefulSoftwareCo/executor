import { ApiError } from "@executor-js/utils/api-error";
import { Schema } from "effect";
import { ConnectionName } from "./connection.ts";
import { ApprovalMode, ConnectionId, GrantId } from "./grant.ts";

export const ConnectedAgentAccess = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("tools"), apps: Schema.Number }),
  Schema.Struct({
    kind: Schema.Literal("connection"),
    connection: ConnectionId,
    name: ConnectionName,
  }),
  Schema.Struct({ kind: Schema.Literal("api") }),
]);
export type ConnectedAgentAccess = typeof ConnectedAgentAccess.Type;

export const ConnectedAgent = Schema.Struct({
  id: GrantId,
  name: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String),
  connectedAt: Schema.String,
  lastActiveAt: Schema.NullOr(Schema.String),
  access: ConnectedAgentAccess,
  mode: Schema.optionalKey(ApprovalMode),
});
export type ConnectedAgent = typeof ConnectedAgent.Type;

export const ConnectedAgentNotFound = ApiError.define({
  tag: "ConnectedAgentNotFound",
  status: 404,
  fields: { agent: GrantId },
  message: "This agent is no longer connected.",
});
export type ConnectedAgentNotFound = typeof ConnectedAgentNotFound.Type;
