/**
 * Scoped connections: a user's named, revocable MCP access boundary. Grants issued through a
 * connection's URL take their authority from the current connection record on every request.
 */
import { EventScope, RunTarget, ToolScope, type AppPermission } from "@executor-js/authorization";
import { ApiError } from "@executor-js/utils/api-error";
import { AppId } from "@executor-js/sdk/core";
import { Schema } from "effect";
import { ConnectionId, GrantPolicy } from "./grant.ts";
export { ConnectionId } from "./grant.ts";

/** A name already saved, read back as it was written. Rows from before `ConnectionName` tightened stay readable. */
export const SavedConnectionName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/\S/u),
);
/**
 * Display name chosen by the user; not an identity. A new name is one line of text with a visible
 * character. Storage cannot hold NUL, so it is refused here as a bad request instead of surfacing
 * as a failed sign-in; a line break splits the connection's title, and a name made only of
 * invisible characters (zero-width space, joiner) lists as blank. `\s` does not match those.
 */
export const ConnectionName = SavedConnectionName.check(
  Schema.isPattern(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u),
  Schema.isPattern(/[^\s\p{Cc}\p{Cf}]/u),
);
/**
 * One included app. Runs-as targets are exact: the account-free app, or accounts the user linked
 * to it. Everything not included is excluded.
 */
export const ConnectionApp = Schema.Struct({
  app: AppId,
  runsAs: Schema.NonEmptyArray(RunTarget),
  tools: ToolScope,
  /** Omitted: every event the app declares, now or later. */
  events: Schema.optionalKey(EventScope),
});
export type ConnectionApp = typeof ConnectionApp.Type;
const uniqueApps = (apps: readonly { readonly app: AppId }[]) =>
  new Set(apps.map((item) => item.app)).size === apps.length;
/** Stored policy. Each app appears once, so its targets and tool scope are one decision. */
export const ConnectionPolicy = Schema.Struct({
  apps: Schema.Array(ConnectionApp).check(
    Schema.makeFilter(uniqueApps, { message: "Each app can appear once in a connection" }),
  ),
});
export type ConnectionPolicy = typeof ConnectionPolicy.Type;
/** A live connection owned by the current user in one organization (or the local instance). */
export const Connection = Schema.Struct({
  id: ConnectionId,
  name: SavedConnectionName,
  policy: ConnectionPolicy,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Connection = typeof Connection.Type;

/**
 * Create or replace a connection's name and access. The client chooses the ID once per
 * editor so a retried create returns the same connection.
 */
export const ConnectionInput = Schema.Struct({
  id: ConnectionId,
  name: ConnectionName,
  apps: Schema.Array(ConnectionApp).check(
    Schema.makeFilter(uniqueApps, { message: "Each app can appear once in a connection" }),
  ),
});
export type ConnectionInput = typeof ConnectionInput.Type;
/** A connection with the MCP URL that issues grants bound to it. */
export const ConnectionView = Schema.Struct({ ...Connection.fields, url: Schema.String });
export type ConnectionView = typeof ConnectionView.Type;

/** The connection does not exist, is revoked, or belongs to someone else. */
export const ConnectionNotFound = ApiError.define({
  tag: "ConnectionNotFound",
  status: 404,
  fields: { connection: ConnectionId },
  message: ({ connection }) => `No MCP connection “${connection}” exists for this user.`,
  recorded: () => "No MCP connection with the requested ID exists for this user",
});
export type ConnectionNotFound = typeof ConnectionNotFound.Type;
/** Another user, organization, or a revoked connection already uses this client-chosen ID. */
export const ConnectionIdTaken = ApiError.define({
  tag: "ConnectionIdTaken",
  status: 409,
  fields: { connection: ConnectionId },
  message: ({ connection }) =>
    `The MCP connection ID “${connection}” is already in use. Choose another ID.`,
  recorded: () => "The requested MCP connection ID is already in use",
});
export type ConnectionIdTaken = typeof ConnectionIdTaken.Type;
const connectionAccessFailures = {
  app: "is not available to this user",
  account: "names an account that is not available to this user",
  target: "names a target that is not available to this user",
} as const;
/** An app or account in the request is not available to this user. */
export const ConnectionAccessInvalid = ApiError.define({
  tag: "ConnectionAccessInvalid",
  status: 400,
  fields: { app: AppId, reason: Schema.Literals(["app", "account", "target"]) },
  message: ({ app, reason }) =>
    `The connection's entry for app ${app} ${connectionAccessFailures[reason]}.`,
  recorded: ({ reason }) => `The connection's entry for an app ${connectionAccessFailures[reason]}`,
});
export type ConnectionAccessInvalid = typeof ConnectionAccessInvalid.Type;

/** The connection's apps as shared authorization permissions. Targets are always explicit. */
export const connectionPermissions = (policy: ConnectionPolicy): readonly AppPermission[] =>
  policy.apps.map((item) => ({
    app: item.app,
    tools: item.tools,
    ...(item.events === undefined ? {} : { events: item.events }),
    targets: item.runsAs,
  }));
/**
 * The grant policy a connection currently authorizes. Approval delivery follows the MCP URL,
 * exactly as for a full-access grant; approval rules stay in each app's code.
 */
export const connectionGrantPolicy = (policy: ConnectionPolicy): GrantPolicy => ({
  kind: "tools",
  apps: connectionPermissions(policy),
  approval: "client",
});
/** Stored on a connection's grant row. Authority comes from the connection; this grants nothing. */
export const connectionGrantPlaceholder: GrantPolicy = {
  kind: "tools",
  apps: [],
  approval: "client",
};
