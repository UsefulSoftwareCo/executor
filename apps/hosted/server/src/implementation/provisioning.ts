/** Host-owned lifecycle jobs. No browser session, secrets, or live request enters the queue. */
import { StorageError } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { OrganizationId, organizationOwner } from "../contracts/organization.ts";
import {
  OrganizationDefaults,
  OrganizationDefaultsPending,
} from "../contracts/organization-defaults.ts";

/** Parsed durable event; constraints in the table mirror these variants. */
export const ProvisioningJob = Schema.Union([
  Schema.Struct({ id: Schema.String, kind: Schema.Literal("user"), user_id: Schema.String }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("member"),
    organization_id: OrganizationId,
    user_id: Schema.String,
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literals(["team", "billing", "domain"]),
    organization_id: OrganizationId,
  }),
]);
/** A safe failure projection for background logs and workflow retries. */
export class ProvisioningFailed extends Schema.TaggedError<ProvisioningFailed>()(
  "ProvisioningFailed",
  {},
) {}
/** Optional product services stay owned by the host, not by shared auth or the SDK. */
export interface ProvisioningServices {
  readonly requireVerifiedEmail: boolean;
  readonly user: (id: string) => Effect.Effect<void, ProvisioningFailed>;
  readonly billing: (id: OrganizationId) => Effect.Effect<void, ProvisioningFailed>;
  readonly domain: Effect.Effect<void, ProvisioningFailed>;
}
/** Self-host has no cloud welcome mail, billing, or managed DNS. */
export const selfHostProvisioningServices: ProvisioningServices = {
  requireVerifiedEmail: false,
  user: () => Effect.void,
  billing: () => Effect.void,
  domain: Effect.void,
};
/** Execute one committed event. Membership is read live and checked again by defaults under its lock. */
export const provision = (id: string, services: ProvisioningServices) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`select * from hosted_provisioning where id = ${id} and status <> 'succeeded'`;
    if (rows.length === 0) return;
    const job = yield* Schema.decodeUnknownEffect(ProvisioningJob)(rows[0]);
    const initialize = yield* OrganizationDefaults;
    yield* sql`update hosted_provisioning set status = 'running', attempts = attempts + 1, updated_at = now() where id = ${id}`;
    switch (job.kind) {
      case "user":
        yield* services.user(job.user_id);
        break;
      case "team":
        yield* initialize(job.organization_id);
        break;
      case "billing":
        yield* services.billing(job.organization_id);
        break;
      case "domain":
        yield* services.domain;
        break;
      case "member": {
        const members =
          yield* sql`select "user".name from member join "user" on "user".id = member."userId"
        where member."organizationId" = ${job.organization_id} and member."userId" = ${job.user_id}
        and member.role in ('owner', 'admin') and (${services.requireVerifiedEmail} = false or "user"."emailVerified" = true)`;
        if (members.length > 0) {
          const member = yield* Schema.decodeUnknownEffect(Schema.Struct({ name: Schema.String }))(
            members[0],
          );
          yield* initialize(job.organization_id, { userId: job.user_id, name: member.name });
        }
        break;
      }
    }
    yield* sql`update hosted_provisioning set status = 'succeeded', updated_at = now() where id = ${id}`;
  }).pipe(
    Effect.tapError((error) =>
      Schema.is(OrganizationDefaultsPending)(error)
        ? Effect.logDebug("Member setup is waiting for team installation", { job: id })
        : Effect.logWarning("Provisioning step failed", {
            job: id,
            reason: Schema.is(StorageError)(error) ? "storage" : "dependency",
          }),
    ),
    Effect.mapError(() => new ProvisioningFailed()),
    Effect.withSpan("hosted.provision"),
  );

/** Recover process interruption and retry with bounded exponential delay on the single self-host worker. */
export const drainProvisioning = (services: ProvisioningServices) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const jobs = yield* sql`select id from hosted_provisioning where
    (status = 'queued' and available_at <= now()) or (status = 'running' and updated_at < now() - interval '10 minutes')
    order by available_at, case when kind = 'team' then 0 else 1 end limit 20`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String }))),
      ),
    );
    for (const job of jobs)
      yield* provision(job.id, services).pipe(
        Effect.timeout("5 minutes"),
        Effect.catch(() =>
          Effect.gen(function* () {
            yield* sql`update hosted_provisioning set status = case when attempts >= 8 then 'failed' else 'queued' end,
        available_at = now() + least(300, power(2, attempts)) * interval '1 second', updated_at = now() where id = ${job.id}`;
            yield* Effect.logWarning("Provisioning attempt failed", { job: job.id });
          }),
        ),
      );
  }).pipe(Effect.mapError(() => new ProvisioningFailed()));

/** Read whether initial team installation is active and its app is still absent. Never restarts setup. */
export const teamAppPending = (organization: OrganizationId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [state] = yield* sql`select exists (
      select 1 from hosted_provisioning job join organization team on team.id = job.organization_id
      where job.kind = 'team' and job.organization_id = ${organization}
        and job.status in ('queued', 'running')
        and not coalesce((team.metadata::jsonb -> 'executorDefaults' ->> 'installed')::boolean, false)
        and not exists (select 1 from executor_apps app
          where app.owner = ${organizationOwner(organization)} and app.name = 'Executor')
    ) as pending`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ pending: Schema.Boolean })])),
      ),
    );
    return state.pending;
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );
