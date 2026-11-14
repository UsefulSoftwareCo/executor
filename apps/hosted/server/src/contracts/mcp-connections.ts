/**
 * A member's own scoped MCP connections and connected agents in one organization. A member lists,
 * creates, updates and revokes their own connections, and mints and revokes keys on them, from a
 * browser session or from an API key or full API grant that carries their authority. Each saved
 * entry is limited to apps the member can use and accounts the member can use. Another member's
 * connections are omitted and cannot be changed. Connected agents stay browser-only.
 */
import {
  AccountNotFound,
  AccountSelectionInvalid,
  AppNotFound,
  StorageError,
} from "@executor-js/sdk/core";
import {
  ConnectionAccessInvalid,
  ConnectionId,
  ConnectionIdTaken,
  ConnectionInput,
  ConnectionName,
  ConnectionNotFound,
  ConnectionView,
} from "@executor-js/mcp-auth/connections";
import { ConnectedAgent, ConnectedAgentNotFound } from "@executor-js/mcp-auth/agents";
import { GrantId } from "@executor-js/mcp-auth";
import { ApiError } from "@executor-js/utils/api-error";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AuthenticationUnavailable, RequireBrowserSession } from "./auth.ts";
import { RequiredAction } from "./authorization.ts";
import {
  OrganizationForbidden,
  OrganizationReference,
  RequireOrganization,
} from "./organization.ts";

const path = "/api/organizations/:organization/mcp-connections";
const organization = { organization: OrganizationReference };
const connection = { ...organization, connection: ConnectionId };
const agentsPath = "/api/organizations/:organization/mcp-agents";
const errors = [AuthenticationUnavailable, OrganizationForbidden] as const;
/** Saving may link accounts to apps, so it reports account failures. */
const saveErrors = [
  ...errors,
  ConnectionAccessInvalid,
  StorageError,
  AppNotFound,
  AccountNotFound,
  AccountSelectionInvalid,
] as const;
/** The longest a connection key may live: 90 days. */
export const connectionKeyMaxSeconds = 90 * 24 * 60 * 60;
/** A connection key always expires, between 5 seconds and 90 days after it is minted. */
export const ConnectionKeyInput = Schema.Struct({
  name: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80), Schema.isPattern(/\S/u)),
  ),
  expiresInSeconds: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(5),
    Schema.isLessThanOrEqualTo(connectionKeyMaxSeconds),
  ),
});
/**
 * A key bound to one scoped connection. The secret is returned only here. It works only at the
 * connection's `url`, never with the API, and dies with the connection or at `expiresAt`.
 */
export const ConnectionKey = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  connection: ConnectionId,
  url: Schema.String,
  expiresAt: Schema.String,
});
/**
 * A key bound to one scoped connection, as its owner lists it: never the secret. `start` is the
 * key's first characters, so the owner can tell which installed key it is.
 */
export const ConnectionKeySummary = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  start: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  /** When the key was last used, when its store records it. */
  lastRequest: Schema.NullOr(Schema.String),
});
export type ConnectionKeySummary = typeof ConnectionKeySummary.Type;
/** The connection has no such key: it was revoked, or belongs to another connection or user. */
export const ConnectionKeyNotFound = ApiError.define({
  tag: "ConnectionKeyNotFound",
  status: 404,
  fields: { key: Schema.String },
  message: "This connection key was revoked or does not belong to this connection.",
});
export type ConnectionKeyNotFound = typeof ConnectionKeyNotFound.Type;
/**
 * The API refuses MCP tokens. An Executor app self-call is the caller's managed key plus the
 * connection the host attached. That connection's policy is the authority: create, update and
 * mint stay within its apps, tools and runsAs accounts, with no all-apps escalation. A narrowed
 * connection without manage is refused. A key's lifetime stays within 5 seconds and 90 days.
 */
export const HostedMcpConnections = HttpApiGroup.make("mcpConnections")
  .add(
    HttpApiEndpoint.get("list", path, {
      params: organization,
      success: Schema.Array(ConnectionView),
      error: errors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("create", path, {
      params: organization,
      payload: ConnectionInput,
      success: ConnectionView,
      error: [...saveErrors, ConnectionIdTaken],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.put("update", `${path}/:connection`, {
      params: connection,
      payload: Schema.Struct({
        name: ConnectionName,
        apps: ConnectionInput.fields.apps,
      }),
      success: ConnectionView,
      error: [...saveErrors, ConnectionNotFound],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("revoke", `${path}/:connection/revoke`, {
      params: connection,
      success: Schema.Void,
      error: [...errors, ConnectionNotFound],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("mintKey", `${path}/:connection/keys`, {
      params: connection,
      payload: ConnectionKeyInput,
      success: ConnectionKey,
      error: [...errors, ConnectionNotFound],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.get("listKeys", `${path}/:connection/keys`, {
      params: connection,
      success: Schema.Array(ConnectionKeySummary),
      error: [...errors, ConnectionNotFound],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("revokeKey", `${path}/:connection/keys/:key/revoke`, {
      params: { ...connection, key: Schema.NonEmptyString },
      success: Schema.Void,
      error: [...errors, ConnectionNotFound, ConnectionKeyNotFound],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.get("agents", agentsPath, {
      params: organization,
      success: Schema.Array(ConnectedAgent),
      error: errors,
    })
      .annotate(RequiredAction, "manage")
      .middleware(RequireBrowserSession),
  )
  .add(
    HttpApiEndpoint.post("revokeAgent", `${agentsPath}/:agent/revoke`, {
      params: { ...organization, agent: GrantId },
      success: Schema.Void,
      error: [...errors, ConnectedAgentNotFound],
    })
      .annotate(RequiredAction, "manage")
      .middleware(RequireBrowserSession),
  )
  .middleware(RequireOrganization);
