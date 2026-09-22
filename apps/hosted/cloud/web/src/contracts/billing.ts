import { observeBrowserTransport, observeBrowserResponse } from "@executor-js/telemetry/browser";
import { organizationHttpClient } from "@executor-js/hosted-web/contracts/organization-reference";
import { DashboardRuntime } from "@executor-js/hosted-web/contracts/telemetry";
import { Atom, AtomHttpApi } from "effect/unstable/reactivity";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { ExecutorCloudApi } from "../../../src/contracts/api.ts";

/** Only the cloud browser imports the cloud API contract. */
export class CloudClient extends AtomHttpApi.Service<CloudClient>()("CloudClient", {
  api: ExecutorCloudApi,
  httpClient: organizationHttpClient,
  runtime: DashboardRuntime,
  transformClient: observeBrowserTransport,
  transformResponse: observeBrowserResponse,
}) {}
/** Poll while the page is mounted so asynchronous checkout settlement becomes visible. */
export const billingAtom = Atom.family((organization: OrganizationReference) =>
  CloudClient.query("billing", "overview", { params: { organization } }).pipe(
    Atom.refreshOnWindowFocus,
    Atom.withRefresh("5 seconds"),
  ),
);
/** Create a checkout for the current organization. */
export const checkoutAtom = CloudClient.mutation("billing", "checkout");
/** Create a portal link for the current organization. */
export const portalAtom = CloudClient.mutation("billing", "portal");
