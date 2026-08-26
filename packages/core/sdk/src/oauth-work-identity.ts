// ---------------------------------------------------------------------------
// Work identity — the acquisition half of MCP Enterprise-Managed Authorization.
//
// The EMA connect path (`oauth.start` with `enterprise`) presents an identity
// assertion to the enterprise IdP and exchanges it for an ID-JAG. Nothing in the
// product ACQUIRED that assertion: the connect request simply required the
// caller to hand one over. A browser cannot obtain one — the IdP client's secret
// is server-side — so in practice there was no way to reach the profile from the
// console at all.
//
// A WORK IDENTITY closes that gap. A user links their enterprise identity ONCE
// per (owner, IdP client): executor runs an ordinary authorization-code flow
// against the org's registered IdP app, exchanges the code server-side with that
// app's credentials, and takes custody of the result. Every later
// enterprise-managed connect for that IdP client then resolves the held identity
// instead of asking the caller for one.
//
// WHAT IS HELD, AND WHY IT IS THE REFRESH TOKEN
//
// draft-ietf-oauth-identity-assertion-authz-grant §4.5 makes the refresh token a
// first-class `subject_token` for exactly this reason: an OIDC ID token lives
// about an hour, so an ID token in custody turns every renewal after that hour
// into "needs SSO" — the connection is dead a lunch break after it was made. A
// refresh token is the durable subject, and `SubjectTokenTypeSchema` already
// admits it.
//
// ID-token custody remains as an EXPLICIT, recorded degradation for an IdP that
// issues no refresh token (`tokenType` says which is held, and `expiresAt`
// carries the deadline). It is a different stored shape, not a silent fallback.
//
// CUSTODY LAYOUT
//
// The record lives in the default writable credential provider under a
// deterministic item id (see {@link workIdentityItemId}) — the same store the
// connection access/refresh material uses, with the same owner partitioning
// (`provider-item-owner.ts`). One record, N enterprise-managed connections: the
// connections POINT at this item rather than each keeping a private copy, which
// is what makes a single re-link recover all of them.
// ---------------------------------------------------------------------------

import { Option, Schema } from "effect";

import { OAuthClientSlug, OAuthState, Owner, ProviderItemId } from "./ids";
import { SubjectTokenTypeSchema, type SubjectTokenType } from "./oauth-client";

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/** Which held enterprise identity a request is about: the registered IdP app,
 *  and the owner partition the identity is filed under.
 *
 *  `owner` is the owner the CONNECTIONS backed by this identity are made under,
 *  which is also the partition the credential provider files it in — a Personal
 *  connection resolves the user's own identity, a Workspace connection the
 *  org-shared one, exactly as an OAuth connection's tokens already work. */
export const WorkIdentityRefSchema = Schema.Struct({
  owner: Owner,
  idpClient: OAuthClientSlug,
  idpClientOwner: Owner,
}).annotate({
  identifier: "WorkIdentityRef",
  description:
    "The (owner, enterprise identity provider app) pair a held work identity is keyed by.",
});
export interface WorkIdentityRef extends Schema.Schema.Type<typeof WorkIdentityRefSchema> {}

/** The credential-provider item a work identity occupies.
 *
 *  The `work-identity:<owner>:…` grammar is deliberate: `provider-item-owner.ts`
 *  reads the second segment to decide which partition a provider files the value
 *  under, so this id must keep that shape or an org identity would be written
 *  into the acting member's private partition. */
export const workIdentityItemId = (ref: WorkIdentityRef): ProviderItemId =>
  ProviderItemId.make(`work-identity:${ref.owner}:${ref.idpClientOwner}:${String(ref.idpClient)}`);

// ---------------------------------------------------------------------------
// The persisted record
// ---------------------------------------------------------------------------

/** Why a held identity stopped working. `rejected` is the only value the
 *  renewal path can produce: the IdP refused the stored subject at the token
 *  exchange (RFC 6749 `invalid_grant`), which is definitive — the user must link
 *  again. Kept as a closed set so the product can say something specific rather
 *  than rendering a stored sentence. */
export const WorkIdentityRevocationReasonSchema = Schema.Literals(["rejected"]).annotate({
  identifier: "WorkIdentityRevocationReason",
});
export type WorkIdentityRevocationReason = typeof WorkIdentityRevocationReasonSchema.Type;

/** Everything custody of a work identity means, as stored in the credential
 *  provider. The whole record lives in the secret store — not just the token —
 *  because the account facts beside it (which enterprise account, when it was
 *  linked) describe a credential and belong under the same protection.
 *
 *  Read it back with {@link decodeWorkIdentityRecord}; never with a cast. */
export const WorkIdentityRecordSchema = Schema.Struct({
  /** The durable subject presented as `subject_token` on every later exchange:
   *  the IdP refresh token, or — when the IdP issued none — the ID token. */
  token: Schema.String,
  /** RFC 8693 §3 type of `token`. Says which of the two custodies is in force. */
  tokenType: SubjectTokenTypeSchema,
  /** The IdP's `sub` claim for this account. Stable across re-links; the
   *  identifier support and audit read. */
  subject: Schema.NullOr(Schema.String),
  /** Display label from the ID token (`email`, else `preferred_username`, else
   *  `sub`) — what "linked as …" shows. */
  label: Schema.NullOr(Schema.String),
  /** Epoch ms the link was made. */
  linkedAt: Schema.Number,
  /** Epoch ms this custody stops working, when it is knowable — the ID token's
   *  `exp` under ID-token custody. Null for refresh-token custody: a refresh
   *  token has no client-visible expiry, which is the whole point of holding it. */
  expiresAt: Schema.NullOr(Schema.Number),
  /** Scope the IdP granted on the link, as it echoed it. Recorded for support;
   *  never re-requested from here (each connect asks for the server's scopes). */
  scope: Schema.NullOr(Schema.String),
  /** Set when the IdP rejected this subject. The record is KEPT so the product
   *  can say "re-link", and so every connection pointing at it short-circuits
   *  instead of re-spending a doomed exchange. */
  revokedAt: Schema.optional(Schema.Number),
  revokedReason: Schema.optional(WorkIdentityRevocationReasonSchema),
}).annotate({
  identifier: "WorkIdentityRecord",
  description:
    "A user's held enterprise identity: the durable subject token plus the account facts describing it.",
});
export interface WorkIdentityRecord extends Schema.Schema.Type<typeof WorkIdentityRecordSchema> {}

const WorkIdentityRecordFromJson = Schema.fromJsonString(WorkIdentityRecordSchema);

/** Parse a stored record. A record that does not decode is treated as ABSENT by
 *  callers — the product then says "not linked", which is both true (nothing
 *  usable is held) and recoverable (linking again overwrites it). */
export const decodeWorkIdentityRecord = Schema.decodeUnknownOption(WorkIdentityRecordFromJson);

/** Serialize a record for the credential provider. */
export const encodeWorkIdentityRecord = Schema.encodeSync(WorkIdentityRecordFromJson);

/** Whether this record can still be presented to the IdP. */
export const isWorkIdentityUsable = (record: WorkIdentityRecord): boolean =>
  record.revokedAt === undefined;

/** The record with the IdP's rejection recorded. Idempotent: a record already
 *  marked keeps its FIRST rejection timestamp, so "since when" stays true when
 *  several connections meet the same dead identity. */
export const revokedWorkIdentity = (
  record: WorkIdentityRecord,
  input: { readonly at: number; readonly reason: WorkIdentityRevocationReason },
): WorkIdentityRecord =>
  record.revokedAt === undefined
    ? { ...record, revokedAt: input.at, revokedReason: input.reason }
    : record;

// ---------------------------------------------------------------------------
// The read model
// ---------------------------------------------------------------------------

const WorkIdentityAccount = {
  /** The IdP's `sub` claim, when the ID token carried one. */
  subject: Schema.NullOr(Schema.String),
  /** "Linked as …" — the account email, else `preferred_username`, else `sub`. */
  label: Schema.NullOr(Schema.String),
  linkedAt: Schema.Number,
  /** Which custody is in force. `…:refresh_token` survives ID-token expiry;
   *  `…:id_token` means the IdP issued no refresh token and this link dies at
   *  `expiresAt`. */
  subjectTokenType: SubjectTokenTypeSchema,
  expiresAt: Schema.NullOr(Schema.Number),
} as const;

/** What the console polls. Three states, discriminated by `status`, because the
 *  product does three different things:
 *
 *   - `unlinked`   → offer "Link your work identity".
 *   - `linked`     → show the account; enterprise-managed connects will work.
 *   - `needs_relink` → an identity IS held but the IdP has rejected it. Every
 *     enterprise-managed connection backed by it is stalled and ONE re-link
 *     revives all of them — which is why this is not the same state as
 *     `unlinked`, and emphatically not the same as a dead connection. */
export const WorkIdentityStatusSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("unlinked"),
    idpClient: OAuthClientSlug,
    idpClientOwner: Owner,
    owner: Owner,
  }),
  Schema.Struct({
    status: Schema.Literal("linked"),
    idpClient: OAuthClientSlug,
    idpClientOwner: Owner,
    owner: Owner,
    ...WorkIdentityAccount,
  }),
  Schema.Struct({
    status: Schema.Literal("needs_relink"),
    idpClient: OAuthClientSlug,
    idpClientOwner: Owner,
    owner: Owner,
    ...WorkIdentityAccount,
    revokedAt: Schema.Number,
    revokedReason: WorkIdentityRevocationReasonSchema,
  }),
]).annotate({
  identifier: "WorkIdentityStatus",
  description:
    "Whether a user holds a usable enterprise identity for an IdP app, and which account it is.",
});
export type WorkIdentityStatus = typeof WorkIdentityStatusSchema.Type;

/** Project a stored record onto the read model. Carries the account facts and
 *  NOTHING that could stand in for the credential: `token` has no path here. */
export const workIdentityStatusOf = (
  ref: WorkIdentityRef,
  record: WorkIdentityRecord | null,
): WorkIdentityStatus => {
  if (record === null) {
    return {
      status: "unlinked",
      owner: ref.owner,
      idpClient: ref.idpClient,
      idpClientOwner: ref.idpClientOwner,
    };
  }
  const account = {
    owner: ref.owner,
    idpClient: ref.idpClient,
    idpClientOwner: ref.idpClientOwner,
    subject: record.subject,
    label: record.label,
    linkedAt: record.linkedAt,
    subjectTokenType: record.tokenType,
    expiresAt: record.expiresAt,
  } as const;
  return record.revokedAt === undefined
    ? { status: "linked", ...account }
    : {
        status: "needs_relink",
        ...account,
        revokedAt: record.revokedAt,
        revokedReason: record.revokedReason ?? "rejected",
      };
};

// ---------------------------------------------------------------------------
// Flow inputs
// ---------------------------------------------------------------------------

/** The default scope set a link requests. `openid` is what makes the token
 *  endpoint return an ID token, which is the only place the account facts come
 *  from; `offline_access` is how an OIDC provider is asked for the refresh token
 *  this whole design holds. Deliberately NOT narrowed against the IdP's
 *  advertised `scopes_supported`: both are standard OIDC scopes that many
 *  authorization servers decline to enumerate, and dropping either would quietly
 *  cost the link its account facts or its durability. An IdP that spells them
 *  differently is served by the explicit `scopes` override. */
export const DEFAULT_WORK_IDENTITY_SCOPES: readonly string[] = ["openid", "offline_access"];

export interface StartWorkIdentityLinkInput extends WorkIdentityRef {
  /** Replace {@link DEFAULT_WORK_IDENTITY_SCOPES} outright. An override, not an
   *  addition: an IdP that rejects `offline_access` needs the default GONE, not
   *  supplemented. Omit unless the IdP requires it. */
  readonly scopes?: readonly string[];
  /** Browser-facing callback for this link. Defaults to the executor's
   *  configured work-identity callback. */
  readonly redirectUri?: string | null;
}

export interface CompleteWorkIdentityLinkInput {
  readonly state: OAuthState;
  readonly code: string;
}

// ---------------------------------------------------------------------------
// The in-flight session
//
// A link reuses `oauth_session` — the same table, TTL and cleanup the connect
// flow uses — rather than growing a parallel one. What distinguishes the two is
// the payload, and it is CHECKED rather than assumed: a work-identity state
// handed to `complete` must not be able to mint a connection out of the sentinel
// columns, and a connect state handed to `completeWorkIdentityLink` must not be
// able to redeem a code into someone's identity custody.
// ---------------------------------------------------------------------------

/** Value written to `oauth_session`'s integration/name/template columns for a
 *  link. They are non-null and mean nothing here — a link targets no
 *  integration — so they carry a self-describing sentinel instead of an empty
 *  string that would read as data. The payload is what completion parses. */
export const WORK_IDENTITY_SESSION_SENTINEL = "work-identity";

export const WorkIdentitySessionPayloadSchema = Schema.Struct({
  kind: Schema.Literal("work-identity"),
  owner: Owner,
  idpClient: OAuthClientSlug,
  idpClientOwner: Owner,
  /** What the authorize request asked for; the recorded-scope fallback when the
   *  IdP's token response omits `scope`. */
  requestedScopes: Schema.Array(Schema.String),
}).annotate({ identifier: "WorkIdentitySessionPayload" });
export interface WorkIdentitySessionPayload extends Schema.Schema.Type<
  typeof WorkIdentitySessionPayloadSchema
> {}

const decodeWorkIdentitySessionPayload = Schema.decodeUnknownOption(
  WorkIdentitySessionPayloadSchema,
);

/** The link this session belongs to, or null when the session is not one. The
 *  ONLY way either completion path decides which flow it is looking at. */
export const workIdentitySessionPayloadFrom = (
  payload: unknown,
): WorkIdentitySessionPayload | null => Option.getOrNull(decodeWorkIdentitySessionPayload(payload));

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A work-identity link could not be started or completed. Deliberately its own
 *  tag rather than an `OAuthCompleteError`: nothing about it concerns a
 *  connection, and a console that renders "could not connect" for a failed link
 *  sends the user to the wrong place. */
export class WorkIdentityLinkError extends Schema.TaggedErrorClass<WorkIdentityLinkError>()(
  "WorkIdentityLinkError",
  {
    message: Schema.String,
    /** True when the flow cannot be resumed and the user must start the link
     *  again (an expired or already-redeemed authorization). */
    restartRequired: Schema.optional(Schema.Boolean),
  },
) {
  readonly __executorUserActionable = true;
  readonly code = "work_identity_link_error";

  get userMessage(): string {
    return this.message;
  }
}

/** The subject-token type a link takes custody of, given what the IdP returned.
 *  Refresh token when there is one (§4.5); ID token otherwise, which is custody
 *  of something that expires and is recorded as such. */
export const workIdentityCustodyType = (input: {
  readonly refreshToken: string | undefined;
  readonly idToken: string | undefined;
}): SubjectTokenType | null => {
  if (input.refreshToken !== undefined && input.refreshToken.length > 0) {
    return "urn:ietf:params:oauth:token-type:refresh_token";
  }
  if (input.idToken !== undefined && input.idToken.length > 0) {
    return "urn:ietf:params:oauth:token-type:id_token";
  }
  return null;
};
