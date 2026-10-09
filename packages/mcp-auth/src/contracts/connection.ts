/**
 * Scoped connections: a user's named, revocable MCP access boundary. Grants issued through a
 * connection's URL take their authority from the current connection record on every request.
 */
import { EventScope, RunTarget, ToolScope, type AppPermission } from "@executor-js/authorization";
import { ApiError } from "@executor-js/utils/api-error";
import {
  AccountId,
  AppId,
  type AppRequirements,
  type ProviderId,
  type SelectedAccounts,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { ConnectionId, GrantPolicy } from "./grant.ts";
export { ConnectionId } from "./grant.ts";

/** Display name chosen by the user; not an identity. */
export const ConnectionName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/\S/u),
);
/** One included app. Runs-as targets are exact; everything not included is excluded. */
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
  name: ConnectionName,
  policy: ConnectionPolicy,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Connection = typeof Connection.Type;

/**
 * A runs-as choice while editing. A bare account becomes a saved profile for that app
 * before the connection is stored; stored connections only reference profiles.
 */
export const ConnectionTargetInput = Schema.Union([
  RunTarget,
  Schema.Struct({ kind: Schema.Literal("account"), id: AccountId }),
]);
export type ConnectionTargetInput = typeof ConnectionTargetInput.Type;
/** One app as submitted by the editor. */
export const ConnectionAppInput = Schema.Struct({
  app: AppId,
  runsAs: Schema.NonEmptyArray(ConnectionTargetInput),
  tools: ToolScope,
  events: Schema.optionalKey(EventScope),
});
export type ConnectionAppInput = typeof ConnectionAppInput.Type;
/**
 * Create or replace a connection's name and access. The client chooses the ID once per
 * editor so a retried create returns the same connection and the same new profiles.
 */
export const ConnectionInput = Schema.Struct({
  id: ConnectionId,
  name: ConnectionName,
  apps: Schema.Array(ConnectionAppInput).check(
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
  profile: "names a profile that is not available to this user",
  account: "names an account that is not available to this user",
  target: "names a target that is not available to this user",
} as const;
/** An app, profile, or account in the request is not available to this user. */
export const ConnectionAccessInvalid = ApiError.define({
  tag: "ConnectionAccessInvalid",
  status: 400,
  fields: { app: AppId, reason: Schema.Literals(["app", "profile", "account", "target"]) },
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

/**
 * The saved selections for a new profile that runs an app as one bare account: every slot
 * for that account's provider. Undefined when the app has no slot the account can fill.
 */
export const bareAccountSelection = (
  requirements: AppRequirements["accounts"],
  account: { readonly id: AccountId; readonly provider: ProviderId },
): SelectedAccounts | undefined => {
  const slots = Object.entries(requirements).filter(
    ([, requirement]) => requirement.provider === account.provider,
  );
  if (slots.length === 0) return undefined;
  return Object.fromEntries(
    slots.map(([slot, requirement]) => [
      slot,
      requirement.cardinality === "many" ? [account.id] : account.id,
    ]),
  );
};
/**
 * Retrying the same save reuses the profile created for this connection and account. Profile
 * keys are unique per app and subject, so the app is implied and the key fits its 128 limit.
 */
export const bareAccountProfileKey = (connection: ConnectionId, account: AccountId) =>
  `connection:${connection}:${account}`;
