import { cloudArtifactsTokensLive } from "./artifacts-tokens.ts";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { Workflow } from "@cloudflare/workers-types";
import { Cause, Effect, Result, Schema } from "effect";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import { ScheduleWakeup } from "@executor-js/hosted-server";
import {
  provision,
  recoverContributedDepartures,
  provisionTeam,
  ProvisioningFailed,
  type ProvisioningServices,
} from "@executor-js/hosted-server/provisioning";
import { SqlClient } from "effect/sql";
import { cloudProduct } from "./product.ts";
import { appDataSupervisors } from "./app-data.ts";
import { cloudEmail } from "./email.ts";
import { cloudWelcomeEmails } from "./welcome-email.ts";
import { AppDomainCoordinator } from "./app-domains.ts";
import { AppDomainController } from "./app-domain-controller-worker.ts";
import { billingLive } from "../implementation/billing.ts";
import { BillingMeter } from "../contracts/billing-meter.ts";
import { cloudAnalytics } from "../implementation/product-analytics.ts";
import { jobUnits } from "../contracts/job-outcome.ts";
import { cloudBackgroundJobs } from "./background-jobs.ts";

export class Provisioning extends Cloudflare.Workflow<Provisioning>()(
  "Provisioning",
  Effect.gen(function* () {
    const executor = yield* cloudProduct(
      yield* appDataSupervisors,
      yield* cloudArtifactsTokensLive,
    );
    const emails = yield* cloudWelcomeEmails((yield* cloudEmail.pipe(Effect.orDie)).welcome);
    const domains = yield* AppDomainCoordinator.from(AppDomainController);
    const meter = yield* BillingMeter.pipe(Effect.provide(yield* billingLive.pipe(Effect.orDie)));
    const analytics = yield* cloudAnalytics;
    const jobs = yield* cloudBackgroundJobs;
    const services: ProvisioningServices = {
      requireVerifiedEmail: true,
      user: (id) =>
        emails.deliverUser(id).pipe(
          Effect.provide(RuntimeContext.phantom),
          Effect.mapError(() => new ProvisioningFailed()),
        ),
      billing: (id) => meter.syncSeats(id).pipe(Effect.mapError(() => new ProvisioningFailed())),
      domain: Effect.suspend(() => domains.getByName("domains").wake()).pipe(
        Effect.provide(RuntimeContext.phantom),
        Effect.mapError(() => new ProvisioningFailed()),
      ),
    };
    return (input: { id: string }) =>
      Effect.scoped(
        analytics.wrap(
          Effect.gen(function* () {
            const id = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(input.id);
            const step = yield* Cloudflare.Workflows.WorkflowStep;
            const context = yield* Effect.context<never>();
            yield* step
              .do({
                name: "provision",
                retries: { limit: 8, delay: "5 seconds", backoff: "exponential" },
                timeout: "5 minutes",
                effect: Effect.gen(function* () {
                  const sql = yield* Effect.flatten(GroupDatabase);
                  yield* provision(id, services).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                  );
                }).pipe(
                  Effect.provideService(ScheduleWakeup, Effect.void),
                  Effect.provide(executor),
                  Effect.scoped,
                  Effect.provideContext(context),
                  Effect.mapError(() => new ProvisioningFailed()),
                ),
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.interrupt
                    : Effect.gen(function* () {
                        const sql = yield* Effect.flatten(GroupDatabase).pipe(
                          Effect.provide(executor),
                        );
                        yield* sql`update hosted_provisioning set status = 'failed', updated_at = now() where id = ${id} and status <> 'succeeded'`;
                        yield* Effect.logError("Provisioning workflow failed", { job: id });
                        return yield* Effect.die(new Error("Provisioning failed"));
                      }),
                ),
              );
            yield* step
              .do({
                name: "schedule-wake",
                retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
                timeout: "1 minute",
                effect: jobs
                  .request("schedule-wake")
                  .pipe(Effect.provideContext(context), Effect.orDie),
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.interrupt
                    : Effect.logError("Schedule wake after provisioning failed", { job: id }),
                ),
              );
          }).pipe(Effect.orDie),
        ),
      );
  }),
) {}

const NativeProvisioning = Schema.declare(
  (value): value is Pick<Workflow<{ id: string }>, "get" | "create"> =>
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function" &&
    "create" in value &&
    typeof value.create === "function",
);
const ClaimedJobs = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literals(["user", "member", "team", "billing", "domain"]),
  }),
);
export const dispatchProvisioning = <R>(
  installTeam: (job: string) => Effect.Effect<void, never, R>,
) =>
  Effect.gen(function* () {
    const environment = yield* Cloudflare.WorkerEnvironment;
    const binding = yield* Schema.decodeUnknownEffect(NativeProvisioning)(environment.Provisioning);
    const sql = yield* Effect.flatten(GroupDatabase);
    yield* recoverContributedDepartures.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const jobs =
      // Claim a short dispatch lease in one statement. Concurrent request finalizers
      // must not each submit the same queued jobs to the provider. A lost dispatch
      // becomes eligible again; the workflow ID remains the durable identity.
      yield* sql`with candidates as (
      select id from hosted_provisioning where available_at <= now() and
        (status = 'queued' or (status = 'running' and updated_at < now() - interval '30 minutes'))
      order by case when kind = 'team' then 0 else 1 end, available_at
      for update skip locked limit 50
    ) update hosted_provisioning job set available_at = now() + interval '30 seconds'
      from candidates where job.id = candidates.id returning job.id, job.kind`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ClaimedJobs)),
    );
    const dispatched = yield* Effect.forEach(
      jobs,
      (job) =>
        Effect.gen(function* () {
          const status = yield* Effect.tryPromise({
            try: async () => {
              try {
                await binding.create({ id: job.id, params: { id: job.id } });
                return "running" as const;
              } catch {
                const instance = await (await binding.get(job.id)).status();
                if (instance.status === "unknown")
                  throw new Error("Provisioning instance unavailable");
                return instance.status;
              }
            },
            catch: () => new ProvisioningFailed(),
          });
          const persisted =
            status === "complete"
              ? "succeeded"
              : status === "errored" || status === "terminated"
                ? "failed"
                : "running";
          yield* sql`update hosted_provisioning set status = ${persisted}, updated_at = now()
          where id = ${job.id} and status in ('queued', 'running')`;
          if (persisted === "failed")
            yield* Effect.logError("Provisioning workflow needs attention", { job: job.id });
          if (job.kind === "team" && persisted === "running") yield* installTeam(job.id);
        }).pipe(
          Effect.tapError(() => Effect.logWarning("Provisioning dispatch failed", { job: job.id })),
          Effect.result,
        ),
      { concurrency: 4 },
    );
    return jobUnits(
      jobs.length,
      dispatched.filter(Result.isFailure).map((result) => result.failure),
    );
  }).pipe(Effect.mapError(() => new ProvisioningFailed()));

export const provisionTeamNow = (job: string) =>
  Effect.gen(function* () {
    const sql = yield* Effect.flatten(GroupDatabase);
    yield* provisionTeam(job, true).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  });
