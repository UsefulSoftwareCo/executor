import type { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { Headers } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

import { CoreExecutorApi, ExecutorApi } from "./api";

export { CoreExecutorApi, ExecutorApi };
export { ToolsApi } from "./tools/api";
export { IntegrationsApi } from "./integrations/api";
export { ConnectionsApi } from "./connections/api";
export { ProvidersApi } from "./providers/api";
export { ExecutionsApi } from "./executions/api";
export { OAuthApi } from "./oauth/api";
export { PoliciesApi } from "./policies/api";
export {
  AccountApi,
  AccountHttpApi,
  AccountError,
  AccountForbidden,
  AccountNoOrganization,
  AccountUnauthorized,
} from "./account/api";

/** The exact typed client generated from Executor's first-party HTTP API. */
export type ExecutorApiClient = HttpApiClient.ForApi<typeof ExecutorApi>;

type HttpApiClientOptions = NonNullable<Parameters<typeof HttpApiClient.make>[1]>;

export interface ExecutorApiClientOptions {
  readonly baseUrl: string | URL;
  /** Static request headers, including Authorization when the credential is fixed. */
  readonly headers?: Headers.Input;
  /** Dynamic auth or transport customization, applied after static headers. */
  readonly transformClient?: HttpApiClientOptions["transformClient"];
  readonly transformResponse?: HttpApiClientOptions["transformResponse"];
}

/**
 * Build the first-party typed remote client. The caller supplies the concrete
 * HttpClient layer, keeping this entry point server-safe and runtime-neutral.
 */
export const makeExecutorApiClient = (
  options: ExecutorApiClientOptions,
): Effect.Effect<ExecutorApiClient, never, HttpClient.HttpClient> => {
  const headers = options.headers;
  return HttpApiClient.make(ExecutorApi, {
    baseUrl: options.baseUrl,
    transformClient:
      headers === undefined && options.transformClient === undefined
        ? undefined
        : (client) => {
            const withHeaders =
              headers === undefined
                ? client
                : HttpClient.mapRequest(client, (request) =>
                    HttpClientRequest.setHeaders(request, headers),
                  );
            return options.transformClient?.(withHeaders) ?? withHeaders;
          },
    transformResponse: options.transformResponse,
  });
};
export {
  AdminUsersApi,
  AdminUsersHttpApi,
  AdminUsersError,
  AdminUsersForbidden,
  AdminUsersUnauthorized,
  AdminUser,
  AdminUserConnection,
  AdminUserWithConnections,
  AdminUsersResponse,
  AdminUserConnectionsResponse,
  AdminUsersWithConnectionsResponse,
} from "./admin/api";
