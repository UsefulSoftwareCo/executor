/** A member's own scoped MCP connections and connected agents in one organization. Browser sessions only. */
import {
  AccountNotFound,
  AccountSelectionInvalid,
  AppNotFound,
  ProfileErrors,
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
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AuthenticationUnavailable, RequireUser } from "./auth.ts";
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
/** Saving may create profiles for bare accounts, so it reports profile and account failures. */
const saveErrors = [
  ...errors,
  ConnectionAccessInvalid,
  StorageError,
  AppNotFound,
  AccountNotFound,
  AccountSelectionInvalid,
  ...ProfileErrors,
] as const;
/** Bearer credentials, including a connection's own grants, cannot manage connections. */
export const HostedMcpConnections = HttpApiGroup.make("mcpConnections")
  .add(
    HttpApiEndpoint.get("list", path, {
      params: organization,
      success: Schema.Array(ConnectionView),
      error: errors,
    })
      .annotate(RequiredAction, "manage")
      .middleware(RequireUser),
  )
  .add(
    HttpApiEndpoint.post("create", path, {
      params: organization,
      payload: ConnectionInput,
      success: ConnectionView,
      error: [...saveErrors, ConnectionIdTaken],
    })
      .annotate(RequiredAction, "manage")
      .middleware(RequireUser),
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
    })
      .annotate(RequiredAction, "manage")
      .middleware(RequireUser),
  )
  .add(
    HttpApiEndpoint.post("revoke", `${path}/:connection/revoke`, {
      params: connection,
      success: Schema.Void,
      error: [...errors, ConnectionNotFound],
    })
      .annotate(RequiredAction, "manage")
      .middleware(RequireUser),
  )
  .add(
    HttpApiEndpoint.get("agents", agentsPath, {
      params: organization,
      success: Schema.Array(ConnectedAgent),
      error: errors,
    })
      .annotate(RequiredAction, "manage")
      .middleware(RequireUser),
  )
  .add(
    HttpApiEndpoint.post("revokeAgent", `${agentsPath}/:agent/revoke`, {
      params: { ...organization, agent: GrantId },
      success: Schema.Void,
      error: [...errors, ConnectedAgentNotFound],
    })
      .annotate(RequiredAction, "manage")
      .middleware(RequireUser),
  )
  .middleware(RequireOrganization);
