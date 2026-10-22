import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Provider-neutral Account API.
//
// This is the multiplayer "account" surface that BOTH the cloud (WorkOS) and
// self-host (Better Auth) servers implement, at the SAME paths, so the shared
// React UI (shell, api-keys page, org page) is identical for both — only the
// server-side handler implementations and the login UX differ per provider.
//
// Deliberately minimal: it covers exactly what the shared shell + pages need
// (who am I, API keys, org members). Provider-specific surfaces that only one
// product has — cloud's multi-org switcher, WorkOS domains, billing — stay in
// app-local API groups and are wired into the shell through injected slots,
// NOT into this contract. That keeps the shared typed client fully implemented
// by both servers (no half-built HttpApi layers).
// ---------------------------------------------------------------------------

// ── Neutral errors ─────────────────────────────────────────────────────────
// Each provider maps its native failures (WorkOSError, Better Auth APIError,
// storage faults) onto these at the handler boundary, so the UI handles one
// neutral shape.

export class AccountError extends Schema.TaggedErrorClass<AccountError>()(
  "AccountError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

export class AccountForbidden extends Schema.TaggedErrorClass<AccountForbidden>()(
  "AccountForbidden",
  { message: Schema.optional(Schema.String) },
  { httpApiStatus: 403 },
) {}

export class AccountNoOrganization extends Schema.TaggedErrorClass<AccountNoOrganization>()(
  "AccountNoOrganization",
  {},
  { httpApiStatus: 403 },
) {}

export class AccountUnauthorized extends Schema.TaggedErrorClass<AccountUnauthorized>()(
  "AccountUnauthorized",
  {},
  { httpApiStatus: 401 },
) {}

export class AccountBadRequest extends Schema.TaggedErrorClass<AccountBadRequest>()(
  "AccountBadRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class AccountConflict extends Schema.TaggedErrorClass<AccountConflict>()(
  "AccountConflict",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

// ── Shared shapes ────────────────────────────────────────────────────────────

export const AccountUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});

export const AccountOrganization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** URL slug for org-prefixed console paths (`/<slug>/policies`). */
  slug: Schema.String,
});

export const AccountMeResponse = Schema.Struct({
  user: AccountUser,
  organization: Schema.NullOr(AccountOrganization),
});

export const ApiKeySummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Masked display value (e.g. "exk_…a1b2"). The full secret is only ever
   *  returned once, from `createApiKey`. */
  obfuscatedValue: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
});

export const ApiKeysResponse = Schema.Struct({
  apiKeys: Schema.Array(ApiKeySummary),
});

export const CreateApiKeyBody = Schema.Struct({
  name: Schema.String,
});

/** Create returns the summary PLUS the one-time plaintext `value`. */
export const CreatedApiKeyResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  obfuscatedValue: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  value: Schema.String,
});

/**
 * ORGANIZATION-owned api keys — the credentials that authenticate as the
 * workspace itself rather than as a member, and are the credential for the
 * `/admin/*` plane. Listed and minted beside personal keys (same surface, same
 * shapes) but gated to admins, since an org key can read every user in the
 * tenant. A provider without an org-key concept (self-host) reports an empty
 * list and refuses to mint.
 */
export const OrgApiKeysResponse = Schema.Struct({
  apiKeys: Schema.Array(ApiKeySummary),
});

/**
 * One member of the caller's organization, as the host's member directory
 * reports them. `email` is nullable: a host can hold a membership whose
 * profile it has not yet learned (cloud mirrors the membership before the
 * user record lands), and reporting `""` for that would let the UI render an
 * empty address as if it were one.
 */
export const OrgMember = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  email: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  role: Schema.String,
  status: Schema.String,
  lastActiveAt: Schema.NullOr(Schema.String),
  isCurrentUser: Schema.Boolean,
});

/** Seat usage. Self-host (unlimited) reports `unlimited: true`; cloud reports
 *  real plan seats. Optional so providers without a seat model can omit it. */
export const OrgMemberSeats = Schema.Struct({
  used: Schema.Number,
  granted: Schema.Number,
  unlimited: Schema.Boolean,
});

export const OrgMembersResponse = Schema.Struct({
  members: Schema.Array(OrgMember),
  seats: Schema.optional(OrgMemberSeats),
});

export const OrgRole = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
});

export const OrgRolesResponse = Schema.Struct({
  roles: Schema.Array(OrgRole),
});

export const InviteMemberBody = Schema.Struct({
  email: Schema.String,
  roleSlug: Schema.optional(Schema.String),
});

export const InviteMemberResponse = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
});

export const UpdateMemberRoleBody = Schema.Struct({
  roleSlug: Schema.String,
});

export const UpdateOrgNameBody = Schema.Struct({
  name: Schema.String,
});

export const UpdateOrgNameResponse = Schema.Struct({
  name: Schema.String,
});

export const SuccessResponse = Schema.Struct({
  success: Schema.Boolean,
});

// ── Delegated credentials ──────────────────────────────────────────────────
//
// A delegated credential is deliberately represented as a grant plus a
// provider reference. The API never returns an external client secret, and a
// local key's plaintext value is only present in the create/rotate response.
// `scope` is the exact membership snapshot the operator consented to; hosts
// must not silently widen it while resolving a request.

export const DelegationScope = Schema.Struct({
  /** Closed v1 actions. Discovery covers catalog/schema; invocation covers
   * approval/resume for an already-authorized execution. Management is never
   * consentable. */
  scopes: Schema.Array(Schema.Literals(["discover", "invoke"])),
  toolkitIds: Schema.Array(Schema.String),
  /** Omitted means frozen toolkit membership; [] denies all connections. */
  connectionIds: Schema.optional(Schema.Array(Schema.String)),
});

export const DelegationTarget = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  isCurrentUser: Schema.Boolean,
  status: Schema.Literals(["verified", "suspended", "removed"]),
});

export const DelegationTargetSelector = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("self") }),
  Schema.Struct({ kind: Schema.Literal("verified-human"), id: Schema.String }),
]);

export const DelegationCredentialReference = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local-key"), prefix: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("external"),
    adapter: Schema.String,
    /** Masked provider reference; never a raw secret or full binding tuple. */
    reference: Schema.String,
  }),
]);

export const DelegationLifecycle = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("active"),
    expiresAt: Schema.String,
    revokedAt: Schema.NullOr(Schema.String),
    revokeReason: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literals(["expired", "revoked"]),
    expiresAt: Schema.String,
    revokedAt: Schema.NullOr(Schema.String),
    revokeReason: Schema.NullOr(Schema.String),
  }),
]);

/** Audit actors are separate from grant targets: an administrator can create
 * a grant for another human, and a machine actor must retain its own kind. */
export const DelegationActor = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("human"),
    id: Schema.String,
    email: Schema.String,
    name: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("machine"),
    adapter: Schema.String,
    reference: Schema.String,
  }),
]);

export const DelegationNotification = Schema.Struct({
  id: Schema.String,
  target: DelegationTarget,
  title: Schema.String,
  message: Schema.String,
  createdAt: Schema.String,
  readAt: Schema.NullOr(Schema.String),
});

export const DelegationDelivery = Schema.Struct({
  status: Schema.Literals(["queued", "sent", "unavailable", "failed"]),
  channel: Schema.NullOr(Schema.String),
  occurredAt: Schema.NullOr(Schema.String),
});

export const DelegatedCredentialSummary = Schema.Struct({
  id: Schema.String,
  grantId: Schema.String,
  label: Schema.String,
  credentialKind: Schema.Literals(["local-key", "external"]),
  reference: DelegationCredentialReference,
  target: DelegationTarget,
  scope: DelegationScope,
  lifecycle: DelegationLifecycle,
  createdAt: Schema.String,
  createdBy: DelegationActor,
  lastUsedAt: Schema.NullOr(Schema.String),
  supportsRotation: Schema.Boolean,
  notification: Schema.NullOr(DelegationDelivery),
});

export const DelegationCapabilities = Schema.Struct({
  issuanceEnabled: Schema.Boolean,
  localKeysEnabled: Schema.Boolean,
  externalAdapters: Schema.Array(Schema.String),
  canFilterTargets: Schema.Boolean,
});

export const DelegatedCredentialsResponse = Schema.Struct({
  credentials: Schema.Array(DelegatedCredentialSummary),
  nextCursor: Schema.NullOr(Schema.String),
  capabilities: DelegationCapabilities,
  notifications: Schema.Array(DelegationNotification),
});

export const DelegatedTargetsResponse = Schema.Struct({
  targets: Schema.Array(DelegationTarget),
});

/** Human-readable, target-scoped choices for an exact delegation snapshot.
 * IDs are stable executor IDs/addresses; labels are display-only and never
 * accepted as authorization input. */
export const DelegationScopeConnectionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
  toolkitIds: Schema.Array(Schema.String),
});

export const DelegationScopeToolkitOption = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
});

export const DelegationScopeOptionsResponse = Schema.Struct({
  actions: Schema.Array(Schema.Literals(["discover", "invoke"])),
  toolkits: Schema.Array(DelegationScopeToolkitOption),
  connections: Schema.Array(DelegationScopeConnectionOption),
  /** The host's effective maximum, including operator configuration. */
  maxExpiresAt: Schema.String,
});

export const CreateDelegatedKeyBody = Schema.Struct({
  label: Schema.String,
  target: DelegationTargetSelector,
  scope: DelegationScope,
  expiresAt: Schema.String,
});

export const CreatedDelegatedKeyResponse = Schema.Struct({
  credential: DelegatedCredentialSummary,
  /** One-time local key value. Never populated for an external credential. */
  value: Schema.String,
});

export const StartDelegationChallengeBody = Schema.Struct({
  adapter: Schema.String,
  label: Schema.String,
  target: DelegationTargetSelector,
  scope: DelegationScope,
  expiresAt: Schema.String,
});

export const DelegationChallengeResponse = Schema.Struct({
  id: Schema.String,
  /** One-time challenge nonce. It is not a credential secret; the machine
   * must still authenticate through the host adapter when presenting it. */
  nonce: Schema.String,
  status: Schema.Literals(["awaiting-proof", "proof-complete", "consented", "expired"]),
  expiresAt: Schema.String,
  adapter: Schema.String,
  target: DelegationTargetSelector,
  scope: DelegationScope,
  label: Schema.String,
  instructions: Schema.NullOr(Schema.String),
  /** The masked machine identity that proved possession, before final human
   * consent creates the durable credential. */
  provenCredential: Schema.NullOr(DelegationCredentialReference),
  credential: Schema.NullOr(DelegatedCredentialSummary),
});

/** Provider-specific proof metadata. Possession is established from the
 * authenticated request; this body is intentionally not a client-id
 * registration or a place to submit a raw secret. */
export const CompleteDelegationProofBody = Schema.Struct({
  nonce: Schema.String,
  proofType: Schema.String,
});

export const ConsentDelegationBody = Schema.Struct({
  scope: DelegationScope,
  expiresAt: Schema.String,
});

export const RotateDelegatedKeyResponse = Schema.Struct({
  credential: DelegatedCredentialSummary,
  value: Schema.String,
});

export const RevokeAllDelegatedCredentialsBody = Schema.Struct({
  target: DelegationTargetSelector,
  /** Explicit operator action that disables future delegations for the target.
   * Ordinary revoke-all keeps the target eligible for later consent. */
  disableTarget: Schema.optional(Schema.Boolean),
});

export const RevokeAllDelegatedCredentialsResponse = Schema.Struct({
  revokedCount: Schema.Number,
});

export const DelegationAuditEvent = Schema.Struct({
  id: Schema.String,
  grantId: Schema.NullOr(Schema.String),
  credentialId: Schema.NullOr(Schema.String),
  actor: DelegationActor,
  effectiveTarget: DelegationTarget,
  action: Schema.String,
  outcome: Schema.String,
  tool: Schema.NullOr(Schema.String),
  requestId: Schema.NullOr(Schema.String),
  executionId: Schema.NullOr(Schema.String),
  occurredAt: Schema.String,
});

export const DelegationAuditResponse = Schema.Struct({
  events: Schema.Array(DelegationAuditEvent),
  nextCursor: Schema.NullOr(Schema.String),
});

export const DelegatedCredentialsQuery = Schema.Struct({
  targetId: Schema.optional(Schema.String),
  includeRevoked: Schema.optional(Schema.Literals(["true", "false"])),
  cursor: Schema.optional(Schema.String),
});

export const DelegationScopeOptionsQuery = Schema.Struct({
  targetId: Schema.optional(Schema.String),
});

export const DelegationAuditQuery = Schema.Struct({
  targetId: Schema.optional(Schema.String),
  credentialId: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
});

export const DelegationNotificationsResponse = Schema.Struct({
  notifications: Schema.Array(DelegationNotification),
});

export const DelegationNotificationParams = { notificationId: Schema.String };

const ApiKeyParams = { apiKeyId: Schema.String };
const MembershipParams = { membershipId: Schema.String };
const DelegationCredentialParams = { credentialId: Schema.String };
const DelegationChallengeParams = { challengeId: Schema.String };

// ── Group ────────────────────────────────────────────────────────────────────

/**
 * The neutral account group. Mounted at `/account/*` by both servers. Auth is
 * applied by each server's own session middleware (cookie-based, same-origin),
 * so this contract carries no provider-specific auth scheme.
 */
export const AccountApi = HttpApiGroup.make("account")
  .add(
    HttpApiEndpoint.get("me", "/account/me", {
      success: AccountMeResponse,
      error: [AccountError, AccountUnauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("listApiKeys", "/account/api-keys", {
      success: ApiKeysResponse,
      error: [AccountError, AccountUnauthorized, AccountNoOrganization],
    }),
  )
  .add(
    HttpApiEndpoint.post("createApiKey", "/account/api-keys", {
      payload: CreateApiKeyBody,
      success: CreatedApiKeyResponse,
      error: [AccountError, AccountUnauthorized, AccountNoOrganization],
    }),
  )
  .add(
    HttpApiEndpoint.delete("revokeApiKey", "/account/api-keys/:apiKeyId", {
      params: ApiKeyParams,
      success: SuccessResponse,
      error: [AccountError, AccountUnauthorized, AccountNoOrganization],
    }),
  )
  .add(
    HttpApiEndpoint.get("listOrgApiKeys", "/account/org-api-keys", {
      success: OrgApiKeysResponse,
      error: [AccountError, AccountUnauthorized, AccountForbidden, AccountNoOrganization],
    }),
  )
  .add(
    HttpApiEndpoint.post("createOrgApiKey", "/account/org-api-keys", {
      payload: CreateApiKeyBody,
      success: CreatedApiKeyResponse,
      error: [AccountError, AccountUnauthorized, AccountForbidden, AccountNoOrganization],
    }),
  )
  // Revoke is its own route rather than a reuse of `revokeApiKey`: that one
  // resolves ownership against the caller's PERSONAL keys, so an org key id is
  // never in its owned set and revoking one there always fails. An org key is
  // the most privileged credential in the product (it reads the tenant-wide
  // `/admin/*` plane), so it must be revocable — admin-gated, like the mint.
  .add(
    HttpApiEndpoint.delete("revokeOrgApiKey", "/account/org-api-keys/:apiKeyId", {
      params: ApiKeyParams,
      success: SuccessResponse,
      error: [AccountError, AccountUnauthorized, AccountForbidden, AccountNoOrganization],
    }),
  )
  .add(
    HttpApiEndpoint.get("listMembers", "/account/members", {
      success: OrgMembersResponse,
      error: [AccountError, AccountUnauthorized, AccountNoOrganization],
    }),
  )
  .add(
    HttpApiEndpoint.get("listRoles", "/account/roles", {
      success: OrgRolesResponse,
      error: [AccountError, AccountUnauthorized, AccountNoOrganization],
    }),
  )
  .add(
    HttpApiEndpoint.post("inviteMember", "/account/members/invite", {
      payload: InviteMemberBody,
      success: InviteMemberResponse,
      error: [AccountError, AccountUnauthorized, AccountForbidden, AccountNoOrganization],
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeMember", "/account/members/:membershipId", {
      params: MembershipParams,
      success: SuccessResponse,
      error: [AccountError, AccountUnauthorized, AccountForbidden, AccountNoOrganization],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateMemberRole", "/account/members/:membershipId/role", {
      params: MembershipParams,
      payload: UpdateMemberRoleBody,
      success: SuccessResponse,
      error: [AccountError, AccountUnauthorized, AccountForbidden, AccountNoOrganization],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateOrgName", "/account/name", {
      payload: UpdateOrgNameBody,
      success: UpdateOrgNameResponse,
      error: [AccountError, AccountUnauthorized, AccountForbidden, AccountNoOrganization],
    }),
  )
  .add(
    HttpApiEndpoint.get("listDelegatedCredentials", "/account/delegated-credentials", {
      query: DelegatedCredentialsQuery,
      success: DelegatedCredentialsResponse,
      error: [
        AccountError,
        AccountUnauthorized,
        AccountForbidden,
        AccountNoOrganization,
        AccountBadRequest,
        AccountConflict,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("listDelegationTargets", "/account/delegated-credentials/targets", {
      success: DelegatedTargetsResponse,
      error: [
        AccountError,
        AccountUnauthorized,
        AccountForbidden,
        AccountNoOrganization,
        AccountBadRequest,
        AccountConflict,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "listDelegationScopeOptions",
      "/account/delegated-credentials/scope-options",
      {
        query: DelegationScopeOptionsQuery,
        success: DelegationScopeOptionsResponse,
        error: [
          AccountError,
          AccountUnauthorized,
          AccountForbidden,
          AccountNoOrganization,
          AccountBadRequest,
          AccountConflict,
        ],
      },
    ),
  )
  .add(
    HttpApiEndpoint.get(
      "listDelegationNotifications",
      "/account/delegated-credentials/notifications",
      {
        success: DelegationNotificationsResponse,
        error: [
          AccountError,
          AccountUnauthorized,
          AccountForbidden,
          AccountNoOrganization,
          AccountBadRequest,
          AccountConflict,
        ],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "markDelegationNotificationRead",
      "/account/delegated-credentials/notifications/:notificationId/read",
      {
        params: DelegationNotificationParams,
        success: SuccessResponse,
        error: [
          AccountError,
          AccountUnauthorized,
          AccountForbidden,
          AccountNoOrganization,
          AccountBadRequest,
          AccountConflict,
        ],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("createDelegatedKey", "/account/delegated-credentials/keys", {
      payload: CreateDelegatedKeyBody,
      success: CreatedDelegatedKeyResponse,
      error: [
        AccountError,
        AccountUnauthorized,
        AccountForbidden,
        AccountNoOrganization,
        AccountBadRequest,
        AccountConflict,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("startDelegationChallenge", "/account/delegated-credentials/challenges", {
      payload: StartDelegationChallengeBody,
      success: DelegationChallengeResponse,
      error: [
        AccountError,
        AccountUnauthorized,
        AccountForbidden,
        AccountNoOrganization,
        AccountBadRequest,
        AccountConflict,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "getDelegationChallenge",
      "/account/delegated-credentials/challenges/:challengeId",
      {
        params: DelegationChallengeParams,
        success: DelegationChallengeResponse,
        error: [
          AccountError,
          AccountUnauthorized,
          AccountForbidden,
          AccountNoOrganization,
          AccountBadRequest,
          AccountConflict,
        ],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "completeDelegationProof",
      "/account/delegated-credentials/challenges/:challengeId/proof",
      {
        params: DelegationChallengeParams,
        payload: CompleteDelegationProofBody,
        success: DelegationChallengeResponse,
        error: [
          AccountError,
          AccountUnauthorized,
          AccountForbidden,
          AccountNoOrganization,
          AccountBadRequest,
          AccountConflict,
        ],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "consentDelegationChallenge",
      "/account/delegated-credentials/challenges/:challengeId/consent",
      {
        params: DelegationChallengeParams,
        payload: ConsentDelegationBody,
        success: DelegationChallengeResponse,
        error: [
          AccountError,
          AccountUnauthorized,
          AccountForbidden,
          AccountNoOrganization,
          AccountBadRequest,
          AccountConflict,
        ],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "consentDelegatedCredential",
      "/account/delegated-credentials/:credentialId/consent",
      {
        params: DelegationCredentialParams,
        payload: ConsentDelegationBody,
        success: DelegatedCredentialSummary,
        error: [
          AccountError,
          AccountUnauthorized,
          AccountForbidden,
          AccountNoOrganization,
          AccountBadRequest,
          AccountConflict,
        ],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "rotateDelegatedKey",
      "/account/delegated-credentials/:credentialId/rotate",
      {
        params: DelegationCredentialParams,
        success: RotateDelegatedKeyResponse,
        error: [
          AccountError,
          AccountUnauthorized,
          AccountForbidden,
          AccountNoOrganization,
          AccountBadRequest,
          AccountConflict,
        ],
      },
    ),
  )
  .add(
    HttpApiEndpoint.delete(
      "revokeDelegatedCredential",
      "/account/delegated-credentials/:credentialId",
      {
        params: DelegationCredentialParams,
        success: SuccessResponse,
        error: [
          AccountError,
          AccountUnauthorized,
          AccountForbidden,
          AccountNoOrganization,
          AccountBadRequest,
          AccountConflict,
        ],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "revokeAllDelegatedCredentials",
      "/account/delegated-credentials/revoke-all",
      {
        payload: RevokeAllDelegatedCredentialsBody,
        success: RevokeAllDelegatedCredentialsResponse,
        error: [
          AccountError,
          AccountUnauthorized,
          AccountForbidden,
          AccountNoOrganization,
          AccountBadRequest,
          AccountConflict,
        ],
      },
    ),
  )
  .add(
    HttpApiEndpoint.get("listDelegationAudit", "/account/delegated-credentials/audit", {
      query: DelegationAuditQuery,
      success: DelegationAuditResponse,
      error: [
        AccountError,
        AccountUnauthorized,
        AccountForbidden,
        AccountNoOrganization,
        AccountBadRequest,
        AccountConflict,
      ],
    }),
  );

/**
 * Standalone HttpApi wrapping just the account group — used to build the shared
 * `AccountApiClient` in `@executor-js/react`. Servers don't use this; they add
 * `AccountApi` to their own full API so it's served alongside the core groups.
 */
export const AccountHttpApi = HttpApi.make("executor-account").add(AccountApi);
