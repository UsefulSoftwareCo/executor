// ---------------------------------------------------------------------------
// Cloud's `MemberDirectory`: the shared read seam over the LOCAL membership
// mirror (`memberships` join `accounts`, db/schema.ts), never over WorkOS.
//
// The mirror is written by `WorkOsMirror` (login, write-through, the Events
// API reconciler); this file only reads it. A row without a `membership_id`
// was never written by a feeder — it predates the mirror — and is not
// reported: the directory answers only for memberships it actually knows the
// WorkOS identity of, and every feeder fills the id in on its next pass.
// A deleted membership is never dropped, it is TOMBSTONED (`status =
// 'inactive'`, `deleted_at` set) so a feeder replaying a payload of the
// deleted membership cannot bring it back; every read here filters on status,
// active + pending unless the caller names the statuses it wants.
//
// Per-request layer: it holds the request's postgres socket via `DbService`.
// ---------------------------------------------------------------------------

import { and, asc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";

import {
  DEFAULT_MEMBER_STATUSES,
  MemberDirectory,
  MemberDirectoryError,
  normalizeMemberSearch,
  type DirectoryMember,
  type MemberDirectoryShape,
  type MemberQuery,
} from "@executor-js/api/server";

import { accounts, memberships } from "../db/schema";
import { DbService, type DrizzleDb } from "../db/db";
import { tryPromiseService, withServiceLogging } from "./errors";

// Escape LIKE wildcards in a user-typed search term so `_` and `%` match
// themselves. Same treatment `org-deletion.ts` gives an org id prefix.
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, "\\$&");

// The display name the seam reports: first + last, or nothing. Computed in SQL
// too (below) so the search term matches what the caller sees.
const displayName = (firstName: string | null, lastName: string | null): string | null =>
  [firstName, lastName].filter(Boolean).join(" ") || null;

const makeService = (db: DrizzleDb): MemberDirectoryShape => {
  const read = <A>(op: string, fn: () => Promise<A>) =>
    withServiceLogging(
      `member_directory.${op}`,
      () =>
        new MemberDirectoryError({
          message: `Failed to read the member directory (${op})`,
        }),
      tryPromiseService(fn),
    );

  // One projection for every read, so the seam's row shape is built in exactly
  // one place. `membershipId` is non-null by the `known` predicate below.
  const select = () =>
    db
      .select({
        accountId: memberships.accountId,
        membershipId: memberships.membershipId,
        organizationId: memberships.organizationId,
        role: memberships.role,
        status: memberships.status,
        email: accounts.email,
        firstName: accounts.firstName,
        lastName: accounts.lastName,
        avatarUrl: accounts.avatarUrl,
        lastSignInAt: accounts.lastSignInAt,
      })
      .from(memberships)
      .innerJoin(accounts, eq(accounts.id, memberships.accountId))
      .$dynamic();

  type Row = Awaited<ReturnType<typeof select>>[number];

  const toMember = (row: Row): DirectoryMember | null =>
    row.membershipId === null
      ? null
      : {
          accountId: row.accountId,
          membershipId: row.membershipId,
          organizationId: row.organizationId,
          email: row.email,
          name: displayName(row.firstName, row.lastName),
          avatarUrl: row.avatarUrl,
          role: row.role,
          status: row.status,
          lastActiveAt: row.lastSignInAt === null ? null : row.lastSignInAt.getTime(),
        };

  const toMembers = (rows: readonly Row[]): DirectoryMember[] => {
    const members: DirectoryMember[] = [];
    for (const row of rows) {
      const member = toMember(row);
      if (member !== null) members.push(member);
    }
    return members;
  };

  const known = isNotNull(memberships.membershipId);

  const members = (organizationId: string, query: MemberQuery = {}) =>
    read("members", async () => {
      const term = normalizeMemberSearch(query.search);
      const pattern = term === undefined ? undefined : `%${escapeLike(term)}%`;
      let statement = select()
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            inArray(memberships.status, query.statuses ?? DEFAULT_MEMBER_STATUSES),
            known,
            pattern === undefined
              ? undefined
              : or(
                  ilike(accounts.email, pattern),
                  ilike(sql`concat_ws(' ', ${accounts.firstName}, ${accounts.lastName})`, pattern),
                ),
          ),
        )
        .orderBy(asc(accounts.email), asc(memberships.accountId));
      if (query.limit !== undefined) statement = statement.limit(query.limit);
      if (query.offset !== undefined) statement = statement.offset(query.offset);
      return toMembers(await statement);
    });

  return {
    membership: (accountId, organizationId, statuses = DEFAULT_MEMBER_STATUSES) =>
      read("membership", async () => {
        const rows = await select()
          .where(
            and(
              eq(memberships.accountId, accountId),
              eq(memberships.organizationId, organizationId),
              inArray(memberships.status, statuses),
              known,
            ),
          )
          .limit(1);
        const row = rows[0];
        return row === undefined ? null : toMember(row);
      }),

    // The unique index on `membership_id` makes this a point read; the org
    // predicate is what refuses an id that belongs to another org.
    membershipById: (organizationId, membershipId) =>
      read("membershipById", async () => {
        const rows = await select()
          .where(
            and(
              eq(memberships.organizationId, organizationId),
              eq(memberships.membershipId, membershipId),
            ),
          )
          .limit(1);
        const row = rows[0];
        return row === undefined ? null : toMember(row);
      }),

    membershipsOf: (accountId, statuses = DEFAULT_MEMBER_STATUSES) =>
      read("membershipsOf", async () => {
        const rows = await select()
          .where(
            and(eq(memberships.accountId, accountId), inArray(memberships.status, statuses), known),
          )
          .orderBy(asc(memberships.organizationId));
        return toMembers(rows);
      }),

    members,

    membersById: (organizationId, accountIds, statuses = DEFAULT_MEMBER_STATUSES) =>
      accountIds.length === 0
        ? Effect.succeed(new Map<string, DirectoryMember>())
        : read("membersById", async () => {
            const rows = await select().where(
              and(
                eq(memberships.organizationId, organizationId),
                inArray(memberships.accountId, accountIds),
                inArray(memberships.status, statuses),
                known,
              ),
            );
            return new Map(toMembers(rows).map((member) => [member.accountId, member]));
          }),

    findByEmail: (organizationId, email, statuses = DEFAULT_MEMBER_STATUSES) =>
      read("findByEmail", async () => {
        const rows = await select()
          .where(
            and(
              eq(memberships.organizationId, organizationId),
              eq(sql`lower(${accounts.email})`, email),
              inArray(memberships.status, statuses),
              known,
            ),
          )
          .limit(1);
        const row = rows[0];
        return row === undefined ? null : toMember(row);
      }),
  };
};

/** The cloud `MemberDirectory` over the per-request `DbService`. */
export const cloudMemberDirectoryLayer: Layer.Layer<MemberDirectory, never, DbService> =
  Layer.effect(MemberDirectory)(Effect.map(DbService.asEffect(), ({ db }) => makeService(db)));

/**
 * A FRESH `MemberDirectory` layer (new layer value per call), for a service
 * built once but invoked across many Workers requests — the MCP
 * org-authorization seam and the document gate — for the same reason
 * `makeUserStoreLayer` exists: a memoized const layer would pin the first
 * request's postgres socket. See [[makeDbLayer]].
 */
export const makeMemberDirectoryLayer = (): Layer.Layer<MemberDirectory, never, DbService> =>
  Layer.effect(MemberDirectory)(Effect.map(DbService.asEffect(), ({ db }) => makeService(db)));
