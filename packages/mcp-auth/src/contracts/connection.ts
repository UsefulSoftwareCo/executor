import { EventScope, RunTarget, ToolScope, type AppPermission } from "@executor-js/authorization";
import { ApiError } from "@executor-js/utils/api-error";
import { AppId } from "@executor-js/sdk/core";
import { Schema } from "effect";
import { ConnectionId, GrantPolicy } from "./grant.ts";
export { ConnectionId } from "./grant.ts";

export const ConnectionName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/\S/u),
);
export const ConnectionApp = Schema.Struct({
  app: AppId,
  runsAs: Schema.NonEmptyArray(RunTarget),
  tools: ToolScope,
  events: Schema.optionalKey(EventScope),
});
export type ConnectionApp = typeof ConnectionApp.Type;
const uniqueApps = (apps: readonly { readonly app: AppId }[]) =>
  new Set(apps.map((item) => item.app)).size === apps.length;
export const ConnectionPolicy = Schema.Struct({
  apps: Schema.Array(ConnectionApp).check(
    Schema.makeFilter(uniqueApps, { message: "Each app can appear once in a connection" }),
  ),
});
export type ConnectionPolicy = typeof ConnectionPolicy.Type;
export const Connection = Schema.Struct({
  id: ConnectionId,
  name: ConnectionName,
  policy: ConnectionPolicy,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Connection = typeof Connection.Type;

export const ConnectionInput = Schema.Struct({
  id: ConnectionId,
  name: ConnectionName,
  apps: Schema.Array(ConnectionApp).check(
    Schema.makeFilter(uniqueApps, { message: "Each app can appear once in a connection" }),
  ),
});
export type ConnectionInput = typeof ConnectionInput.Type;
export const ConnectionView = Schema.Struct({ ...Connection.fields, url: Schema.String });
export type ConnectionView = typeof ConnectionView.Type;

export const ConnectionNotFound = ApiError.define({
  tag: "ConnectionNotFound",
  status: 404,
  fields: { connection: ConnectionId },
  message: ({ connection }) => `No MCP connection “${connection}” exists for this user.`,
  recorded: () => "No MCP connection with the requested ID exists for this user",
});
export type ConnectionNotFound = typeof ConnectionNotFound.Type;
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
export const ConnectionAccessInvalid = ApiError.define({
  tag: "ConnectionAccessInvalid",
  status: 400,
  fields: { app: AppId, reason: Schema.Literals(["app", "account", "target"]) },
  message: ({ app, reason }) =>
    `The connection's entry for app ${app} ${connectionAccessFailures[reason]}.`,
  recorded: ({ reason }) => `The connection's entry for an app ${connectionAccessFailures[reason]}`,
});
export type ConnectionAccessInvalid = typeof ConnectionAccessInvalid.Type;

export const connectionPermissions = (policy: ConnectionPolicy): readonly AppPermission[] =>
  policy.apps.map((item) => ({
    app: item.app,
    tools: item.tools,
    ...(item.events === undefined ? {} : { events: item.events }),
    targets: item.runsAs,
  }));
export const connectionGrantPolicy = (policy: ConnectionPolicy): GrantPolicy => ({
  kind: "tools",
  apps: connectionPermissions(policy),
  approval: "client",
});
export const connectionGrantPlaceholder: GrantPolicy = {
  kind: "tools",
  apps: [],
  approval: "client",
};
