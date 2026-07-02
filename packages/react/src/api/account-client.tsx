import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { AccountHttpApi } from "@executor-js/api/client";
import * as Effect from "effect/Effect";

import { reportApiClientInfrastructureCause } from "./client";
import {
  EXECUTOR_ORG_HEADER,
  getActiveOrgSlug,
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "./server-connection";

// ---------------------------------------------------------------------------
// Shared account client — the provider-neutral `/account/*` surface.
//
// A separate AtomHttpApi service from `ExecutorApiClient` (which serves the
// core executor groups), mirroring the cloud split (a core client + an auth
// client). Both the cloud (WorkOS) and self-host (Better Auth) servers
// implement these paths, so this one client works for both — auth is the
// same-origin session cookie the browser sends automatically.
// ---------------------------------------------------------------------------

const AccountApiClient = AtomHttpApi.Service<"AccountApiClient">()("AccountApiClient", {
  api: AccountHttpApi,
  httpClient: FetchHttpClient.layer,
  transformClient: HttpClient.mapRequest((request) => {
    let next = HttpClientRequest.prependUrl(request, getExecutorApiBaseUrl());
    const authorization = getExecutorServerAuthorizationHeader();
    if (authorization) {
      next = HttpClientRequest.setHeader(next, "authorization", authorization);
    }
    // Scope to the org the console URL is on (see server-connection).
    const orgSlug = getActiveOrgSlug();
    if (orgSlug) {
      next = HttpClientRequest.setHeader(next, EXECUTOR_ORG_HEADER, orgSlug);
    }
    return next;
  }),
  transformResponse: (effect) => Effect.tapCause(effect, reportApiClientInfrastructureCause),
});

export { AccountApiClient };
