import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { StorageError, type App, type VersionId } from "@executor-js/sdk/core";

/**
 * One-off, kept for its recorded migration steps: queued member setup for every organization when
 * member setup still redeployed the default Executor app to the current template. Member setup no
 * longer changes the app, so these jobs only link missing keys. Do not append new steps.
 *
 * Jobs start after a delay so the replacement server, not the one still serving during the
 * deployment, runs them.
 */
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

/**
 * After a data step redeploys an organization's default Executor app, record the new version
 * where the replaced one was recorded. Member setup trusts only the recorded version as
 * Executor's own; a copy recorded under another version, or none, stays as it was. The host
 * names how the step wakes webhook source reconciliation, which the new version leaves pending.
 */
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
      // Polling recovers a missed wake.
      yield* wake;
    });

/**
 * One-off: member setup once linked a managed key only for owners and admins, so members who
 * joined before it linked one for every member have none. Queue their member setup once. Setup
 * records each member it handles, including one who later deletes their key, so a recorded member
 * is never queued.
 *
 * Jobs start after a delay so the replacement server, whose member setup links members' keys,
 * runs them, not the one still serving during the deployment.
 */
export const queueMemberExecutorKeys = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`insert into hosted_provisioning (kind, organization_id, user_id, available_at)
    select 'member', organization.id, member."userId", now() + interval '15 minutes'
    from organization
    join member on member."organizationId" = organization.id and member.role = 'member'
    where coalesce((organization.metadata::jsonb -> 'executorDefaults' ->> 'installed')::boolean, false)
      and organization.metadata::jsonb -> 'executorKeyAccounts' -> member."userId" is null`;
});
