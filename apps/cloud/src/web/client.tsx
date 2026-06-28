import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { addGroup } from "@executor-js/api";
import { getBaseUrl } from "@executor-js/react/api/base-url";
import { EXECUTOR_ORG_HEADER, getActiveOrgSlug } from "@executor-js/react/api/server-connection";
import { CloudAuthApi } from "../auth/api";
import { OrgApi } from "../org/api";

// ---------------------------------------------------------------------------
// Cloud API client — core API + cloud auth + org
// ---------------------------------------------------------------------------

const CloudApi = addGroup(CloudAuthApi).add(OrgApi);
const CloudApiClient = AtomHttpApi.Service<"CloudApiClient">()("CloudApiClient", {
  api: CloudApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
  transformClient: HttpClient.mapRequest((request) => {
    const orgSlug = getActiveOrgSlug();
    return orgSlug ? HttpClientRequest.setHeader(request, EXECUTOR_ORG_HEADER, orgSlug) : request;
  }),
});

export { CloudApiClient };
