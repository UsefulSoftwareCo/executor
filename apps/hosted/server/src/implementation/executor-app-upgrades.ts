import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { StorageError, type App, type VersionId } from "@executor-js/sdk/core";

export const queueExecutorAppUpgrades = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`insert into hosted_provisioning (kind, organization_id, user_id, available_at)
    select distinct on (organization.id) 'member', organization.id, member."userId", now() + interval '15 minutes'
    from organization
    join member on member."organizationId" = organization.id and member.role in ('owner', 'admin')
    join "user" on "user".id = member."userId"
    where organization.metadata::jsonb -> 'executorDefaults' ->> 'deployment' is not null
    order by organization.id, "user"."emailVerified" desc, member.role = 'owner' desc, member."createdAt"`;
});

export const executorDefaultRedeployed =
  (wake: Effect.Effect<void>) => (app: App, replaced: VersionId, version: VersionId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`update "organization" set metadata = jsonb_set(
        metadata::jsonb, '{executorDefaults,deployment}', to_jsonb(${version}::text)
      )::text
      where metadata::jsonb -> 'executorDefaults' ->> 'app' = ${app.id}
        and metadata::jsonb -> 'executorDefaults' ->> 'deployment' = ${replaced}`.pipe(
        Effect.mapError(() => new StorageError()),
      );
      yield* wake;
    });
