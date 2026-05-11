import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { resolveSecretBackedMap } from "@executor-js/sdk/core";

import { GraphqlInvocationError } from "./errors";
import { type HeaderValue, type OperationBinding, InvocationResult } from "./types";

// ---------------------------------------------------------------------------
// Header resolution — resolves secret refs at invocation time
// ---------------------------------------------------------------------------

export const resolveHeaders = (
  headers: Record<string, HeaderValue>,
  secrets: { readonly get: (id: string) => Effect.Effect<string | null, unknown> },
): Effect.Effect<Record<string, string>> => {
  const entries = Object.entries(headers);
  const secretCount = entries.reduce(
    (acc, [, value]) => (typeof value === "string" ? acc : acc + 1),
    0,
  );
  return resolveSecretBackedMap({
    values: headers,
    getSecret: (secretId) => secrets.get(secretId).pipe(Effect.catch(() => Effect.succeed(null))),
    missing: "drop",
    onMissing: (name) =>
      new GraphqlInvocationError({
        message: `Missing secret for header "${name}"`,
        statusCode: Option.none(),
      }),
  }).pipe(
    Effect.catch(() => Effect.succeed<Record<string, string> | undefined>(undefined)),
    Effect.map((resolved) => resolved ?? {}),
    Effect.withSpan("plugin.graphql.secret.resolve", {
      attributes: {
        "plugin.graphql.headers.total": entries.length,
        "plugin.graphql.headers.secret_count": secretCount,
      },
    }),
  );
};

const endpointWithQueryParams = (endpoint: string, queryParams: Record<string, string>): string => {
  if (Object.keys(queryParams).length === 0) return endpoint;
  const url = new URL(endpoint);
  for (const [name, value] of Object.entries(queryParams)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
};

export const endpointForTelemetry = (endpoint: string): string => {
  if (!URL.canParse(endpoint)) return endpoint;
  const url = new URL(endpoint);
  url.search = "";
  url.hash = "";
  return url.toString();
};

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const isJsonContentType = (ct: string | null | undefined): boolean => {
  if (!ct) return false;
  const normalized = ct.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    normalized === "application/json" || normalized.includes("+json") || normalized.includes("json")
  );
};

// ---------------------------------------------------------------------------
// Public API — execute a GraphQL operation
// ---------------------------------------------------------------------------

export const invoke = Effect.fn("GraphQL.invoke")(function* (
  operation: OperationBinding,
  args: Record<string, unknown>,
  endpoint: string,
  resolvedHeaders: Record<string, string>,
  resolvedQueryParams: Record<string, string> = {},
) {
  const client = yield* HttpClient.HttpClient;
  const requestEndpoint = endpointWithQueryParams(endpoint, resolvedQueryParams);
  const telemetryEndpoint = endpointForTelemetry(endpoint);

  yield* Effect.annotateCurrentSpan({
    "http.method": "POST",
    "http.url": telemetryEndpoint,
    "plugin.graphql.endpoint": telemetryEndpoint,
    "plugin.graphql.operation_kind": operation.kind,
    "plugin.graphql.field_name": operation.fieldName,
    "plugin.graphql.headers.resolved_count": Object.keys(resolvedHeaders).length,
    "plugin.graphql.query_params.resolved_count": Object.keys(resolvedQueryParams).length,
  });

  // Build the GraphQL request body
  const variables: Record<string, unknown> = {};
  for (const varName of operation.variableNames) {
    if (args[varName] !== undefined) {
      variables[varName] = args[varName];
    }
  }

  // Also pick up any variables from a "variables" container
  if (typeof args.variables === "object" && args.variables !== null) {
    Object.assign(variables, args.variables);
  }

  let request = HttpClientRequest.post(requestEndpoint).pipe(
    HttpClientRequest.setHeader("Content-Type", "application/json"),
    HttpClientRequest.bodyJsonUnsafe({
      query: operation.operationString,
      variables: Object.keys(variables).length > 0 ? variables : undefined,
    }),
  );

  for (const [name, value] of Object.entries(resolvedHeaders)) {
    request = HttpClientRequest.setHeader(request, name, value);
  }

  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (err) =>
        new GraphqlInvocationError({
          message: "GraphQL request failed",
          statusCode: Option.none(),
          cause: err,
        }),
    ),
  );

  const status = response.status;
  const contentType = response.headers["content-type"] ?? null;

  const body: unknown = isJsonContentType(contentType)
    ? yield* response.json.pipe(Effect.catch(() => response.text))
    : yield* response.text;

  // GraphQL responses are always 200 with { data, errors }
  const gqlBody = body as { data?: unknown; errors?: unknown[] } | null;
  const hasErrors = Array.isArray(gqlBody?.errors) && gqlBody.errors.length > 0;

  yield* Effect.annotateCurrentSpan({
    "http.status_code": status,
    "plugin.graphql.has_errors": hasErrors,
    "plugin.graphql.error_count": hasErrors ? gqlBody!.errors!.length : 0,
  });

  return new InvocationResult({
    status,
    data: gqlBody?.data ?? null,
    errors: hasErrors ? gqlBody!.errors : null,
  });
});

// ---------------------------------------------------------------------------
// Invoke a GraphQL operation with a provided HttpClient layer
// ---------------------------------------------------------------------------

export const invokeWithLayer = (
  operation: OperationBinding,
  args: Record<string, unknown>,
  endpoint: string,
  resolvedHeaders: Record<string, string>,
  resolvedQueryParams: Record<string, string>,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
) =>
  invoke(operation, args, endpoint, resolvedHeaders, resolvedQueryParams).pipe(
    Effect.provide(httpClientLayer),
    Effect.withSpan("plugin.graphql.invoke", {
      attributes: {
        "plugin.graphql.endpoint": endpointForTelemetry(endpoint),
        "plugin.graphql.operation_kind": operation.kind,
        "plugin.graphql.field_name": operation.fieldName,
      },
    }),
  );
