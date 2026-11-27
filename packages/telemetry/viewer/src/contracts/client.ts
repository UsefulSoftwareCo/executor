import { FetchHttpClient } from "effect/http";
import { AtomHttpApi } from "effect/reactivity";
import { TelemetryApi } from "./api.ts";

export class TelemetryClient extends AtomHttpApi.Service<TelemetryClient>()("TelemetryClient", {
  api: TelemetryApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: window.location.origin,
}) {}
