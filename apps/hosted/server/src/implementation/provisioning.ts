/** Host-owned lifecycle jobs. No browser session, secrets, or live request enters the queue. */
import { StorageError } from "@executor-js/sdk/core";
import { Effect, Exit, Schedule, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { OrganizationId } from "../contracts/organization.ts";
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
const Manager = Schema.Struct({ userId: Schema.String, name: Schema.String });
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
/** Another attempt claimed the job and may still be running it. */
class ClaimInFlight extends Schema.TaggedError<ClaimInFlight>()("ClaimInFlight", {}) {}
const Claimed = Schema.Struct({ attempts: Schema.Number });
/**
 * Wait while another attempt's claim is fresh. A failed or cut-short attempt releases its claim
 * at once; a killed one cannot, so a claim expires after 20 seconds, longer than the request
 * runner's 15-second bound. Dispatch marks a job `running` without claiming it (`attempts` is
 * unchanged), so a job nobody has attempted never waits.
 */
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
/**
 * Start one attempt at a committed event, or stop when another runner already finished it.
 * Claiming is one statement, so an attempt that starts after success cannot reopen the job.
 * `kind` limits the attempt to that job kind; other jobs are left untouched.
 *
 * The request runner claims at once: it starts right after the job's workflow is created, which
 * then finds the claim and waits for it instead of repeating the same work beside it. An attempt
 * that fails or is cut short returns the job to `queued`, so the waiting runner continues.
 */
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
    // Another runner finished this job, or it is not of the requested kind.
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
      // Release only this attempt's own claim; a later claim belongs to another runner.
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

/** Owners and admins whose default profile member setup provides; read live. */
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

/** Install the organization's defaults. Concurrent runs are safe: defaults install one app. */
const installTeam = (organization: OrganizationId, requireVerifiedEmail: boolean, id: string) =>
  Effect.gen(function* () {
    const initialize = yield* OrganizationDefaults;
    yield* initialize(organization);
    // Member jobs that ran before installation finished wait for their retry delay. Set up
    // those members now, so their default profile follows the installation at once. Their
    // own jobs still own member setup and find it done.
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

/** Execute one committed event. Membership is read live and checked again by defaults under its lock. */
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

/**
 * Run a team installation job now, beside its durable runner. Call this only after that runner
 * exists: an attempt that fails or is cut short leaves the job `running` for the durable runner
 * to finish. Other job kinds are not touched.
 */
export const provisionTeam = (id: string, requireVerifiedEmail: boolean) =>
  attempt(id, "request", "team", (job) =>
    job.kind === "team"
      ? installTeam(job.organization_id, requireVerifiedEmail, id)
      : Effect.die(new Error("Claimed a job of another kind")),
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
      // Self-host polls every second. The poll records nothing; the jobs it finds are traced.
      Effect.withTracerEnabled(false),
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

/**
 * Read whether initial team installation is active and its app is still absent. Never restarts
 * setup. The caller reads the app's presence through the SDK and passes it in.
 */
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
