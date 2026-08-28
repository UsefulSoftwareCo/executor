import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { AdminUsersHttpApi } from "@executor-js/api/client";
import * as Effect from "effect/Effect";

import { reportApiClientInfrastructureCause } from "./client";
import {
  EXECUTOR_ORG_HEADER,
  getActiveOrgSlug,
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "./server-connection";

// ---------------------------------------------------------------------------
// Shared admin client — the tenant-wide `/admin/users*` operator surface.
//
// A third AtomHttpApi service alongside `ExecutorApiClient` (the product plane:
// "what can I reach") and `AccountApiClient` (identity + org membership). This
// one answers the OWNER's question: who are my users and what have they
// connected. Its paths are `/admin/*` with no `/api` — `transformClient`
// prepends the API base, exactly like the account client.
//
// Both hosts that serve it (cloud: an org API key or an admin-role session;
// self-host: a Better Auth owner/admin) implement identical routes, so one
// client works for both. Requests carry the same session cookie the browser
// sends anyway; the org header scopes cloud to the org the console URL is on.
//
// `reportApiClientInfrastructureCause` (not `handleApiClientCause`) on purpose:
// a 401 here means "not an admin of this tenant", which must render a denied
// state on the page — it must NOT pop the local-auth gate the core client
// raises when the whole product plane is unreachable.
// ---------------------------------------------------------------------------

const AdminApiClient = AtomHttpApi.Service<"AdminApiClient">()("AdminApiClient", {
  api: AdminUsersHttpApi,
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

export { AdminApiClient };
