import {
  recoverContributedDepartures,
  removeContributedDeparture,
} from "./contributed-account-departure.ts";
export { recoverContributedDepartures };
import { StorageError } from "@executor-js/sdk/core";
import { Effect, Exit, Schedule, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { traceFailure } from "@executor-js/telemetry/failed-span";
import { OrganizationId } from "../contracts/organization.ts";
import {
  OrganizationDefaults,
  OrganizationDefaultsPending,
} from "../contracts/organization-defaults.ts";

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
const Manager = Schema.Struct({ userId: Schema.String, name: Schema.String });
export class ProvisioningFailed extends Schema.TaggedError<ProvisioningFailed>()(
  "ProvisioningFailed",
  {},
) {}
export interface ProvisioningServices {
  readonly requireVerifiedEmail: boolean;
  readonly user: (id: string) => Effect.Effect<void, ProvisioningFailed>;
  readonly billing: (id: OrganizationId) => Effect.Effect<void, ProvisioningFailed>;
  readonly domain: Effect.Effect<void, ProvisioningFailed>;
}
export const selfHostProvisioningServices: ProvisioningServices = {
  requireVerifiedEmail: false,
  user: () => Effect.void,
  billing: () => Effect.void,
  domain: Effect.void,
};
class ClaimInFlight extends Schema.TaggedError<ClaimInFlight>()("ClaimInFlight", {}) {}
const Claimed = Schema.Struct({ attempts: Schema.Number });
const awaitClaims = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const claimed = yield* sql`select 1 from hosted_provisioning where id = ${id}
      and status = 'running' and attempts > 0 and updated_at > now() - interval '20 seconds'`;
    if (claimed.length > 0) return yield* new ClaimInFlight();
  }).pipe(
    Effect.retry({
      while: Schema.is(ClaimInFlight),
      schedule: Schedule.spaced("1 second"),
      times: 25,
    }),
    Effect.catchTag("ClaimInFlight", () => Effect.void),
  );
const attempt = <E, R>(
  id: string,
  runner: "request" | "background",
  kind: typeof ProvisioningJob.Type.kind | undefined,
  run: (job: typeof ProvisioningJob.Type) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.annotateCurrentSpan({
      "executor.provisioning.job": id,
      "executor.provisioning.runner": runner,
    });
    if (runner === "background") yield* awaitClaims(id);
    const rows = yield* sql`update hosted_provisioning
      set status = 'running', attempts = attempts + 1, updated_at = now()
      where id = ${id} and status <> 'succeeded'
        and (${kind ?? null}::text is null or kind = ${kind ?? null}::text)
      returning *`;
    if (rows.length === 0)
      return yield* Effect.annotateCurrentSpan("executor.provisioning.claimed", false);
    yield* Effect.annotateCurrentSpan("executor.provisioning.claimed", true);
    const job = yield* Schema.decodeUnknownEffect(ProvisioningJob)(rows[0]);
    const { attempts } = yield* Schema.decodeUnknownEffect(Claimed)(rows[0]);
    yield* Effect.annotateCurrentSpan({
      "executor.provisioning.kind": job.kind,
      ...(job.kind === "user" ? {} : { "executor.organization.id": job.organization_id }),
    });
    yield* run(job).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : sql`update hosted_provisioning set status = 'queued', updated_at = now()
              where id = ${id} and status = 'running' and attempts = ${attempts}`.pipe(
              Effect.ignore,
            ),
      ),
    );
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

const managers = (organization: OrganizationId, requireVerifiedEmail: boolean, user?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`select "user".id as "userId", "user".name from member join "user" on "user".id = member."userId"
      where member."organizationId" = ${organization}
      and (${user ?? null}::text is null or member."userId" = ${user ?? null}::text)
      and member.role in ('owner', 'admin') and (${requireVerifiedEmail} = false or "user"."emailVerified" = true)`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Manager))),
    );
  });

const installTeam = (organization: OrganizationId, requireVerifiedEmail: boolean, id: string) =>
  Effect.gen(function* () {
    const initialize = yield* OrganizationDefaults;
    yield* initialize(organization);
    for (const member of yield* managers(organization, requireVerifiedEmail))
      yield* initialize(organization, member).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Member setup after team installation failed", {
            job: id,
            reason: Schema.is(Schema.Struct({ _tag: Schema.String }))(error)
              ? error._tag
              : "unknown",
          }),
        ),
      );
  });

export const provision = (id: string, services: ProvisioningServices) =>
  attempt(id, "background", undefined, (job) =>
    Effect.gen(function* () {
      switch (job.kind) {
        case "user":
          return yield* services.user(job.user_id);
        case "team":
          return yield* installTeam(job.organization_id, services.requireVerifiedEmail, id);
        case "billing":
          return yield* services.billing(job.organization_id);
        case "domain":
          return yield* services.domain;
        case "member": {
          if (job.id.startsWith("contributed-departure-"))
            return yield* removeContributedDeparture({
              id: job.id,
              organization: job.organization_id,
              user: job.user_id,
            });
          const initialize = yield* OrganizationDefaults;
          const [member] = yield* managers(
            job.organization_id,
            services.requireVerifiedEmail,
            job.user_id,
          );
          if (member !== undefined) yield* initialize(job.organization_id, member);
          return;
        }
      }
    }),
  );

export const provisionTeam = (id: string, requireVerifiedEmail: boolean) =>
  attempt(id, "request", "team", (job) =>
    job.kind === "team"
      ? installTeam(job.organization_id, requireVerifiedEmail, id)
      : Effect.die(new Error("Claimed a job of another kind")),
  );

export const drainProvisioning = (services: ProvisioningServices) =>
  Effect.gen(function* () {
    yield* recoverContributedDepartures;
    const sql = yield* SqlClient.SqlClient;
    const jobs = yield* sql`select id from hosted_provisioning where
    (status = 'queued' and available_at <= now()) or (status = 'running' and updated_at < now() - interval '10 minutes')
    order by available_at, case when kind = 'team' then 0 else 1 end limit 20`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String }))),
      ),
      Effect.withTracerEnabled(false),
      traceFailure("hosted.provisioning.poll"),
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

export const teamAppPending = (organization: OrganizationId, appInstalled: boolean) =>
  Effect.gen(function* () {
    if (appInstalled) return false;
    const sql = yield* SqlClient.SqlClient;
    const [state] = yield* sql`select exists (
      select 1 from hosted_provisioning job join organization team on team.id = job.organization_id
      where job.kind = 'team' and job.organization_id = ${organization}
        and job.status in ('queued', 'running')
        and not coalesce((team.metadata::jsonb -> 'executorDefaults' ->> 'installed')::boolean, false)
    ) as pending`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ pending: Schema.Boolean })])),
      ),
    );
    return state.pending;
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );
