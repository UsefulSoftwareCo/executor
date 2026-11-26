import * as Cloudflare from "alchemy/Cloudflare";
import { Cause, Context, Effect, Option, Schema } from "effect";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import {
  SessionAuthentication,
  HostedExecutor,
  OrganizationBilling,
  OrganizationIcons,
  OrganizationId,
  OrganizationRemovalFailed,
  OrganizationRemovals,
  OrganizationRemovalUnavailable,
  removeOrganizationDurably,
  type OrganizationRemovalStepRunner,
} from "@executor-js/hosted-server";
import { Billing } from "../contracts/billing.ts";
import { cloudSentry } from "../implementation/error-reporting.ts";
import { EventCleanup, sqlCancellation } from "./event-cleanup.ts";
import type { OrganizationRemovalRecovery } from "./organization-removal-recovery.ts";

class RemovalAttemptFailed extends Schema.TaggedError<RemovalAttemptFailed>()(
  "RemovalAttemptFailed",
  {},
) {}

const runner =
  (
    organization: OrganizationId,
  ): OrganizationRemovalStepRunner<Cloudflare.Workflows.WorkflowStep> =>
  <A>(
    name: Parameters<OrganizationRemovalStepRunner>[0],
    retries: Parameters<OrganizationRemovalStepRunner>[1],
    work: Effect.Effect<A, unknown>,
  ) =>
    Cloudflare.Workflows.task(
      name,
      work.pipe(
        Effect.withSpan("organization.removal.step", {
          attributes: { "executor.organization.id": organization, "executor.removal.step": name },
        }),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logError("Organization removal step failed", cause).pipe(
                Effect.andThen(Effect.fail(new RemovalAttemptFailed())),
              ),
        ),
      ),
      { retries },
    ).pipe(Effect.mapError(() => new OrganizationRemovalFailed({ organization, step: name })));

export class OrganizationRemoval extends Cloudflare.Workflow<OrganizationRemoval>()(
  "OrganizationRemoval",
  Effect.gen(function* () {
    const reportErrors = yield* cloudSentry;
    const services = yield* Effect.context<
      HostedExecutor | OrganizationIcons | OrganizationRemovals | SessionAuthentication | Billing
    >().pipe(
      Effect.map(
        Context.pick(
          HostedExecutor,
          OrganizationIcons,
          OrganizationRemovals,
          SessionAuthentication,
          Billing,
        ),
      ),
    );
    const billing = Context.get(services, Billing);
    const cancellation = OrganizationBilling.of({
      cancel: (organization: OrganizationId) => billing.cancel(organization),
    });
    return (input: { organization: string }) =>
      Effect.suspend(() => {
        const organization = OrganizationId.make(input.organization);
        return removeOrganizationDurably(organization, runner(organization)).pipe(
          Effect.provide(services),
          Effect.provideService(OrganizationBilling, cancellation),
          reportErrors,
          Effect.orDie,
        );
      });
  }),
) {}

export class OrganizationRemovalStart extends Context.Service<
  OrganizationRemovalStart,
  (
    organization: OrganizationId,
    instance: string,
  ) => Effect.Effect<void, OrganizationRemovalUnavailable>
>()("executor/cloud/OrganizationRemovalStart") {}

const callDeadline = "3 seconds";

export const startOrganizationRemoval =
  (workflow: Pick<Effect.Success<typeof OrganizationRemoval>, "create" | "get">) =>
  (organization: OrganizationId, instance: string) =>
    workflow.create({ id: instance, params: { organization } }).pipe(
      Effect.timeout(callDeadline),
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : workflow.get(instance).pipe(
              Effect.flatMap((run) => run.status()),
              Effect.timeout(callDeadline),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.succeed({ status: "unknown" }),
              ),
              Effect.flatMap((state) =>
                state.status === "unknown"
                  ? Effect.fail(new OrganizationRemovalUnavailable())
                  : Effect.void,
              ),
            ),
      ),
      Effect.withSpan("organization.removal.start", {
        attributes: { "executor.organization.id": organization },
      }),
    );

export const dispatchAcceptedRemoval = (
  start: OrganizationRemovalStart["Service"],
  recover: OrganizationRemovalRecovery["Service"],
  organization: OrganizationId,
  instance: string,
) =>
  Effect.flatMap(EventCleanup, (cleanup) =>
    Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const deadline = yield* cleanup.deadline;
        const started = yield* deadline.within(
          start(organization, instance).pipe(
            Effect.tapError(() => Effect.sleep("500 millis")),
            Effect.eventually,
          ),
          { max: "10 seconds", reserve: sqlCancellation },
        );
        if (Option.isSome(started)) return;
        yield* Effect.logWarning("Organization removal start pending", { organization });
        const armed = yield* deadline
          .within(recover(organization), { max: "3 seconds" })
          .pipe(Effect.catchCause(() => Effect.succeedNone));
        if (Option.isNone(armed))
          yield* Effect.logError("Organization removal recovery unavailable", { organization });
      }),
    ),
  );

const startPage = 50;

const PendingStarts = Schema.Array(
  Schema.Struct({ organization_id: OrganizationId, instance_id: Schema.NonEmptyString }),
);

export const dispatchOrganizationRemovals = Effect.gen(function* () {
  const start = yield* OrganizationRemovalStart;
  const sql = yield* Effect.flatten(GroupDatabase);
  let after = "";
  let pending = 0;
  let checked = 0;
  while (true) {
    const page = yield* sql`select r.organization_id, r.instance_id
      from hosted_organization_removal r
      where r.status = 'running' and r.organization_id > ${after}
        and not exists (select 1 from cloud_organization_removal_start s
          where s.organization_id = r.organization_id and s.instance_id = r.instance_id)
      order by r.organization_id limit ${startPage}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PendingStarts)),
    );
    const started = yield* Effect.forEach(
      page,
      (record) =>
        start(record.organization_id, record.instance_id).pipe(
          Effect.andThen(
            sql`insert into cloud_organization_removal_start (organization_id, instance_id)
              values (${record.organization_id}, ${record.instance_id})
              on conflict (organization_id) do nothing`,
          ),
          Effect.as(true),
          Effect.catch(() =>
            Effect.logWarning("Organization removal start remains pending", {
              organization: record.organization_id,
            }).pipe(Effect.as(false)),
          ),
        ),
      { concurrency: 2 },
    );
    checked += page.length;
    pending += started.filter((ok) => !ok).length;
    const last = page.at(-1);
    if (page.length < startPage || last === undefined) break;
    after = last.organization_id;
  }
  yield* Effect.annotateCurrentSpan({
    "executor.removal.starts.checked": checked,
    "executor.removal.starts.pending": pending,
  });
  if (pending > 0) return yield* new OrganizationRemovalUnavailable();
}).pipe(Effect.withSpan("job.organization-removal.dispatch"));
