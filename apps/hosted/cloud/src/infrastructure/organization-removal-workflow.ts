/**
 * Organization removal as one durable workflow. It is the same mechanism as
 * `AppWorkflows`: an Alchemy `Cloudflare.Workflow` class hosted by the API
 * Worker. Deployed cloud runs it on Cloudflare Workflows; `alchemy dev` runs
 * the identical class in the local workerd runtime, so there is no second
 * implementation and no Node fallback. Self-host composes no removal route at
 * all, so it needs no workflow here.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { Cause, Effect, Layer } from "effect";
import {
  OrganizationBilling,
  OrganizationId,
  OrganizationRemovalFailed,
  removeOrganizationDurably,
  type OrganizationRemovalStepRunner,
} from "@executor-js/hosted-server";
import { Billing } from "../contracts/billing.ts";
import { billingLive } from "../implementation/billing.ts";
import { cloudSentry } from "../implementation/error-reporting.ts";
import { cloudAuth } from "./auth.ts";
import { cloudAuthDatabase } from "./auth-database.ts";
import { cloudEmail } from "./email.ts";
import { cloudExecutor } from "./executor.ts";
import { AppDataSupervisor } from "./app-data.ts";

/**
 * One durable step. The engine owns the journal and the retries; a body that
 * still fails after them becomes a named failure, so the report and the failed
 * instance both say which step stopped and for which organization.
 */
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
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.die(new OrganizationRemovalFailed({ organization, step: name })),
        ),
      ),
      { retries },
    );

export class OrganizationRemoval extends Cloudflare.Workflow<OrganizationRemoval>()(
  "OrganizationRemoval",
  Effect.gen(function* () {
    const reportErrors = yield* cloudSentry;
    const email = yield* cloudEmail.pipe(Effect.orDie);
    const auth = yield* cloudAuth(email.send);
    const executor = yield* cloudExecutor(yield* AppDataSupervisor);
    const billing = yield* billingLive.pipe(Effect.orDie);
    // Cancellation reaches the workflow as the host's billing service, not as a
    // branch on the deployment. A host without one keeps the inert default.
    const cancellation = Layer.effect(
      OrganizationBilling,
      Effect.map(Billing, (service) => ({
        cancel: (organization: OrganizationId) => service.cancel(organization),
      })),
    ).pipe(Layer.provide(billing));
    const services = Layer.mergeAll(executor, auth.identity, cancellation);
    return (input: { organization: string }) =>
      Effect.suspend(() => {
        const organization = OrganizationId.make(input.organization);
        return removeOrganizationDurably(organization, runner(organization)).pipe(
          Effect.provide(services),
          // Report through the same Sentry boundary the API uses, carrying the
          // organization and the step in the failure itself, and then leave the
          // instance failed: nothing else watches a workflow that stops part
          // way through an irreversible erasure.
          reportErrors,
          Effect.orDie,
        );
      });
  }).pipe(Effect.provide(cloudAuthDatabase)),
) {}
