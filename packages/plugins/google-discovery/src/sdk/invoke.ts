import { Effect, Layer, Option, Predicate, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { resolveSecretBackedMap, type PluginCtx, type StorageFailure } from "@executor-js/sdk/core";

import { GoogleDiscoveryInvocationError, GoogleDiscoveryOAuthError } from "./errors";
import type { GoogleDiscoveryStore } from "./binding-store";
import {
  GoogleDiscoveryInvocationResult,
  type GoogleDiscoveryFetchCredentials,
  type GoogleDiscoveryParameter,
  type GoogleDiscoveryStoredSourceData,
} from "./types";

const SAFE_METHODS = new Set(["get", "head", "options"]);

const UnknownErrorMessage = Schema.Struct({ message: Schema.String });
const decodeUnknownErrorMessage = Schema.decodeUnknownOption(UnknownErrorMessage);

const errorMessageFromUnknown = (cause: unknown): string => {
  const decoded = decodeUnknownErrorMessage(cause);
  if (Option.isSome(decoded)) return decoded.value.message;
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: preserves existing fallback text for HTTP client errors
  return String(cause);
};

export const annotationsForOperation = (
  method: string,
  pathTemplate: string,
): { requiresApproval?: boolean; approvalDescription?: string } => {
  if (SAFE_METHODS.has(method.toLowerCase())) return {};
  return {
    requiresApproval: true,
    approvalDescription: `${method.toUpperCase()} ${pathTemplate}`,
  };
};

// ---------------------------------------------------------------------------
// Path / query parameter helpers (unchanged from the old invoker)
// ---------------------------------------------------------------------------

const stringValuesFromParameter = (value: unknown, repeated: boolean): string[] => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    const normalized = value.flatMap((entry) =>
      entry === undefined || entry === null ? [] : [String(entry)],
    );
    return repeated ? normalized : [normalized.join(",")];
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  return [JSON.stringify(value)];
};

const replacePathParameters = (input: {
  pathTemplate: string;
  args: Record<string, unknown>;
  parameters: readonly GoogleDiscoveryParameter[];
}): Effect.Effect<string, GoogleDiscoveryInvocationError> =>
  Effect.gen(function* () {
    let failure: GoogleDiscoveryInvocationError | undefined;
    const resolved = input.pathTemplate.replaceAll(/\{([^}]+)\}/g, (_, rawName: string) => {
      const allowReserved = rawName.startsWith("+");
      const name = allowReserved ? rawName.slice(1) : rawName;
      const parameter = input.parameters.find(
        (entry) => entry.location === "path" && entry.name === name,
      );
      const values = stringValuesFromParameter(input.args[name], false);
      if (values.length === 0) {
        if (parameter?.required) {
          failure = new GoogleDiscoveryInvocationError({
            message: `Missing required path parameter: ${name}`,
            statusCode: Option.none(),
          });
        }
        return "";
      }
      return allowReserved ? encodeURI(values[0]!) : encodeURIComponent(values[0]!);
    });
    if (failure) return yield* failure;
    return resolved;
  });

const resolveBaseUrl = (source: GoogleDiscoveryStoredSourceData): string =>
  new URL(source.servicePath || "", source.rootUrl).toString();

const isJsonContentType = (contentType: string | null | undefined): boolean => {
  if (!contentType) return false;
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    normalized === "application/json" || normalized.includes("+json") || normalized.includes("json")
  );
};

const resolveInvocationCredentials = (
  ctx: PluginCtx<GoogleDiscoveryStore>,
  credentials: GoogleDiscoveryFetchCredentials | undefined,
): Effect.Effect<
  { readonly headers: Record<string, string>; readonly queryParams: Record<string, string> },
  GoogleDiscoveryInvocationError | StorageFailure
> =>
  Effect.gen(function* () {
    const headers = yield* resolveSecretBackedMap({
      values: credentials?.headers,
      getSecret: ctx.secrets.get,
      onMissing: (name) =>
        new GoogleDiscoveryInvocationError({
          message: `Secret not found for header "${name}"`,
          statusCode: Option.none(),
        }),
      onError: (_error, name) =>
        new GoogleDiscoveryInvocationError({
          message: `Secret not found for header "${name}"`,
          statusCode: Option.none(),
        }),
    }).pipe(
      Effect.mapError((err) =>
        Predicate.isTagged("SecretOwnedByConnectionError")(err)
          ? new GoogleDiscoveryInvocationError({
              message: "Secret resolution failed",
              statusCode: Option.none(),
              cause: err,
            })
          : err,
      ),
    );
    const queryParams = yield* resolveSecretBackedMap({
      values: credentials?.queryParams,
      getSecret: ctx.secrets.get,
      onMissing: (name) =>
        new GoogleDiscoveryInvocationError({
          message: `Secret not found for query parameter "${name}"`,
          statusCode: Option.none(),
        }),
      onError: (_error, name) =>
        new GoogleDiscoveryInvocationError({
          message: `Secret not found for query parameter "${name}"`,
          statusCode: Option.none(),
        }),
    }).pipe(
      Effect.mapError((err) =>
        Predicate.isTagged("SecretOwnedByConnectionError")(err)
          ? new GoogleDiscoveryInvocationError({
              message: "Secret resolution failed",
              statusCode: Option.none(),
              cause: err,
            })
          : err,
      ),
    );
    return {
      headers: headers ?? {},
      queryParams: queryParams ?? {},
    };
  });

// ---------------------------------------------------------------------------
// HTTP request builder / executor
// ---------------------------------------------------------------------------

const performRequest = Effect.fn("GoogleDiscovery.invoke")(function* (input: {
  method: string;
  pathTemplate: string;
  parameters: readonly GoogleDiscoveryParameter[];
  hasBody: boolean;
  source: GoogleDiscoveryStoredSourceData;
  args: Record<string, unknown>;
  authorizationHeader?: string;
  credentialHeaders?: Record<string, string>;
  credentialQueryParams?: Record<string, string>;
}) {
  const client = yield* HttpClient.HttpClient;

  const resolvedPath = yield* replacePathParameters({
    pathTemplate: input.pathTemplate,
    args: input.args,
    parameters: input.parameters,
  });
  const requestUrl = new URL(resolvedPath.replace(/^\//, ""), resolveBaseUrl(input.source));

  for (const [name, value] of Object.entries(input.credentialQueryParams ?? {})) {
    requestUrl.searchParams.append(name, value);
  }

  for (const parameter of input.parameters) {
    if (parameter.location === "path") continue;
    const values = stringValuesFromParameter(input.args[parameter.name], parameter.repeated);
    if (values.length === 0) {
      if (parameter.required) {
        return yield* new GoogleDiscoveryInvocationError({
          message: `Missing required ${parameter.location} parameter: ${parameter.name}`,
          statusCode: Option.none(),
        });
      }
      continue;
    }
    if (parameter.location === "query") {
      for (const value of values) {
        requestUrl.searchParams.append(parameter.name, value);
      }
    }
  }

  let request = HttpClientRequest.make(input.method.toUpperCase() as "GET")(requestUrl.toString());

  for (const parameter of input.parameters) {
    if (parameter.location !== "header") continue;
    const values = stringValuesFromParameter(input.args[parameter.name], parameter.repeated);
    if (values.length === 0) continue;
    request = HttpClientRequest.setHeader(
      request,
      parameter.name,
      parameter.repeated ? values.join(",") : values[0]!,
    );
  }

  for (const [name, value] of Object.entries(input.credentialHeaders ?? {})) {
    request = HttpClientRequest.setHeader(request, name, value);
  }

  if (input.authorizationHeader) {
    request = HttpClientRequest.setHeader(request, "Authorization", input.authorizationHeader);
  }

  if (input.hasBody && input.args.body !== undefined) {
    request = HttpClientRequest.bodyJsonUnsafe(request, input.args.body);
  }

  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (err) =>
        new GoogleDiscoveryInvocationError({
          message: `HTTP request failed: ${errorMessageFromUnknown(err)}`,
          statusCode: Option.none(),
          cause: err,
        }),
    ),
  );

  const contentType = response.headers["content-type"] ?? null;
  const mapBodyError = Effect.mapError(
    (err: unknown) =>
      new GoogleDiscoveryInvocationError({
        message: `Failed to read response body: ${errorMessageFromUnknown(err)}`,
        statusCode: Option.some(response.status),
        cause: err,
      }),
  );
  const body =
    response.status === 204
      ? null
      : isJsonContentType(contentType)
        ? yield* response.json.pipe(
            Effect.catch(() => response.text),
            mapBodyError,
          )
        : yield* response.text.pipe(mapBodyError);

  const ok = response.status >= 200 && response.status < 300;
  return GoogleDiscoveryInvocationResult.make({
    status: response.status,
    headers: { ...response.headers },
    data: ok ? body : null,
    error: ok ? null : body,
  });
});

// ---------------------------------------------------------------------------
// Entry point — called from plugin.invokeTool.
// ---------------------------------------------------------------------------

export const invokeGoogleDiscoveryTool = (input: {
  ctx: PluginCtx<GoogleDiscoveryStore>;
  toolId: string;
  /** Resolved owning scope of the tool row. */
  toolScope: string;
  args: unknown;
  httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
}): Effect.Effect<
  GoogleDiscoveryInvocationResult,
  GoogleDiscoveryInvocationError | GoogleDiscoveryOAuthError | StorageFailure
> =>
  Effect.gen(function* () {
    const entry = yield* input.ctx.storage.getBinding(input.toolId, input.toolScope);
    if (!entry) {
      return yield* new GoogleDiscoveryInvocationError({
        message: `No Google Discovery operation found for tool "${input.toolId}"`,
        statusCode: Option.none(),
      });
    }
    const stored = yield* input.ctx.storage.getSource(entry.namespace, input.toolScope);
    if (!stored) {
      return yield* new GoogleDiscoveryInvocationError({
        message: `No Google Discovery source found for "${entry.namespace}"`,
        statusCode: Option.none(),
      });
    }
    const source = stored.config;
    const credentials = yield* resolveInvocationCredentials(input.ctx, source.credentials);

    const authHeader =
      source.auth.kind === "oauth2"
        ? `Bearer ${yield* input.ctx.connections.accessToken(source.auth.connectionId).pipe(
            Effect.mapError(
              (err) =>
                new GoogleDiscoveryOAuthError({
                  message: errorMessageFromUnknown(err),
                }),
            ),
          )}`
        : undefined;

    const layer = input.httpClientLayer ?? FetchHttpClient.layer;

    return yield* performRequest({
      method: entry.binding.method,
      pathTemplate: entry.binding.pathTemplate,
      parameters: entry.binding.parameters,
      hasBody: entry.binding.hasBody,
      source,
      args: (input.args ?? {}) as Record<string, unknown>,
      authorizationHeader: authHeader,
      credentialHeaders: credentials.headers,
      credentialQueryParams: credentials.queryParams,
    }).pipe(Effect.provide(layer)) as Effect.Effect<
      GoogleDiscoveryInvocationResult,
      GoogleDiscoveryInvocationError,
      never
    >;
  });
