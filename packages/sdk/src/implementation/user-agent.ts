import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * Name Executor on requests that do not already carry a User-Agent. Some firewalls refuse requests
 * without one, and Workers do not supply one by default.
 */
export const withExecutorUserAgent = (client: HttpClient.HttpClient) =>
  HttpClient.mapRequest(client, (request) =>
    request.headers["user-agent"] === undefined
      ? HttpClientRequest.setHeader(request, "user-agent", "Executor")
      : request,
  );
