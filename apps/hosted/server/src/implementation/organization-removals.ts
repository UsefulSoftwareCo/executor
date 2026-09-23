/** Tombstone storage: one row hides an organization from the moment removal is accepted. */
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { OrganizationId } from "../contracts/organization.ts";
import {
  OrganizationRemovalRecord,
  OrganizationRemovalUnavailable,
  OrganizationRemovals,
} from "../contracts/organization-removal.ts";

const unavailable = () => new OrganizationRemovalUnavailable();
const Row = Schema.Struct({
  organization_id: OrganizationRemovalRecord.fields.organization,
  instance_id: OrganizationRemovalRecord.fields.instance,
  status: OrganizationRemovalRecord.fields.status,
  logo: OrganizationRemovalRecord.fields.logo,
});
const decode = (rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(Row))(rows).pipe(
    Effect.mapError(unavailable),
    Effect.map(
      (decoded) =>
        decoded.map((row) => ({
          organization: row.organization_id,
          instance: row.instance_id,
          status: row.status,
          logo: row.logo,
        }))[0] ?? null,
    ),
  );

/** One store over the hosted database; the middleware and the workflow read the same rows. */
export const makeOrganizationRemovals = (
  database: Effect.Effect<SqlClient.SqlClient, OrganizationRemovalUnavailable>,
) => {
  const read = (organization: OrganizationId) =>
    database.pipe(
      Effect.flatMap(
        (sql) =>
          sql`select organization_id, instance_id, status, logo from hosted_organization_removal where organization_id = ${organization}`,
      ),
      Effect.mapError(unavailable),
      Effect.flatMap(decode),
    );
  return {
    tombstones: (organization: OrganizationId) =>
      Effect.map(read(organization), (record) => record !== null),
    removals: OrganizationRemovals.of({
      read,
      // Accepting the same removal twice must reuse the first instance, or a
      // retried request would start a second workflow over the same records.
      begin: (organization, instance) =>
        database.pipe(
          Effect.flatMap(
            (sql) =>
              sql`insert into hosted_organization_removal (organization_id, instance_id)
                values (${organization}, ${instance})
                on conflict (organization_id) do nothing`,
          ),
          Effect.mapError(unavailable),
          Effect.andThen(read(organization)),
          Effect.flatMap((record) =>
            record === null ? Effect.fail(unavailable()) : Effect.succeed(record),
          ),
        ),
      // Written by the step that deletes the organization row, so a replay of
      // the icon step can still address an icon whose owning row is long gone.
      recordLogo: (organization, logo) =>
        database.pipe(
          Effect.flatMap(
            (sql) =>
              sql`update hosted_organization_removal set logo = ${logo} where organization_id = ${organization}`,
          ),
          Effect.mapError(unavailable),
          Effect.asVoid,
        ),
      finish: (organization) =>
        database.pipe(
          Effect.flatMap(
            (sql) =>
              sql`update hosted_organization_removal set status = 'done', finished_at = now()
                where organization_id = ${organization}`,
          ),
          Effect.mapError(unavailable),
          Effect.asVoid,
        ),
    }),
  };
};
