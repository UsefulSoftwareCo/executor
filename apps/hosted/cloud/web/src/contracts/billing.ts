import { browserOnly, hydrated } from "@executor-js/ui/contracts/http";
import { pollingQuery, whileLoaded } from "@executor-js/ui/contracts/polling";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { observeBrowserTransport, observeBrowserResponse } from "@executor-js/telemetry/browser";
import { organizationHttpClient } from "@executor-js/hosted-web/contracts/organization-reference";
import { DashboardRuntime } from "@executor-js/hosted-web/contracts/telemetry";
import { Data, Duration } from "effect";
import { Atom, AtomHttpApi } from "effect/reactivity";
import { batchReads } from "@executor-js/dashboard-start/batch-browser";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { ExecutorCloudApi } from "../../../src/contracts/api.ts";
import type { BillingOverview } from "../../../src/contracts/billing.ts";

const batched = batchReads(ExecutorCloudApi);

export class CloudClient extends AtomHttpApi.Service<CloudClient>()("CloudClient", {
  api: ExecutorCloudApi,
  httpClient: organizationHttpClient,
  runtime: DashboardRuntime,
  transformClient: (client) => observeBrowserTransport(batched(client)),
  transformResponse: observeBrowserResponse,
}) {}
const overviewAtom = Atom.family((organization: OrganizationReference) =>
  CloudClient.query("billing", "overview", hydrated({ params: { organization } })).pipe(
    revalidated,
  ),
);
export const planActive = (billing: typeof BillingOverview.Type, plan: string) =>
  billing.subscriptions.some(
    (subscription) =>
      subscription.planId === plan && ["active", "trialing"].includes(subscription.status),
  );
class BillingKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly awaitingPlan: string | undefined;
}> {}
const billingFamily = Atom.family(({ organization, awaitingPlan }: BillingKey) =>
  awaitingPlan === undefined
    ? pollingQuery(overviewAtom(organization))
    : pollingQuery(overviewAtom(organization), {
        active: whileLoaded((billing) => !planActive(billing, awaitingPlan)),
      }),
);
export const checkoutSettlementWindow = Duration.minutes(2);
export const billingAtom = (organization: OrganizationReference, awaitingPlan?: string) =>
  billingFamily(new BillingKey({ organization, awaitingPlan }));
export const checkoutAtom = CloudClient.mutation("billing", "checkout");
export const portalAtom = CloudClient.mutation("billing", "portal");
export const memberLimitAtom = Atom.family((organization: OrganizationReference) =>
  browserOnly(CloudClient.query("billing", "memberLimit", { params: { organization } })).pipe(
    revalidated,
  ),
);
