import { Grant, GrantId, type ApprovalMode } from "@executor-js/mcp-auth";
import { Context, Schema } from "effect";
import type { Effect } from "effect";
import { OrganizationAccess, type OrganizationReference } from "./organization.ts";
import { AuthenticationUnavailable } from "./auth.ts";

/** MCP authority from OAuth or a PAT and current membership. Tokens never become browser sessions. */
export const McpAccess = Schema.Struct({
  userId: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  access: OrganizationAccess,
  grant: Grant,
});
export type McpAccess = typeof McpAccess.Type;

/** Invalid/revoked bearer grants need a fresh OAuth connection. */
export class McpUnauthorized extends Schema.TaggedError<McpUnauthorized>()("McpUnauthorized", {}) {}
/** A valid grant no longer has access to its organization. */
export class McpForbidden extends Schema.TaggedError<McpForbidden>()("McpForbidden", {}) {}

/** Better Auth owns grant validation; each host supplies its native request lifetime. */
export class McpAuthentication extends Context.Service<
  McpAuthentication,
  {
    readonly origin: string;
    readonly authenticate: (
      headers: Headers,
      mode?: ApprovalMode,
      organization?: OrganizationReference,
    ) => Effect.Effect<McpAccess, McpUnauthorized | McpForbidden | AuthenticationUnavailable>;
    readonly browserGrant: (
      headers: Headers,
      id: GrantId,
    ) => Effect.Effect<McpAccess, McpUnauthorized | McpForbidden | AuthenticationUnavailable>;
    readonly metadata: Effect.Effect<unknown, AuthenticationUnavailable>;
  }
>()("hosted/McpAuthentication") {}
