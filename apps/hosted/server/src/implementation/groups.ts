/** Group writes commit metadata and memberships together, after locking current authority. */
import { Effect, Schema } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HostedApi } from "../contracts/api.ts";
import {
  CurrentOrganization,
  OrganizationForbidden,
  OrganizationRole,
} from "../contracts/organization.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import {
  Group,
  GroupMember,
  GroupMemberId,
  GroupId,
  GroupInput,
  GroupRevision,
  GroupConflict,
  GroupNotFound,
  GroupsUnavailable,
  GroupDatabase,
} from "../contracts/groups.ts";

const StoredGroup = Schema.Struct({
  id: GroupId,
  name: Schema.String,
  description: Schema.String,
  revision: GroupRevision,
});
const Membership = Schema.Struct({ group: GroupId, member: GroupMemberId });
const storageFailure = (error: SqlError.SqlError) =>
  Schema.is(SqlError.UniqueViolation)(error.reason)
    ? new GroupConflict({ reason: "name_taken" })
    : new GroupsUnavailable();
const decodeRows = <A>(schema: Schema.Decoder<A>, rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
    Effect.mapError(() => new GroupsUnavailable()),
  );

/** Protect writes from role removal racing middleware; no client-supplied owner is accepted. */
const lockAdmin = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const organization = yield* CurrentOrganization;
  const user = yield* CurrentUserId;
  if (user === undefined || organization.role === "member")
    return yield* new OrganizationForbidden();
  const allowed =
    yield* sql`select id from member where "organizationId" = ${organization.organization} and "userId" = ${user} and role in ('owner', 'admin') for share`;
  if (allowed.length !== 1) return yield* new OrganizationForbidden();
  return organization.organization;
});

const groupReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { organization } = yield* CurrentOrganization;
  const user = yield* CurrentUserId;
  if (user === undefined) return yield* new OrganizationForbidden();
  const rows =
    yield* sql`select id, role from member where "organizationId" = ${organization} and "userId" = ${user}`;
  const actor = (yield* decodeRows(
    Schema.Struct({ id: GroupMemberId, role: OrganizationRole }),
    rows,
  ))[0];
  if (rows.length !== 1 || actor === undefined) return yield* new OrganizationForbidden();
  return { ...actor, organization };
});

const readGroup = (id: GroupId, lock = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const actor = yield* groupReader;
    const { organization } = actor;
    const rows = yield* sql`select g.id, g.name, g.description, g.revision from hosted_groups g
      where g.id = ${id} and g.organization_id = ${organization}
      and (${actor.role !== "member"} or exists (select 1 from hosted_group_members gm where gm.group_id = g.id and gm.member_id = ${actor.id}))
      ${lock ? sql`for update` : sql``}`;
    const group = (yield* decodeRows(StoredGroup, rows))[0];
    if (group === undefined) return yield* new GroupNotFound();
    const members =
      yield* sql`select gm.member_id as id from hosted_group_members gm join member m on m.id = gm.member_id where gm.group_id = ${id} and m."organizationId" = ${organization} order by gm.member_id`;
    return {
      ...group,
      memberIds: (yield* decodeRows(Schema.Struct({ id: GroupMemberId }), members)).map(
        (member) => member.id,
      ),
    };
  });

const listGroups = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const access = yield* groupReader;
  const groups =
    yield* sql`select g.id, g.name, g.description, g.revision from hosted_groups g where g.organization_id = ${access.organization}
    and (${access.role !== "member"} or exists (select 1 from hosted_group_members gm where gm.group_id = g.id and gm.member_id = ${access.id}))
    order by lower(g.name), g.id`.pipe(Effect.flatMap((rows) => decodeRows(StoredGroup, rows)));
  const groupIds = groups.map((group) => group.id);
  const memberships =
    yield* sql`select gm.group_id as "group", gm.member_id as member from hosted_group_members gm join hosted_groups g on g.id = gm.group_id join member m on m.id = gm.member_id where g.organization_id = ${access.organization} and m."organizationId" = ${access.organization} and ${sql.in("g.id", groupIds)} order by gm.member_id`.pipe(
      Effect.flatMap((rows) => decodeRows(Membership, rows)),
    );
  const members =
    yield* sql`select m.id, m."userId", u.name, u.email from member m join "user" u on u.id = m."userId" where m."organizationId" = ${access.organization}
    and (${access.role !== "member"} or exists (select 1 from hosted_group_members gm where gm.member_id = m.id and ${sql.in("gm.group_id", groupIds)}))
    order by lower(u.name), m.id`.pipe(Effect.flatMap((rows) => decodeRows(GroupMember, rows)));
  return {
    groups: groups.map((group) => ({
      ...group,
      memberIds: memberships
        .filter((member) => member.group === group.id)
        .map((member) => member.member),
    })),
    members,
    canManage: access.role !== "member",
  };
});

const saveGroup = (
  input: typeof GroupInput.Type,
  current?: { readonly id: GroupId; readonly revision: typeof GroupRevision.Type },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const organization = yield* lockAdmin;
    if (current !== undefined && (yield* readGroup(current.id, true)).revision !== current.revision)
      return yield* new GroupConflict({ reason: "changed" });
    // Membership row locks and foreign keys prevent deletion between validation and insert.
    if (input.memberIds.length > 0) {
      const members =
        yield* sql`select id from member where "organizationId" = ${organization} and ${sql.in("id", input.memberIds)} for key share`;
      if (members.length !== input.memberIds.length)
        return yield* new GroupConflict({ reason: "members_changed" });
    }
    const changed =
      current === undefined
        ? yield* sql`insert into hosted_groups (organization_id, name, description) values (${organization}, ${input.name}, ${input.description}) returning id, name, description, revision`
        : yield* sql`update hosted_groups set name = ${input.name}, description = ${input.description}, revision = gen_random_uuid()::text where id = ${current.id} and organization_id = ${organization} returning id, name, description, revision`;
    const group = (yield* decodeRows(StoredGroup, changed))[0];
    if (group === undefined) return yield* new GroupNotFound();
    yield* sql`delete from hosted_group_members where group_id = ${group.id}`;
    if (input.memberIds.length > 0)
      yield* sql`insert into hosted_group_members ${sql.insert(input.memberIds.map((member) => ({ group_id: group.id, member_id: member })))}`;
    return { ...group, memberIds: input.memberIds } satisfies Group;
  });
const removeGroup = (id: GroupId, revision: typeof GroupRevision.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const organization = yield* lockAdmin;
    if ((yield* readGroup(id, true)).revision !== revision)
      return yield* new GroupConflict({ reason: "changed" });
    yield* sql`delete from hosted_groups where id = ${id} and organization_id = ${organization}`;
    return { id };
  });

const run = <A, R>(
  operation: Effect.Effect<
    A,
    GroupConflict | GroupNotFound | GroupsUnavailable | OrganizationForbidden | SqlError.SqlError,
    R | SqlClient.SqlClient
  >,
  write = false,
) =>
  Effect.gen(function* () {
    if (write) {
      const access = yield* CurrentOrganization;
      if (access.role === "member") return yield* new OrganizationForbidden();
    }
    const sql = yield* Effect.flatten(GroupDatabase);
    return yield* (write ? sql.withTransaction(operation) : operation).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  }).pipe(Effect.catchTag("SqlError", (error) => Effect.fail(storageFailure(error))));

/** Shared typed handlers acquire storage only after request authentication and write permission. */
export const hostedGroupHandlers = HttpApiBuilder.group(HostedApi, "groups", (handlers) =>
  handlers
    .handle("list", () => run(listGroups))
    .handle("get", ({ params }) => run(readGroup(params.group)))
    .handle("create", ({ payload }) => run(saveGroup(payload), true))
    .handle("update", ({ params, payload }) =>
      run(saveGroup(payload, { id: params.group, revision: payload.revision }), true),
    )
    .handle("remove", ({ params, payload }) =>
      run(removeGroup(params.group, payload.revision), true),
    ),
);
