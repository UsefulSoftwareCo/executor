import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { AccessGroupsHttpApi } from "@executor-js/api/client";
import * as Effect from "effect/Effect";

import { reportApiClientInfrastructureCause } from "./client";
import {
  EXECUTOR_ORG_HEADER,
  getActiveOrgSlug,
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "./server-connection";

// ---------------------------------------------------------------------------
// Shared access-groups client — the admin-only `/admin/access-groups*`
// management surface, same construction as `AdminApiClient`: both hosts serve
// identical routes (cloud: WorkOS admin-role session; self-host: a Better
// Auth owner/admin), so one client works for both. A 401/403 here means "not
// an admin of this tenant" and must render the page's denied state, hence
// `reportApiClientInfrastructureCause` rather than the local-auth gate.
// ---------------------------------------------------------------------------

const AccessGroupsApiClient = AtomHttpApi.Service<"AccessGroupsApiClient">()(
  "AccessGroupsApiClient",
  {
    api: AccessGroupsHttpApi,
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
  },
);

export { AccessGroupsApiClient };
