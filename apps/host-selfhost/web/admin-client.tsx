import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as Effect from "effect/Effect";

import { reportApiClientInfrastructureCause } from "@executor-js/react/api/client";
import {
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";

import { AdminHttpApi } from "../src/admin/api";

// ---------------------------------------------------------------------------
// Self-host admin atom client — the invite-code surface (/api/admin/*).
//
// Same construction as the shared AccountApiClient (base-url prepend +
// same-origin session cookie / optional bearer), but for the app-local admin
// HttpApi. Self-host only: cloud has no invite codes.
// ---------------------------------------------------------------------------

const AdminApiClient = AtomHttpApi.Service<"SelfHostAdminApiClient">()("SelfHostAdminApiClient", {
  api: AdminHttpApi,
  httpClient: FetchHttpClient.layer,
  transformClient: HttpClient.mapRequest((request) => {
    let next = HttpClientRequest.prependUrl(request, getExecutorApiBaseUrl());
    const authorization = getExecutorServerAuthorizationHeader();
    if (authorization) {
      next = HttpClientRequest.setHeader(next, "authorization", authorization);
    }
    return next;
  }),
  transformResponse: (effect) => Effect.tapCause(effect, reportApiClientInfrastructureCause),
});

export { AdminApiClient };
