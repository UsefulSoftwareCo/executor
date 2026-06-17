import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { addGroup } from "@executor-js/api";
import {
  getExecutorApiBaseUrl,
  getExecutorTenantApiBaseUrl,
} from "@executor-js/react/api/server-connection";
import { CloudAuthApi } from "../auth/api";
import { OrgApi } from "../org/api";

// ---------------------------------------------------------------------------
// Cloud API client — core API + cloud auth + org
// ---------------------------------------------------------------------------

const CloudApi = addGroup(CloudAuthApi).add(OrgApi);

const requestPathname = (url: string): string => new URL(url, "http://executor.internal").pathname;

const shouldUseTenantApi = (request: HttpClientRequest.HttpClientRequest): boolean => {
  const pathname = requestPathname(request.url);
  return pathname.startsWith("/org/") || pathname.startsWith("/mcp-sessions/");
};

const CloudApiClient = AtomHttpApi.Service<"CloudApiClient">()("CloudApiClient", {
  api: CloudApi,
  httpClient: FetchHttpClient.layer,
  transformClient: HttpClient.mapRequest((request) =>
    HttpClientRequest.prependUrl(
      request,
      shouldUseTenantApi(request) ? getExecutorTenantApiBaseUrl() : getExecutorApiBaseUrl(),
    ),
  ),
});

export { CloudApiClient };
