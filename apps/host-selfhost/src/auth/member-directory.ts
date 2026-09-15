// ---------------------------------------------------------------------------
// Self-host's `MemberDirectory`: the shared read seam over Better Auth's
// organization `member` table joined with `user`.
//
// Reads go through Better Auth's OWN adapter (`auth.$context` → `adapter`)
// rather than `auth.api.listMembers`, for the same reason `mcp/auth.ts` reads
// the membership row that way: the adapter needs no session headers, so the
// HTTP, MCP, and admin planes can all resolve membership through this one code
// path. Better Auth members carry no status (an invitation is not a member),
// so every member reports `"active"`; roles are the plugin's own slugs
// (`owner` / `admin` / `member`), verbatim.
//
// The adapter has no case-insensitive predicate and no join filter, so search
// and email matching run in memory over the org's member list — a single-org
// self-host instance is small, and one code path answering every read is
// worth more than an indexed lookup here.
// ---------------------------------------------------------------------------

import { Effect, Layer, Schema } from "effect";

import {
  DEFAULT_MEMBER_STATUSES,
  MemberDirectory,
  MemberDirectoryError,
  normalizeAdminUserEmail,
  normalizeMemberSearch,
  type DirectoryMember,
  type MemberDirectoryShape,
  type MemberQuery,
} from "@executor-js/api/server";

import { BetterAuth, type BetterAuthHandle } from "./better-auth";

// What the adapter hands back is untyped (`findMany<T>` trusts its caller), so
// each row is decoded at this boundary. Extra columns are dropped.
const MemberRow = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  organizationId: Schema.String,
  role: Schema.String,
});
const UserRow = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.NullishOr(Schema.String),
  image: Schema.NullishOr(Schema.String),
});
const decodeMemberRows = Schema.decodeUnknownEffect(Schema.Array(MemberRow));
const decodeUserRows = Schema.decodeUnknownEffect(Schema.Array(UserRow));

// The adapter caps every `findMany` at 100 rows unless told otherwise, so
// reads page explicitly until a short page. `in` predicates are chunked so a
// large id list never overruns SQLite's bound-parameter limit.
const PAGE_SIZE = 500;
const IN_CHUNK = 200;

type BetterAuthAdapter = Awaited<BetterAuthHandle["auth"]["$context"]>["adapter"];
type AdapterWhere = Parameters<BetterAuthAdapter["findMany"]>[0]["where"];

const byEmailThenAccount = (a: DirectoryMember, b: DirectoryMember): number => {
  // Nulls sort last, matching Postgres's default ASC ordering on cloud.
  if (a.email !== b.email) {
    if (a.email === null) return 1;
    if (b.email === null) return -1;
    return a.email < b.email ? -1 : 1;
  }
  return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
};

const makeService = (adapter: BetterAuthAdapter): MemberDirectoryShape => {
  const read = <A>(op: string, fn: () => Promise<A>): Effect.Effect<A, MemberDirectoryError> =>
    Effect.tryPromise(fn).pipe(
      Effect.tapCause((cause) => Effect.logError(`member_directory.${op} failed`, cause)),
      Effect.mapError(
        () => new MemberDirectoryError({ message: `Failed to read the member directory (${op})` }),
      ),
      Effect.withSpan(`member_directory.${op}`),
    );

  const undecodable = (op: string) => () =>
    new MemberDirectoryError({ message: `Undecodable member directory row (${op})` });

  const memberRows = (op: string, where: AdapterWhere) =>
    Effect.gen(function* () {
      const rows: (typeof MemberRow)["Type"][] = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = yield* read(op, () =>
          adapter.findMany({ model: "member", where, limit: PAGE_SIZE, offset }),
        ).pipe(Effect.flatMap(decodeMemberRows), Effect.mapError(undecodable(op)));
        rows.push(...page);
        if (page.length < PAGE_SIZE) return rows;
      }
    });

  const userRows = (op: string, userIds: readonly string[]) =>
    Effect.gen(function* () {
      const users = new Map<string, (typeof UserRow)["Type"]>();
      for (let start = 0; start < userIds.length; start += IN_CHUNK) {
        const ids = userIds.slice(start, start + IN_CHUNK);
        const page = yield* read(op, () =>
          adapter.findMany({
            model: "user",
            where: [{ field: "id", operator: "in", value: [...ids] }],
            limit: ids.length,
          }),
        ).pipe(Effect.flatMap(decodeUserRows), Effect.mapError(undecodable(op)));
        for (const user of page) users.set(user.id, user);
      }
      return users;
    });

  // Every read: the member rows matching `where`, joined to their users. A
  // member whose user row is gone is not reported — there is no principal
  // behind it to name.
  const load = (op: string, where: AdapterWhere) =>
    Effect.gen(function* () {
      const rows = yield* memberRows(op, where);
      const users = yield* userRows(
        op,
        rows.map((row) => row.userId),
      );
      const members: DirectoryMember[] = [];
      for (const row of rows) {
        const user = users.get(row.userId);
        if (user === undefined) continue;
        members.push({
          accountId: row.userId,
          membershipId: row.id,
          organizationId: row.organizationId,
          email: user.email,
          name: user.name ?? null,
          avatarUrl: user.image ?? null,
          role: row.role,
          status: "active",
          lastActiveAt: null,
        });
      }
      return members;
    });

  const orgWhere = (organizationId: string): AdapterWhere => [
    { field: "organizationId", value: organizationId },
  ];

  const matches = (member: DirectoryMember, term: string): boolean =>
    (member.email !== null && member.email.toLowerCase().includes(term)) ||
    (member.name !== null && member.name.toLowerCase().includes(term));

  return {
    membership: (accountId, organizationId) =>
      load("membership", [
        { field: "userId", value: accountId },
        { field: "organizationId", value: organizationId },
      ]).pipe(Effect.map((members) => members[0] ?? null)),

    membershipById: (organizationId, membershipId) =>
      load("membershipById", [
        { field: "id", value: membershipId },
        { field: "organizationId", value: organizationId },
      ]).pipe(Effect.map((members) => members[0] ?? null)),

    membershipsOf: (accountId, statuses = DEFAULT_MEMBER_STATUSES) =>
      // Every Better Auth member is active; a query for other statuses only
      // has nothing to report.
      !statuses.includes("active")
        ? Effect.succeed([])
        : load("membershipsOf", [{ field: "userId", value: accountId }]).pipe(
            Effect.map((members) =>
              [...members].sort((a, b) =>
                a.organizationId < b.organizationId
                  ? -1
                  : a.organizationId > b.organizationId
                    ? 1
                    : 0,
              ),
            ),
          ),

    members: (organizationId, query: MemberQuery = {}) =>
      Effect.gen(function* () {
        const statuses = query.statuses ?? DEFAULT_MEMBER_STATUSES;
        // Every Better Auth member is active; a query for other statuses only
        // has nothing to report.
        if (!statuses.includes("active")) return [];
        const term = normalizeMemberSearch(query.search);
        const all = yield* load("members", orgWhere(organizationId));
        const matched = term === undefined ? all : all.filter((m) => matches(m, term));
        matched.sort(byEmailThenAccount);
        const start = query.offset ?? 0;
        const end = query.limit === undefined ? undefined : start + query.limit;
        return matched.slice(start, end);
      }),

    membersById: (organizationId, accountIds) =>
      Effect.gen(function* () {
        const found = new Map<string, DirectoryMember>();
        for (let start = 0; start < accountIds.length; start += IN_CHUNK) {
          const ids = accountIds.slice(start, start + IN_CHUNK);
          const members = yield* load("membersById", [
            { field: "organizationId", value: organizationId },
            { field: "userId", operator: "in", value: [...ids] },
          ]);
          for (const member of members) found.set(member.accountId, member);
        }
        return found;
      }),

    findByEmail: (organizationId, email) =>
      load("findByEmail", orgWhere(organizationId)).pipe(
        Effect.map(
          (members) =>
            members.find(
              (member) => member.email !== null && normalizeAdminUserEmail(member.email) === email,
            ) ?? null,
        ),
      ),
  };
};

/** The self-host `MemberDirectory` over the boot-scoped Better Auth handle. */
export const betterAuthMemberDirectoryLayer: Layer.Layer<MemberDirectory, never, BetterAuth> =
  Layer.effect(MemberDirectory)(
    Effect.gen(function* () {
      const { auth } = yield* BetterAuth;
      const { adapter } = yield* Effect.promise(() => auth.$context);
      return MemberDirectory.of(makeService(adapter));
    }),
  );
