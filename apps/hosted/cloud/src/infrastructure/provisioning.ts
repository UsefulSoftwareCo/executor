/** Native host workflows bootstrap teams before any authored app exists. */
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { Workflow } from "@cloudflare/workers-types";
import { Cause, Effect, Schema } from "effect";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import {
  provision,
  ProvisioningFailed,
  type ProvisioningServices,
} from "@executor-js/hosted-server/provisioning";
import { SqlClient } from "effect/unstable/sql";
import { cloudExecutor } from "./executor.ts";
import { AppDataSupervisor } from "./app-data.ts";
import { cloudEmail } from "./email.ts";
import { cloudWelcomeEmails } from "./welcome-email.ts";
import { AppDomainCoordinator } from "./app-domains.ts";
import { billingLive } from "../implementation/billing.ts";
import { BillingMeter } from "../contracts/billing-meter.ts";
import { cloudAnalytics } from "../implementation/product-analytics.ts";

/** Each committed lifecycle action has its own workflow, so unrelated failures do not block setup. */
export class Provisioning extends Cloudflare.Workflow<Provisioning>()(
  "Provisioning",
  Effect.gen(function* () {
    const executor = yield* cloudExecutor(yield* AppDataSupervisor);
    const emails = yield* cloudWelcomeEmails((yield* cloudEmail.pipe(Effect.orDie)).welcome);
    const domains = yield* AppDomainCoordinator;
    const meter = yield* BillingMeter.pipe(Effect.provide(yield* billingLive.pipe(Effect.orDie)));
    const analytics = yield* cloudAnalytics;
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
            // Native step callbacks start a new Effect fiber; carry the invocation's host bindings.
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
                  Effect.provide(executor),
                  Effect.scoped,
                  Effect.provideContext(context),
                  Effect.orDie,
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
/** Start by stable outbox ID. A crash after create is recovered by observing the same instance. */
export const dispatchProvisioning = Effect.gen(function* () {
  const environment = yield* Cloudflare.WorkerEnvironment;
  const binding = yield* Schema.decodeUnknownEffect(NativeProvisioning)(environment.Provisioning);
  const sql = yield* Effect.flatten(GroupDatabase);
  const jobs =
    yield* sql`select id from hosted_provisioning where status = 'queued' or (status = 'running' and updated_at < now() - interval '30 minutes') order by available_at limit 50`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String }))),
      ),
    );
  yield* Effect.forEach(
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
      }).pipe(
        Effect.catch(() => Effect.logWarning("Provisioning dispatch failed", { job: job.id })),
      ),
    { concurrency: 4, discard: true },
  );
}).pipe(Effect.mapError(() => new ProvisioningFailed()));
