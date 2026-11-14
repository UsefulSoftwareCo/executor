import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * The User-Agent Executor sends when a request names none. Workers send no User-Agent, and some
 * services refuse a request without one: GitHub's API answers 403 with an HTML page.
 */
export const executorUserAgent = "Executor";

/** Name Executor on requests that do not already carry a User-Agent. */
export const withExecutorUserAgent = (client: HttpClient.HttpClient) =>
  HttpClient.mapRequest(client, (request) =>
    request.headers["user-agent"] === undefined
      ? HttpClientRequest.setHeader(request, "user-agent", executorUserAgent)
      : request,
  );
