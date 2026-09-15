// ---------------------------------------------------------------------------
// MemberDirectory — the ONE shared READ seam over "who belongs to this org".
//
// Sits beside `IdentityProvider` (./identity.ts) as the second provider-neutral
// auth surface. `IdentityProvider` answers "who is calling"; this answers "who
// is a member, with what role and status" — the question every member list,
// admin users page, seat count, and per-request membership check asks. Cloud
// (WorkOS) implements it over a LOCAL mirror of WorkOS users + memberships
// (fed by login, write-through, and the WorkOS Events API); self-host (Better
// Auth) implements it over its own `member` + `user` tables. Shared code
// consumes only this tag and never learns which host it is on.
//
// Read-only by design. Writes stay host-specific: cloud writes go to WorkOS
// and are mirrored back; self-host writes go through Better Auth's org plugin.
// Invitations are NOT members and are not reported here.
// ---------------------------------------------------------------------------

import { Context, Effect, Schema } from "effect";

/**
 * Membership lifecycle as the host stores it. `pending` is a member who has
 * not completed joining (cloud: an accepted-but-unactivated WorkOS membership);
 * `inactive` is a deactivated member who keeps their row but must not be
 * granted access.
 */
export const MemberStatus = Schema.Literals(["active", "pending", "inactive"]);
export type MemberStatus = typeof MemberStatus.Type;

/**
 * One member of one organization, as the directory reports it.
 *
 * `accountId` is the host principal id — the SAME id space `IdentityProvider`
 * binds as `Principal.accountId` and the subject table records in
 * `external_id` (cloud: the WorkOS `user_…`; self-host: the Better Auth
 * `user.id`). `membershipId` is the host's membership ROW id (`om_…` on cloud,
 * `member.id` on self-host) and joins to nothing outside the host; it is
 * carried for host-specific writes (remove, change role), never as a join key.
 */
export interface DirectoryMember {
  readonly accountId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  /** The host's role slug as stored (`"admin"` | `"member"` | `"owner"` …), not normalized. */
  readonly role: string;
  readonly status: MemberStatus;
  /** Epoch ms of the member's last sign-in, when the host records it. */
  readonly lastActiveAt: number | null;
}

/**
 * Filter + paging for {@link MemberDirectoryShape.members}.
 *
 * `search` is a case-insensitive substring match over email and name; the
 * adapter trims + lower-cases it (the same rule `normalizeEmail` applies to
 * emails) and an empty term is no filter. `statuses` defaults to active +
 * pending. Results are ordered by email then `accountId` so paging is stable.
 */
export interface MemberQuery {
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly statuses?: readonly MemberStatus[];
}

export interface MemberDirectoryShape {
  /** One account's membership in one org, any status; `null` when it holds none. */
  readonly membership: (
    accountId: string,
    organizationId: string,
  ) => Effect.Effect<DirectoryMember | null, MemberDirectoryError>;
  /** The org's members matching `query` (see {@link MemberQuery} for defaults). */
  readonly members: (
    organizationId: string,
    query?: MemberQuery,
  ) => Effect.Effect<readonly DirectoryMember[], MemberDirectoryError>;
  /**
   * The org's members among `accountIds`, keyed by `accountId`, any status. Ids
   * the org holds no membership for are simply absent. One read for the whole
   * batch — never a lookup per id.
   */
  readonly membersById: (
    organizationId: string,
    accountIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, DirectoryMember>, MemberDirectoryError>;
  /**
   * The org's member with this email, any status. `email` arrives ALREADY
   * normalized (trimmed + lower-cased) and is compared against the normalized
   * directory value, so casing never decides the answer on either host.
   */
  readonly findByEmail: (
    organizationId: string,
    email: string,
  ) => Effect.Effect<DirectoryMember | null, MemberDirectoryError>;
}

export class MemberDirectory extends Context.Service<MemberDirectory, MemberDirectoryShape>()(
  "@executor-js/api/MemberDirectory",
) {}

/**
 * The directory could not be read (storage fault, undecodable row). Flat
 * message only: the cause is logged by the adapter and deliberately not echoed
 * to a caller.
 */
export class MemberDirectoryError extends Schema.TaggedErrorClass<MemberDirectoryError>()(
  "MemberDirectoryError",
  { message: Schema.String },
) {}

/**
 * The search-term normalization every adapter applies: trim + lower-case, the
 * same rule `normalizeEmail` applies to emails. `undefined` means no filter,
 * including for a blank term.
 */
export const normalizeMemberSearch = (search: string | undefined): string | undefined => {
  if (search === undefined) return undefined;
  const term = search.trim().toLowerCase();
  return term.length === 0 ? undefined : term;
};

/** The statuses `members` reports when the query names none. */
export const DEFAULT_MEMBER_STATUSES: readonly MemberStatus[] = ["active", "pending"];
