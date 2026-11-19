import { StorageError } from "@executor-js/sdk/core";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { OrganizationId } from "../contracts/organization.ts";

/**
 * Whether a member may hold the Executor app's managed key: an owner or admin of the organization,
 * with a verified email where the product requires one. Member setup and key renewal both ask; the
 * rows read stay locked for share until the transaction ends.
 */
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
