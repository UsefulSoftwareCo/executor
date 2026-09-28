import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as Effect from "effect/Effect";

import { reportApiClientInfrastructureCause } from "@executor-js/react/api/client";
import { getExecutorApiBaseUrl } from "@executor-js/react/api/server-connection";

import { AccessHttpApi } from "../src/access/api";

// ---------------------------------------------------------------------------
// Self-host connected-clients atom client (/api/access/*).
//
// Same construction as the admin client, with one deliberate difference: it
// never attaches an `Authorization` header. The server refuses any request
// carrying one (the plane answers the signed-in browser only), so this client
// rides on the same-origin session cookie alone.
// ---------------------------------------------------------------------------

const AccessApiClient = AtomHttpApi.Service<"SelfHostAccessApiClient">()(
  "SelfHostAccessApiClient",
  {
    api: AccessHttpApi,
    httpClient: FetchHttpClient.layer,
    transformClient: HttpClient.mapRequest((request) =>
      HttpClientRequest.prependUrl(request, getExecutorApiBaseUrl()),
    ),
    transformResponse: (effect) => Effect.tapCause(effect, reportApiClientInfrastructureCause),
  },
);

export { AccessApiClient };
