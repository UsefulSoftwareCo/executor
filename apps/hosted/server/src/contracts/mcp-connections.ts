/** A member's own scoped MCP connections and connected agents in one organization. Browser sessions only. */
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
/**
 * Agents may list the member's connections. Bearer credentials, including a connection's own
 * grants, cannot change them or the connected agents: that would let an agent widen its own access.
 */
export const HostedMcpConnections = HttpApiGroup.make("mcpConnections")
  .add(
    HttpApiEndpoint.get("list", path, {
      params: organization,
      success: Schema.Array(ConnectionView),
      error: errors,
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.post("create", path, {
      params: organization,
      payload: ConnectionInput,
      success: ConnectionView,
      error: [...saveErrors, ConnectionIdTaken],
    })
      .annotate(RequiredAction, "manage")
      .middleware(RequireBrowserSession),
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
      .middleware(RequireBrowserSession),
  )
  .add(
    HttpApiEndpoint.post("revoke", `${path}/:connection/revoke`, {
      params: connection,
      success: Schema.Void,
      error: [...errors, ConnectionNotFound],
    })
      .annotate(RequiredAction, "manage")
      .middleware(RequireBrowserSession),
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
