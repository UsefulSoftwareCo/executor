/** Durable snapshots survive membership removal and old servers acknowledging member jobs. */
import { AccountId, AppId, StorageError, StorageHost } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { organizationOwner, type OrganizationId } from "../contracts/organization.ts";
import { lockAppLinks, removeLink } from "./app-accounts.ts";
import { isContributed } from "./contributed-account-policy.ts";

/** Old servers understand the member job but leave its snapshots. Recover their acknowledgements. */
export const recoverContributedDepartures = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const acknowledged = yield* sql<{ readonly id: string }>`select p.id from hosted_provisioning p
    where p.status = 'succeeded' and exists (select 1 from hosted_contributed_departures d where d.job = p.id)`;
  for (const job of acknowledged)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const pending = yield* sql<{
          readonly organization: string;
          readonly user: string;
        }>`select organization_id as organization, user_id as "user"
        from hosted_provisioning p where id = ${job.id} and status = 'succeeded'
          and exists (select 1 from hosted_contributed_departures d where d.job = p.id)
        for update`;
        const original = pending[0];
        if (original === undefined) return;
        // A completed Cloud workflow cannot run again. A new job ID creates a new workflow.
        const [replacement] = yield* sql<{
          readonly id: string;
        }>`insert into hosted_provisioning (id, kind, organization_id, user_id)
        values ('contributed-departure-' || gen_random_uuid()::text, 'member', ${original.organization}, ${original.user}) returning id`;
        if (replacement === undefined) return yield* new StorageError();
        yield* sql`update hosted_contributed_departures set job = ${replacement.id} where job = ${job.id}`;
      }),
    );
}).pipe(Effect.catchTag("SqlError", () => new StorageError()));

const DepartureLink = Schema.Struct({ app: AppId, requirement: Schema.String, account: AccountId });

export const removeContributedDeparture = (input: {
  readonly id: string;
  readonly organization: OrganizationId;
  readonly user: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const executor = yield* Effect.flatten(HostedExecutor);
    const owner = organizationOwner(input.organization);
    const snapshots = yield* Schema.decodeUnknownEffect(Schema.Array(DepartureLink))(
      yield* sql`select app, requirement, account from hosted_contributed_departures
        where job = ${input.id} order by app, requirement, account`,
    );
    for (const link of snapshots)
      yield* executor[StorageHost].transaction(
        Effect.gen(function* () {
          yield* lockAppLinks(sql, link.app);
          // Compare the original link time: a rejoining member's new link is a different contribution.
          const live = yield* sql`select 1 from hosted_app_account_links l
            join executor_accounts a on a.id = l.account and a.owner = ${owner}
            join hosted_account_access p on p.account_id = a.id and p.organization_id = ${input.organization}
            join hosted_contributed_departures d on d.job = ${input.id}
              and d.app = l.app and d.requirement = l.requirement and d.account = l.account
              and d.linked_at = l.created_at
            where l.app = ${link.app} and l.requirement = ${link.requirement} and l.account = ${link.account}
              and l.subject is null and l.linked_by = ${input.user}
              and p.kind = 'personal' and p.personal_user_id = ${input.user}`;
          if (live.length > 0 && (yield* isContributed(sql, link.app, link.requirement)))
            yield* removeLink(sql, executor.webhooks, { ...link, subject: null });
          // Deleting the snapshot and unlinking commit together, including webhook source changes.
          yield* sql`delete from hosted_contributed_departures
            where job = ${input.id} and app = ${link.app} and requirement = ${link.requirement} and account = ${link.account}`;
        }),
      );
    if (snapshots.length > 0) yield* Effect.flatten(ScheduleWakeup);
  }).pipe(Effect.mapError(() => new StorageError()));
