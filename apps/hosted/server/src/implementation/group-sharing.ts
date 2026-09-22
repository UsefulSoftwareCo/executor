/** Group destinations require current membership; organization admins may target any group. */
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { GroupId, GroupMemberId } from "../contracts/groups.ts";
import {
  OrganizationForbidden,
  OrganizationRole,
  type OrganizationId,
} from "../contracts/organization.ts";

const Member = Schema.Struct({ id: GroupMemberId, role: OrganizationRole });

/** Call inside the resource transaction. Locks prevent membership edits racing the grant write. */
export const requireGroupSharing = (
  sql: SqlClient.SqlClient,
  organization: OrganizationId,
  user: string | undefined,
  groups: readonly GroupId[],
) =>
  Effect.gen(function* () {
    if (groups.length === 0) return;
    if (user === undefined) return yield* new OrganizationForbidden();
    const members =
      yield* sql`select id, role from member where "organizationId" = ${organization} and "userId" = ${user} for share`;
    const actor = (yield* Schema.decodeUnknownEffect(Schema.Array(Member))(members))[0];
    if (members.length !== 1 || actor === undefined) return yield* new OrganizationForbidden();
    // Group edits lock the same rows before replacing memberships. Keep these locks until commit.
    const existing =
      yield* sql`select id from hosted_groups where organization_id = ${organization} and ${sql.in("id", groups)} order by id for share`;
    if (existing.length !== groups.length) return yield* new OrganizationForbidden();
    if (actor.role !== "member") return;
    const memberships =
      yield* sql`select group_id from hosted_group_members where member_id = ${actor.id} and ${sql.in("group_id", groups)} for share`;
    if (memberships.length !== groups.length) return yield* new OrganizationForbidden();
  });
