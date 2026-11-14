import { FetchHttpClient } from "effect/http";
import { AtomHttpApi } from "effect/reactivity";
import { TelemetryApi } from "./api.ts";

/** The viewer is served by the collector, so its API is on the page's own origin. */
export class TelemetryClient extends AtomHttpApi.Service<TelemetryClient>()("TelemetryClient", {
  api: TelemetryApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: window.location.origin,
}) {}
