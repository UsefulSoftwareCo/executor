import {
  Grant,
  GrantId,
  type ApprovalMode,
  type McpWhoami,
  type ResourceOrigins,
} from "@executor-js/mcp-auth";
import type {
  Connection,
  ConnectionId,
  ConnectionIdTaken,
  ConnectionNotFound,
  ConnectionPolicy,
} from "@executor-js/mcp-auth/connections";
import type { ConnectedAgent, ConnectedAgentNotFound } from "@executor-js/mcp-auth/agents";
import { UserFacingError, type ErrorPresentation } from "@executor-js/utils/user-facing-error";
import { AuthorizationPolicy } from "@executor-js/authorization";
import { Context, Schema } from "effect";
import type { Effect } from "effect";
import { OrganizationAccess, type OrganizationReference } from "./organization.ts";
import { AuthenticationUnavailable } from "./auth.ts";

export const McpAccess = Schema.Struct({
  userId: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  access: OrganizationAccess,
  grant: Grant,
  policy: AuthorizationPolicy,
});
export type McpAccess = typeof McpAccess.Type;

export const CurrentMcpGrant = Context.Reference<GrantId | undefined>("hosted/CurrentMcpGrant", {
  defaultValue: () => undefined,
});

export const CurrentMcpSession = Context.Reference<string | undefined>("hosted/CurrentMcpSession", {
  defaultValue: () => undefined,
});

export const IssuedMcpSessionId = Schema.String.check(
  Schema.isPattern(
    /^(?:[0-9a-f]{64}\.[A-Za-z0-9_-]{43}\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  ),
);

export class McpUnauthorized extends Schema.TaggedError<McpUnauthorized>()("McpUnauthorized", {}) {}
export const McpForbiddenReason = Schema.Literals([
  "organization_required",
  "organization_mismatch",
  "membership",
  "toolkit",
]);
export type McpForbiddenReason = typeof McpForbiddenReason.Type;
const forbidden: { readonly [Reason in McpForbiddenReason]: ErrorPresentation } = {
  organization_required: {
    title: "Organization required",
    description:
      "This full-account token does not name an organization, so Executor cannot choose one for this MCP request.",
    recovery: {
      action:
        "Connect at /org/<organization>/mcp, or send the X-Executor-Organization header, then retry.",
      instructions:
        "A full-account personal access token works in every organization its user belongs to, so each MCP request must name one. Put the organization's ID or slug in the MCP URL path (/org/<organization>/mcp) or in the X-Executor-Organization header, reconnect, and verify that tools are listed.",
    },
  },
  organization_mismatch: {
    title: "Different organization",
    description:
      "This request names a different organization than its credential belongs to, or its URL and X-Executor-Organization header name different organizations.",
    recovery: {
      action: "Use the organization this credential belongs to in the URL and header, then retry.",
      instructions:
        "OAuth connections and organization-pinned tokens work only in their own organization. Make the organization in the MCP URL and in X-Executor-Organization agree with the credential, reconnect, and verify that tools are listed. To work in another organization, connect again from that organization. Do not bypass authorization.",
    },
  },
  membership: {
    title: "Organization access denied",
    description:
      "This account is not a member of the organization this MCP request uses, or that organization does not exist.",
    recovery: {
      action:
        "Check the organization name, and that this account still belongs to it. Copy the fix prompt into your agent to investigate the missing access.",
      instructions:
        "Check which account the credential belongs to and which organization the MCP URL, X-Executor-Organization header or connection names. Correct a wrong organization, or have an organization owner restore the account's membership. Do not bypass authorization or assume changing app code can grant access.",
    },
  },
  toolkit: {
    title: "Toolkit not available",
    description:
      "This Executor v1 toolkit URL names no toolkit of this account's in the organization, or the account's copy of it was removed.",
    recovery: {
      action: "Use the organization's MCP URL, or a connection made in Executor, then retry.",
      instructions:
        "Executor v1's toolkits became each member's own MCP connection when the organization moved. Check that this account was a member who had the toolkit, and that its connection still exists under Connections. Otherwise connect at the organization's MCP URL and verify that tools are listed. Do not bypass authorization.",
    },
  },
};
export const McpForbidden = UserFacingError.define({
  tag: "McpForbidden",
  status: 403,
  fields: { reason: McpForbiddenReason },
  recorded: ({ reason }) => forbidden[reason].description,
  presentation: ({ reason }) => forbidden[reason],
});
export type McpForbidden = typeof McpForbidden.Type;
export class McpApprovalForbidden extends Schema.TaggedError<McpApprovalForbidden>()(
  "McpApprovalForbidden",
  {},
) {}

export interface ConnectionOwner {
  readonly userId: string;
  readonly resource: string;
}
export interface McpConnectionStore {
  readonly list: (
    owner: ConnectionOwner,
  ) => Effect.Effect<readonly Connection[], AuthenticationUnavailable>;
  readonly create: (
    owner: ConnectionOwner,
    input: { readonly id: ConnectionId; readonly name: string; readonly policy: ConnectionPolicy },
  ) => Effect.Effect<Connection, ConnectionIdTaken | AuthenticationUnavailable>;
  readonly update: (
    owner: ConnectionOwner,
    input: { readonly id: ConnectionId; readonly name: string; readonly policy: ConnectionPolicy },
  ) => Effect.Effect<Connection, ConnectionNotFound | AuthenticationUnavailable>;
  readonly revoke: (
    owner: ConnectionOwner,
    id: ConnectionId,
  ) => Effect.Effect<ConnectionId, ConnectionNotFound | AuthenticationUnavailable>;
  readonly agents: (
    owner: ConnectionOwner,
  ) => Effect.Effect<readonly ConnectedAgent[], AuthenticationUnavailable>;
  readonly revokeAgent: (
    owner: ConnectionOwner,
    id: GrantId,
  ) => Effect.Effect<GrantId, ConnectedAgentNotFound | AuthenticationUnavailable>;
}

export class McpAuthentication extends Context.Service<
  McpAuthentication,
  {
    readonly origin: string;
    readonly resourceOrigins: ResourceOrigins;
    readonly issuer: string;
    readonly authenticate: (
      headers: Headers,
      mode?: ApprovalMode,
      organization?: OrganizationReference,
    ) => Effect.Effect<McpAccess, McpUnauthorized | McpForbidden | AuthenticationUnavailable>;
    readonly browserGrant: (
      headers: Headers,
      id: GrantId,
    ) => Effect.Effect<
      McpAccess,
      McpUnauthorized | McpApprovalForbidden | AuthenticationUnavailable
    >;
    readonly describe: (
      access: McpAccess,
    ) => Effect.Effect<McpWhoami, McpUnauthorized | AuthenticationUnavailable>;
    readonly metadata: Effect.Effect<unknown, AuthenticationUnavailable>;
    readonly connections: McpConnectionStore;
  }
>()("hosted/McpAuthentication") {}
