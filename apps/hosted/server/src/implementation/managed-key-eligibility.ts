import { StorageError } from "@executor-js/sdk/core";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { OrganizationId } from "../contracts/organization.ts";

export const managedKeyEligible = (
  sql: SqlClient.SqlClient,
  organization: OrganizationId,
  user: string,
  requireVerifiedEmail: boolean,
) =>
  sql`select member.id from member join "user" on "user".id = member."userId"
    where member."organizationId" = ${organization} and member."userId" = ${user}
    and member.role in ('owner', 'admin') and (${requireVerifiedEmail} = false or "user"."emailVerified" = true)
    for share of member, "user"`.pipe(
    Effect.map((rows) => rows.length === 1),
    Effect.mapError(() => new StorageError()),
  );
