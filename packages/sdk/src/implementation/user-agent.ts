import { HttpClient, HttpClientRequest } from "effect/http";

export const executorUserAgent = "Executor";

export const withExecutorUserAgent = (client: HttpClient.HttpClient) =>
  HttpClient.mapRequest(client, (request) =>
    request.headers["user-agent"] === undefined
      ? HttpClientRequest.setHeader(request, "user-agent", executorUserAgent)
      : request,
  );
