import { browserOnly, hydrated } from "@executor-js/ui/contracts/http";
import { observeBrowserTransport, observeBrowserResponse } from "@executor-js/telemetry/browser";
import { organizationHttpClient } from "./organization-reference.ts";
import { DashboardRuntime } from "./telemetry.ts";
import { HostedApi } from "@executor-js/hosted-server/contracts";
import { Atom, AtomHttpApi } from "effect/reactivity";
import { batchReads } from "@executor-js/dashboard-start/batch-browser";
import { observeBuild } from "@executor-js/dashboard-start/build-change";

const batched = batchReads(HostedApi);

export class HostedClient extends AtomHttpApi.Service<HostedClient>()("HostedClient", {
  api: HostedApi,
  httpClient: organizationHttpClient,
  runtime: DashboardRuntime,
  transformClient: (client) => observeBrowserTransport(batched(observeBuild(client))),
  transformResponse: observeBrowserResponse,
}) {}

export const catalogAtom = browserOnly(
  HostedClient.query("catalog", "list", { query: {} }).pipe(Atom.setIdleTTL("30 minutes")),
);
export const healthAtom = HostedClient.query("health", "get", hydrated({}));
