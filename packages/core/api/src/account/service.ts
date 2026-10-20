import { Context, type Effect } from "effect";

import {
  type AccountBadRequest,
  type AccountConflict,
  type AccountError,
  type AccountForbidden,
  type AccountNoOrganization,
  type AccountUnauthorized,
  AccountMeResponse,
  ApiKeysResponse,
  OrgApiKeysResponse,
  CreatedApiKeyResponse,
  OrgMembersResponse,
  OrgRolesResponse,
  InviteMemberResponse,
  InviteMemberBody,
  SuccessResponse,
  UpdateOrgNameResponse,
  DelegatedCredentialsResponse,
  DelegatedTargetsResponse,
  DelegationScopeOptionsResponse,
  CreateDelegatedKeyBody,
  CreatedDelegatedKeyResponse,
  StartDelegationChallengeBody,
  DelegationChallengeResponse,
  CompleteDelegationProofBody,
  ConsentDelegationBody,
  DelegatedCredentialSummary,
  RotateDelegatedKeyResponse,
  RevokeAllDelegatedCredentialsBody,
  RevokeAllDelegatedCredentialsResponse,
  DelegationAuditResponse,
  DelegationNotificationsResponse,
  DelegatedCredentialsQuery,
  DelegationAuditQuery,
  DelegationScopeOptionsQuery,
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

/** Request metadata needed by delegated-credential policy checks. */
export interface DelegationRequestContext {
  readonly headers: AccountHeaders;
  readonly requestOrigin: string;
  readonly browserOrigin: string | null;
  /** HTTP verb for host CSRF policy. Origin-less browser reads are allowed;
   * mutations still require an explicit same-origin Origin header. */
  readonly method?: string;
}

type Me = typeof AccountMeResponse.Type;
type ApiKeys = typeof ApiKeysResponse.Type;
type OrgApiKeys = typeof OrgApiKeysResponse.Type;
type CreatedApiKey = typeof CreatedApiKeyResponse.Type;
type Members = typeof OrgMembersResponse.Type;
type Roles = typeof OrgRolesResponse.Type;
type Invite = typeof InviteMemberResponse.Type;
type InviteBody = typeof InviteMemberBody.Type;
type Success = typeof SuccessResponse.Type;
type OrgName = typeof UpdateOrgNameResponse.Type;
type DelegatedCredentials = typeof DelegatedCredentialsResponse.Type;
type DelegatedTargets = typeof DelegatedTargetsResponse.Type;
type DelegationScopeOptions = typeof DelegationScopeOptionsResponse.Type;
type CreateDelegatedKey = typeof CreateDelegatedKeyBody.Type;
type CreatedDelegatedKey = typeof CreatedDelegatedKeyResponse.Type;
type StartDelegationChallenge = typeof StartDelegationChallengeBody.Type;
type DelegationChallenge = typeof DelegationChallengeResponse.Type;
type CompleteDelegationProof = typeof CompleteDelegationProofBody.Type;
type ConsentDelegation = typeof ConsentDelegationBody.Type;
type DelegatedCredential = typeof DelegatedCredentialSummary.Type;
type RotateDelegatedKey = typeof RotateDelegatedKeyResponse.Type;
type RevokeAllDelegatedCredentials = typeof RevokeAllDelegatedCredentialsBody.Type;
type RevokeAllDelegatedCredentialsResult = typeof RevokeAllDelegatedCredentialsResponse.Type;
type DelegationAudit = typeof DelegationAuditResponse.Type;
type DelegationNotifications = typeof DelegationNotificationsResponse.Type;
type DelegatedCredentialsQueryInput = typeof DelegatedCredentialsQuery.Type;
type DelegationAuditQueryInput = typeof DelegationAuditQuery.Type;
type DelegationScopeOptionsQueryInput = typeof DelegationScopeOptionsQuery.Type;

type Authed<A, E = never> = Effect.Effect<A, AccountError | AccountUnauthorized | E>;
type OrgScoped<A, E = never> = Authed<A, AccountNoOrganization | E>;

export interface AccountProviderShape {
  readonly me: (headers: AccountHeaders) => Authed<Me>;
  readonly listApiKeys: (headers: AccountHeaders) => OrgScoped<ApiKeys>;
  readonly createApiKey: (headers: AccountHeaders, name: string) => OrgScoped<CreatedApiKey>;
  readonly revokeApiKey: (headers: AccountHeaders, apiKeyId: string) => OrgScoped<Success>;
  /** Org-owned keys: admin-gated, hence the `AccountForbidden` on both. */
  readonly listOrgApiKeys: (headers: AccountHeaders) => OrgScoped<OrgApiKeys, AccountForbidden>;
  readonly createOrgApiKey: (
    headers: AccountHeaders,
    name: string,
  ) => OrgScoped<CreatedApiKey, AccountForbidden>;
  readonly revokeOrgApiKey: (
    headers: AccountHeaders,
    apiKeyId: string,
  ) => OrgScoped<Success, AccountForbidden>;
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

type DelegationFailure =
  | AccountError
  | AccountUnauthorized
  | AccountForbidden
  | AccountNoOrganization
  | AccountBadRequest
  | AccountConflict;

type DelegationAuthed<A> = Effect.Effect<A, DelegationFailure>;

/** Separate provider seam for delegated credentials. */
export interface DelegationProviderShape {
  readonly listDelegatedCredentials: (
    request: DelegationRequestContext,
    query: DelegatedCredentialsQueryInput,
  ) => DelegationAuthed<DelegatedCredentials>;
  readonly listDelegationTargets: (
    request: DelegationRequestContext,
  ) => DelegationAuthed<DelegatedTargets>;
  readonly listDelegationScopeOptions: (
    request: DelegationRequestContext,
    query: DelegationScopeOptionsQueryInput,
  ) => DelegationAuthed<DelegationScopeOptions>;
  readonly listDelegationNotifications: (
    request: DelegationRequestContext,
  ) => DelegationAuthed<DelegationNotifications>;
  readonly markDelegationNotificationRead: (
    request: DelegationRequestContext,
    notificationId: string,
  ) => DelegationAuthed<Success>;
  readonly createDelegatedKey: (
    request: DelegationRequestContext,
    body: CreateDelegatedKey,
  ) => DelegationAuthed<CreatedDelegatedKey>;
  readonly startDelegationChallenge: (
    request: DelegationRequestContext,
    body: StartDelegationChallenge,
  ) => DelegationAuthed<DelegationChallenge>;
  readonly getDelegationChallenge: (
    request: DelegationRequestContext,
    challengeId: string,
  ) => DelegationAuthed<DelegationChallenge>;
  readonly completeDelegationProof: (
    request: DelegationRequestContext,
    challengeId: string,
    body: CompleteDelegationProof,
  ) => DelegationAuthed<DelegationChallenge>;
  readonly consentDelegationChallenge: (
    request: DelegationRequestContext,
    challengeId: string,
    body: ConsentDelegation,
  ) => DelegationAuthed<DelegationChallenge>;
  readonly consentDelegatedCredential: (
    request: DelegationRequestContext,
    credentialId: string,
    body: ConsentDelegation,
  ) => DelegationAuthed<DelegatedCredential>;
  readonly rotateDelegatedKey: (
    request: DelegationRequestContext,
    credentialId: string,
  ) => DelegationAuthed<RotateDelegatedKey>;
  readonly revokeDelegatedCredential: (
    request: DelegationRequestContext,
    credentialId: string,
  ) => DelegationAuthed<Success>;
  readonly revokeAllDelegatedCredentials: (
    request: DelegationRequestContext,
    body: RevokeAllDelegatedCredentials,
  ) => DelegationAuthed<RevokeAllDelegatedCredentialsResult>;
  readonly listDelegationAudit: (
    request: DelegationRequestContext,
    query: DelegationAuditQueryInput,
  ) => DelegationAuthed<DelegationAudit>;
}

export class AccountProvider extends Context.Service<AccountProvider, AccountProviderShape>()(
  "@executor-js/api/AccountProvider",
) {}

export class DelegationProvider extends Context.Service<
  DelegationProvider,
  DelegationProviderShape
>()("@executor-js/api/DelegationProvider") {}
