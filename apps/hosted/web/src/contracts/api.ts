import { browserOnly, hydrated } from "@executor-js/ui/contracts/http";
import { observeBrowserTransport, observeBrowserResponse } from "@executor-js/telemetry/browser";
import { organizationHttpClient } from "./organization-reference.ts";
/** Browser calls use the same hosted HTTP contract on Cloudflare and Docker. */
import { DashboardRuntime } from "./telemetry.ts";
import { HostedApi } from "@executor-js/hosted-server/contracts";
import { Atom, AtomHttpApi } from "effect/reactivity";
import { batchReads } from "@executor-js/dashboard-start/batch-browser";
import { observeBuild } from "@executor-js/dashboard-start/build-change";

const batched = batchReads(HostedApi);

/**
 * Relative URLs keep the dashboard and API on the current origin. Reads a page starts together
 * travel as one batch. Responses from another build mark the page outdated.
 */
export class HostedClient extends AtomHttpApi.Service<HostedClient>()("HostedClient", {
  api: HostedApi,
  httpClient: organizationHttpClient,
  runtime: DashboardRuntime,
  transformClient: (client) => observeBrowserTransport(batched(observeBuild(client))),
  transformResponse: observeBrowserResponse,
}) {}

/** Catalog metadata for the signed-in dashboard; no credential or installation reads. */
/**
 * The full catalog is large and only decorates icons and the add-app page, so the browser loads
 * it after the page is interactive instead of the server embedding it in every document.
 */
export const catalogAtom = browserOnly(
  HostedClient.query("catalog", "list", {}).pipe(Atom.setIdleTTL("30 minutes")),
);
/** Show whether this dashboard can reach its own hosted API. */
export const healthAtom = HostedClient.query("health", "get", hydrated({}));
