import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { ExecutorApi } from "@executor-js/api";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { getAuthPassword, getBaseUrl } from "./base-url";
import { reportHandledFrontendError } from "./error-reporting";

const isApiClientInfrastructureCause = (cause: Cause.Cause<unknown>): boolean =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => false,
    onSome: (error) => Schema.isSchemaError(error) || HttpClientError.isHttpClientError(error),
  });

const reportApiClientInfrastructureCause = (cause: Cause.Cause<unknown>) =>
  Effect.sync(() => {
    if (!isApiClientInfrastructureCause(cause)) return;
    reportHandledFrontendError(cause, {
      surface: "api_client",
      action: "decode_or_transport",
    });
  });

// ---------------------------------------------------------------------------
// Core API client — tools + secrets
// ---------------------------------------------------------------------------

const electronBasicHeader = (): string | null => {
  const password = getAuthPassword();
  if (!password) return null;
  if (typeof globalThis.btoa !== "function") return null;
  // The Electron sidecar uses Basic auth with the literal username "executor"
  // and a session-generated password injected at preload time.
  return `Basic ${globalThis.btoa(`executor:${password}`)}`;
};

const ExecutorApiClient = AtomHttpApi.Service<"ExecutorApiClient">()("ExecutorApiClient", {
  api: ExecutorApi,
  httpClient: FetchHttpClient.layer,
  transformClient: HttpClient.mapRequest((request) => {
    let next = HttpClientRequest.prependUrl(request, getBaseUrl());
    const basic = electronBasicHeader();
    if (basic) {
      next = HttpClientRequest.setHeader(next, "authorization", basic);
    }
    return next;
  }),
  transformResponse: (effect) => Effect.tapCause(effect, reportApiClientInfrastructureCause),
});

export { ExecutorApiClient };
