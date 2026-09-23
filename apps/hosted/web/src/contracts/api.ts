import { observeBrowserTransport, observeBrowserResponse } from "@executor-js/telemetry/browser";
import { organizationHttpClient } from "./organization-reference.ts";
/** Browser calls use the same hosted HTTP contract on Cloudflare and Docker. */
import { DashboardRuntime } from "./telemetry.ts";
import { HostedApi } from "@executor-js/hosted-server/contracts";
import { AtomHttpApi } from "effect/unstable/reactivity";

/** Relative URLs keep the dashboard and API on the current origin. */
export class HostedClient extends AtomHttpApi.Service<HostedClient>()("HostedClient", {
  api: HostedApi,
  httpClient: organizationHttpClient,
  runtime: DashboardRuntime,
  transformClient: observeBrowserTransport,
  transformResponse: observeBrowserResponse,
}) {}

/** Catalog metadata for the signed-in dashboard; no credential or installation reads. */
export const catalogAtom = HostedClient.query("catalog", "list", {});
/** Show whether this dashboard can reach its own hosted API. */
export const healthAtom = HostedClient.query("health", "get", {});
