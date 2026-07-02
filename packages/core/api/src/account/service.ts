import { Context, type Effect } from "effect";

import {
  type AccountError,
  type AccountForbidden,
  type AccountNoOrganization,
  type AccountUnauthorized,
  AccountMeResponse,
  ApiKeysResponse,
  CreatedApiKeyResponse,
  OrgMembersResponse,
  OrgRolesResponse,
  InviteMemberResponse,
  InviteMemberBody,
  SuccessResponse,
  UpdateOrgNameResponse,
} from "./api";

// ---------------------------------------------------------------------------
// AccountProvider — the provider seam behind the neutral Account API.
//
// The shared `AccountHandlers` (account/handlers.ts) are generic: they read the
// request headers and delegate to this service, mapping nothing. Each product
// provides its own implementation:
//   - self-host  → Better Auth (auth.api.*)
//   - cloud      → WorkOS
// This is the server-side analog of the client's neutral contract: one set of
// handlers, two implementations. Methods take the raw request headers (cookie /
// bearer / api-key) so the implementation can act as the calling user.
// ---------------------------------------------------------------------------

export type AccountHeaders = Record<string, string>;

type Me = typeof AccountMeResponse.Type;
type ApiKeys = typeof ApiKeysResponse.Type;
type CreatedApiKey = typeof CreatedApiKeyResponse.Type;
type Members = typeof OrgMembersResponse.Type;
type Roles = typeof OrgRolesResponse.Type;
type Invite = typeof InviteMemberResponse.Type;
type InviteBody = typeof InviteMemberBody.Type;
type Success = typeof SuccessResponse.Type;
type OrgName = typeof UpdateOrgNameResponse.Type;

type Authed<A, E = never> = Effect.Effect<A, AccountError | AccountUnauthorized | E>;
type OrgScoped<A, E = never> = Authed<A, AccountNoOrganization | E>;

export interface AccountProviderShape {
  readonly me: (headers: AccountHeaders) => Authed<Me>;
  readonly listApiKeys: (headers: AccountHeaders) => OrgScoped<ApiKeys>;
  readonly createApiKey: (headers: AccountHeaders, name: string) => OrgScoped<CreatedApiKey>;
  readonly revokeApiKey: (headers: AccountHeaders, apiKeyId: string) => OrgScoped<Success>;
  readonly listMembers: (headers: AccountHeaders) => OrgScoped<Members>;
  readonly listRoles: (headers: AccountHeaders) => OrgScoped<Roles>;
  readonly inviteMember: (
    headers: AccountHeaders,
    body: InviteBody,
  ) => OrgScoped<Invite, AccountForbidden>;
  readonly removeMember: (
    headers: AccountHeaders,
    membershipId: string,
  ) => OrgScoped<Success, AccountForbidden>;
  readonly updateMemberRole: (
    headers: AccountHeaders,
    membershipId: string,
    roleSlug: string,
  ) => OrgScoped<Success, AccountForbidden>;
  readonly updateOrgName: (
    headers: AccountHeaders,
    name: string,
  ) => OrgScoped<OrgName, AccountForbidden>;
}

export class AccountProvider extends Context.Service<AccountProvider, AccountProviderShape>()(
  "@executor-js/api/AccountProvider",
) {}
