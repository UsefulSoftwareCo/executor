import { Context, Data, Effect, Layer, Option, Predicate, Ref, Schema, Scope } from "effect";
import {
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { OAuthTestServer, serveTestHttpServerLayer } from "@executor-js/sdk/testing";
import { isToolResult } from "@executor-js/sdk/core";
import type { OpenApiPluginExtension, OpenApiSpecConfig } from "../sdk/plugin";

export class OpenApiTestServerAddressError extends Data.TaggedError(
  "OpenApiTestServerAddressError",
)<{
  readonly address: unknown;
}> {}

export class OpenApiTestServerSpecError extends Data.TaggedError("OpenApiTestServerSpecError")<{
  readonly cause: unknown;
}> {}

export interface OpenApiTestServerShape {
  readonly baseUrl: string;
  readonly specJson: string;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>;
}

export interface OpenApiHttpApiTestServerOptions {
  readonly api: HttpApi.Any;
  readonly handlersLayer: Layer.Layer<any, any, any>;
  readonly specPath?: `/${string}`;
  readonly transformSpec?: (spec: Record<string, unknown>) => Record<string, unknown>;
  readonly captureSpecRequest?: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<void>;
  readonly guardSpecRequest?: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse | null>;
}

export interface OpenApiHttpApiTestServerShape extends OpenApiTestServerShape {
  readonly specUrl: string;
}

export interface MutableOpenApiSpecTestServerShape extends OpenApiTestServerShape {
  readonly specUrl: string;
  readonly setApi: (api: HttpApi.Any) => Effect.Effect<void, OpenApiTestServerSpecError>;
  readonly requestCount: Effect.Effect<number>;
}

export interface OpenApiTestRequest {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface OpenApiEchoTestServerOptions {
  readonly transformSpec?: (spec: Record<string, unknown>) => Record<string, unknown>;
  readonly oauth2?: {
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
    readonly scopes?: Readonly<Record<string, string>>;
    readonly validateAuthorization?: (authorization: string | null) => Effect.Effect<boolean>;
    readonly wwwAuthenticate?: string;
  };
}

export interface OpenApiEchoTestServerShape extends OpenApiTestServerShape {
  readonly specUrl: string;
  readonly requests: Effect.Effect<readonly OpenApiTestRequest[]>;
  readonly clearRequests: Effect.Effect<void>;
}

export type OpenApiTestSourceOptions = Omit<
  OpenApiSpecConfig,
  "spec" | "baseUrl" | "name" | "namespace"
> & {
  readonly baseUrl?: string | null;
  readonly name?: string;
  readonly namespace?: string;
};

export type OpenApiHttpApiTestSourceOptions = Omit<
  OpenApiSpecConfig,
  "spec" | "name" | "namespace" | "baseUrl"
> & {
  readonly name?: string;
  readonly namespace?: string;
  readonly baseUrl?: string | null;
  readonly specBaseUrl?: string;
  readonly transformSpec?: (spec: Record<string, unknown>) => Record<string, unknown>;
};

type OpenApiHttpApiAddSpecCredentialInput =
  | string
  | {
      readonly kind: "secret";
      readonly prefix?: string;
    };

type OpenApiHttpApiAddSpecCredentialsInput = {
  readonly headers?: Record<string, OpenApiHttpApiAddSpecCredentialInput>;
  readonly queryParams?: Record<string, OpenApiHttpApiAddSpecCredentialInput>;
};

export type OpenApiHttpApiTestAddSpecPayloadOptions = Omit<
  OpenApiHttpApiTestSourceOptions,
  "scope" | "headers" | "queryParams" | "specFetchCredentials"
> &
  OpenApiHttpApiAddSpecCredentialsInput & {
    readonly specFetchCredentials?: OpenApiHttpApiAddSpecCredentialsInput;
  };

export type OpenApiTestSourceExecutor = {
  readonly openapi: Pick<OpenApiPluginExtension, "addSpec">;
};

export interface OpenApiTestSpecOptions {
  readonly baseUrl?: string;
  readonly transformSpec?: (spec: Record<string, unknown>) => Record<string, unknown>;
}

export const makeOpenApiTestSpecJson = (
  api: HttpApi.Any,
  options: OpenApiTestSpecOptions = {},
): string => {
  const annotations = OpenApi.annotations({
    ...(options.baseUrl !== undefined ? { servers: [{ url: options.baseUrl }] } : {}),
    transform: options.transformSpec,
  });
  const annotated = (api as HttpApi.AnyWithProps).annotateMerge(annotations);
  return JSON.stringify(OpenApi.fromApi(annotated));
};

export const makeOpenApiTestSourceConfig = (
  server: OpenApiTestServerShape,
  options: OpenApiTestSourceOptions,
): OpenApiSpecConfig => {
  const { baseUrl, ...rest } = options;
  return {
    ...rest,
    spec: { kind: "blob", value: server.specJson },
    name: rest.name ?? "Test API",
    namespace: rest.namespace ?? "test_api",
    ...(baseUrl === null ? {} : { baseUrl: baseUrl ?? server.baseUrl }),
  } as OpenApiSpecConfig;
};

export const addOpenApiTestSource = (
  executor: OpenApiTestSourceExecutor,
  server: OpenApiTestServerShape,
  options: OpenApiTestSourceOptions,
) => executor.openapi.addSpec(makeOpenApiTestSourceConfig(server, options));

export const makeOpenApiHttpApiTestSourceConfig = (
  api: HttpApi.Any,
  options: OpenApiHttpApiTestSourceOptions,
): OpenApiSpecConfig => {
  const { baseUrl, specBaseUrl, transformSpec, ...config } = options;
  return {
    ...config,
    spec: {
      kind: "blob",
      value: makeOpenApiTestSpecJson(api, { baseUrl: specBaseUrl, transformSpec }),
    },
    name: config.name ?? "Test API",
    namespace: config.namespace ?? "test_api",
    ...(baseUrl === null ? {} : { baseUrl: baseUrl ?? specBaseUrl ?? "https://api.example.test" }),
  } as OpenApiSpecConfig;
};

export const addOpenApiHttpApiTestSource = (
  executor: OpenApiTestSourceExecutor,
  api: HttpApi.Any,
  options: OpenApiHttpApiTestSourceOptions,
) => executor.openapi.addSpec(makeOpenApiHttpApiTestSourceConfig(api, options));

export const makeOpenApiHttpApiTestAddSpecPayload = (
  api: HttpApi.Any,
  options: OpenApiHttpApiTestAddSpecPayloadOptions,
) => {
  const { ...sourceOptions } = options;
  const config = makeOpenApiHttpApiTestSourceConfig(api, {
    ...sourceOptions,
    scope: "unused-http-helper-scope",
  });
  return {
    spec: config.spec,
    namespace: config.namespace,
    name: config.name,
    baseUrl: config.baseUrl,
    ...(sourceOptions.headers !== undefined ? { headers: sourceOptions.headers } : {}),
    ...(sourceOptions.queryParams !== undefined ? { queryParams: sourceOptions.queryParams } : {}),
    ...(config.oauth2 !== undefined ? { oauth2: config.oauth2 } : {}),
    ...(sourceOptions.specFetchCredentials !== undefined
      ? { specFetchCredentials: sourceOptions.specFetchCredentials }
      : {}),
  };
};

export const makeOpenApiHttpApiTestSpecPayload = (
  api: HttpApi.Any,
  options: OpenApiTestSpecOptions = {},
) => ({
  spec: makeOpenApiTestSpecJson(api, options),
});

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const OpenApiEchoItem = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
});

const OpenApiEchoHeaders = Schema.Struct({
  authorization: Schema.optional(Schema.String),
  "x-static": Schema.optional(Schema.String),
});

const OpenApiEchoMessage = Schema.Struct({
  message: Schema.String,
  suffix: Schema.optional(Schema.String),
  path: Schema.String,
});

const OpenApiEchoItemsGroup = HttpApiGroup.make("items")
  .add(
    HttpApiEndpoint.get("listItems", "/items", {
      success: Schema.Array(OpenApiEchoItem),
    }),
  )
  .add(
    HttpApiEndpoint.get("echoHeaders", "/echo-headers", {
      success: OpenApiEchoHeaders,
    }),
  );

const OpenApiEchoGroup = HttpApiGroup.make("echo").add(
  HttpApiEndpoint.get("echoMessage", "/echo/:message", {
    params: Schema.Struct({ message: Schema.String }),
    query: Schema.Struct({ suffix: Schema.optional(Schema.String) }),
    success: OpenApiEchoMessage,
  }),
);

const OpenApiEchoApi = HttpApi.make("executorOpenApiTest")
  .add(OpenApiEchoItemsGroup)
  .add(OpenApiEchoGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Executor OpenAPI Test Server",
      version: "1.0.0",
    }),
  );

const openApiSpecJsonFromHttpApi = (
  api: HttpApi.Any,
  baseUrl: string,
  transformSpec?: (spec: Record<string, unknown>) => Record<string, unknown>,
): Effect.Effect<string, OpenApiTestServerSpecError> =>
  Effect.try({
    try: () => makeOpenApiTestSpecJson(api, { baseUrl, transformSpec }),
    catch: (cause) => new OpenApiTestServerSpecError({ cause }),
  });

export const serveOpenApiHttpApiTestServer = (
  options: OpenApiHttpApiTestServerOptions,
): Effect.Effect<
  OpenApiHttpApiTestServerShape,
  OpenApiTestServerAddressError | OpenApiTestServerSpecError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const specPath = options.specPath ?? "/spec.json";
    let specJson = "";
    const SpecRoute = HttpRouter.addAll([
      HttpRouter.route(
        "GET",
        specPath,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (options.captureSpecRequest) {
            yield* options.captureSpecRequest(request);
          }
          const guardResponse = options.guardSpecRequest
            ? yield* options.guardSpecRequest(request)
            : null;
          if (guardResponse) return guardResponse;
          return HttpServerResponse.text(specJson, {
            status: 200,
            contentType: "application/json",
          });
        }),
      ),
    ]);
    const ApiLive = HttpApiBuilder.layer(options.api as HttpApi.AnyWithProps).pipe(
      Layer.provide(options.handlersLayer),
    );
    const ServerLayer = HttpRouter.serve(Layer.mergeAll(ApiLive, SpecRoute), {
      disableListenLog: true,
      disableLogger: true,
    });
    const server = yield* serveTestHttpServerLayer(ServerLayer).pipe(
      Effect.mapError((error) =>
        Predicate.isTagged(error, "TestHttpServerAddressError")
          ? new OpenApiTestServerAddressError({ address: error.address })
          : new OpenApiTestServerSpecError({ cause: error.cause }),
      ),
    );
    specJson = yield* openApiSpecJsonFromHttpApi(
      options.api,
      server.baseUrl,
      options.transformSpec,
    );

    return {
      baseUrl: server.baseUrl,
      specUrl: server.url(specPath),
      specJson,
      httpClientLayer: server.httpClientLayer,
    };
  });

export class OpenApiHttpApiTestServer extends Context.Service<
  OpenApiHttpApiTestServer,
  OpenApiHttpApiTestServerShape
>()("@executor-js/plugin-openapi/testing/OpenApiHttpApiTestServer") {
  static readonly layer = (options: OpenApiHttpApiTestServerOptions) =>
    Layer.effect(OpenApiHttpApiTestServer, serveOpenApiHttpApiTestServer(options));
}

export const serveMutableOpenApiSpecTestServer = (options: {
  readonly initialApi: HttpApi.Any;
  readonly specPath?: `/${string}`;
  readonly transformSpec?: (spec: Record<string, unknown>) => Record<string, unknown>;
}): Effect.Effect<
  MutableOpenApiSpecTestServerShape,
  OpenApiTestServerAddressError | OpenApiTestServerSpecError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const specPath = options.specPath ?? "/spec.json";
    const specJson = yield* Ref.make("");
    const requests = yield* Ref.make(0);
    const SpecRoute = HttpRouter.addAll([
      HttpRouter.route(
        "GET",
        specPath,
        Effect.gen(function* () {
          yield* Ref.update(requests, (count) => count + 1);
          const current = yield* Ref.get(specJson);
          return HttpServerResponse.text(current, {
            status: 200,
            contentType: "application/json",
          });
        }),
      ),
    ]);
    const server = yield* serveTestHttpServerLayer(
      HttpRouter.serve(SpecRoute, {
        disableListenLog: true,
        disableLogger: true,
      }),
    ).pipe(
      Effect.mapError((error) =>
        Predicate.isTagged(error, "TestHttpServerAddressError")
          ? new OpenApiTestServerAddressError({ address: error.address })
          : new OpenApiTestServerSpecError({ cause: error.cause }),
      ),
    );
    const renderSpec = (api: HttpApi.Any) =>
      openApiSpecJsonFromHttpApi(api, server.baseUrl, options.transformSpec);
    yield* Ref.set(specJson, yield* renderSpec(options.initialApi));

    return {
      baseUrl: server.baseUrl,
      specUrl: server.url(specPath),
      specJson: yield* Ref.get(specJson),
      httpClientLayer: server.httpClientLayer,
      setApi: (api) => renderSpec(api).pipe(Effect.flatMap((next) => Ref.set(specJson, next))),
      requestCount: Ref.get(requests),
    };
  });

const openApiOperationMethods = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
]);

const withOAuth2Security =
  (oauth2: NonNullable<OpenApiEchoTestServerOptions["oauth2"]>) =>
  (spec: Record<string, unknown>): Record<string, unknown> => {
    const scopes = oauth2.scopes ?? { read: "Read test resources" };
    const security = [{ oauth2: Object.keys(scopes) }];
    const paths = isJsonObject(spec.paths)
      ? Object.fromEntries(
          Object.entries(spec.paths).map(([path, pathItem]) => [
            path,
            isJsonObject(pathItem)
              ? Object.fromEntries(
                  Object.entries(pathItem).map(([method, operation]) => [
                    method,
                    openApiOperationMethods.has(method) && isJsonObject(operation)
                      ? { ...operation, security }
                      : operation,
                  ]),
                )
              : pathItem,
          ]),
        )
      : spec.paths;
    const components = isJsonObject(spec.components) ? spec.components : {};
    const securitySchemes = isJsonObject(components.securitySchemes)
      ? components.securitySchemes
      : {};

    return {
      ...spec,
      paths,
      components: {
        ...components,
        securitySchemes: {
          ...securitySchemes,
          oauth2: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: oauth2.authorizationUrl,
                tokenUrl: oauth2.tokenUrl,
                scopes,
              },
            },
          },
        },
      },
    };
  };

const composeSpecTransforms =
  (
    ...transforms: readonly (
      | ((spec: Record<string, unknown>) => Record<string, unknown>)
      | undefined
    )[]
  ) =>
  (spec: Record<string, unknown>): Record<string, unknown> =>
    transforms.reduce((current, transform) => (transform ? transform(current) : current), spec);

const recordOpenApiRequest = (
  requests: Ref.Ref<readonly OpenApiTestRequest[]>,
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    const url = new URL(request.url, "http://executor.test");
    const body = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
    yield* Ref.update(requests, (all) => [
      ...all,
      {
        method: request.method,
        url: request.url,
        path: url.pathname,
        headers: request.headers,
        body,
      },
    ]);
    return request;
  });

const captureOpenApiRequest = (requests: Ref.Ref<readonly OpenApiTestRequest[]>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* recordOpenApiRequest(requests, request);
  });

const openApiUnauthorizedResponse = (
  options: OpenApiEchoTestServerOptions,
  authorization: string | null,
): Effect.Effect<HttpServerResponse.HttpServerResponse | null> =>
  options.oauth2?.validateAuthorization
    ? options.oauth2.validateAuthorization(authorization).pipe(
        Effect.map((accepted) =>
          accepted
            ? null
            : HttpServerResponse.jsonUnsafe(
                { error: "invalid_token" },
                options.oauth2?.wwwAuthenticate
                  ? {
                      status: 401,
                      headers: {
                        "www-authenticate": options.oauth2.wwwAuthenticate,
                      },
                    }
                  : { status: 401 },
              ),
        ),
      )
    : Effect.succeed(null);

const makeOpenApiEchoItemsGroupLive = (
  requests: Ref.Ref<readonly OpenApiTestRequest[]>,
  options: OpenApiEchoTestServerOptions,
) =>
  HttpApiBuilder.group(OpenApiEchoApi, "items", (handlers) =>
    handlers
      .handle("listItems", () =>
        Effect.gen(function* () {
          const request = yield* captureOpenApiRequest(requests);
          const unauthorized = yield* openApiUnauthorizedResponse(
            options,
            request.headers.authorization ?? null,
          );
          if (unauthorized) return unauthorized;
          return [
            OpenApiEchoItem.make({ id: 1, name: "Widget" }),
            OpenApiEchoItem.make({ id: 2, name: "Gadget" }),
          ];
        }),
      )
      .handle("echoHeaders", () =>
        Effect.gen(function* () {
          const request = yield* captureOpenApiRequest(requests);
          const unauthorized = yield* openApiUnauthorizedResponse(
            options,
            request.headers.authorization ?? null,
          );
          if (unauthorized) return unauthorized;
          return OpenApiEchoHeaders.make({
            authorization: request.headers.authorization,
            "x-static": request.headers["x-static"],
          });
        }),
      ),
  );

const makeOpenApiEchoGroupLive = (
  requests: Ref.Ref<readonly OpenApiTestRequest[]>,
  options: OpenApiEchoTestServerOptions,
) =>
  HttpApiBuilder.group(OpenApiEchoApi, "echo", (handlers) =>
    handlers.handle("echoMessage", ({ params, query }) =>
      Effect.gen(function* () {
        const request = yield* captureOpenApiRequest(requests);
        const unauthorized = yield* openApiUnauthorizedResponse(
          options,
          request.headers.authorization ?? null,
        );
        if (unauthorized) return unauthorized;
        const path = `/echo/${encodeURIComponent(params.message)}`;
        return OpenApiEchoMessage.make({
          message: params.message,
          ...(query.suffix ? { suffix: query.suffix } : {}),
          path,
        });
      }),
    ),
  );

export const serveOpenApiEchoTestServer = (
  options: OpenApiEchoTestServerOptions = {},
): Effect.Effect<
  OpenApiEchoTestServerShape,
  OpenApiTestServerAddressError | OpenApiTestServerSpecError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<readonly OpenApiTestRequest[]>([]);
    let specJson = "";
    const server = yield* serveOpenApiHttpApiTestServer({
      api: OpenApiEchoApi,
      handlersLayer: Layer.mergeAll(
        makeOpenApiEchoItemsGroupLive(requests, options),
        makeOpenApiEchoGroupLive(requests, options),
      ),
      transformSpec: composeSpecTransforms(
        options.oauth2 ? withOAuth2Security(options.oauth2) : undefined,
        options.transformSpec,
      ),
      captureSpecRequest: (request) => recordOpenApiRequest(requests, request).pipe(Effect.asVoid),
    });
    specJson = server.specJson;

    return {
      baseUrl: server.baseUrl,
      specUrl: server.specUrl,
      specJson,
      httpClientLayer: server.httpClientLayer,
      requests: Ref.get(requests),
      clearRequests: Ref.set(requests, []),
    };
  });

export const serveOpenApiEchoTestServerWithOAuth = (
  options: Omit<OpenApiEchoTestServerOptions, "oauth2"> & {
    readonly scopes?: Readonly<Record<string, string>>;
    readonly wwwAuthenticate?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const oauth = yield* OAuthTestServer;
    return yield* serveOpenApiEchoTestServer({
      transformSpec: options.transformSpec,
      oauth2: {
        authorizationUrl: oauth.authorizationEndpoint,
        tokenUrl: oauth.tokenEndpoint,
        scopes: options.scopes,
        validateAuthorization: oauth.acceptsAuthorizationHeader,
        wwwAuthenticate: options.wwwAuthenticate,
      },
    });
  });

export class OpenApiEchoTestServer extends Context.Service<
  OpenApiEchoTestServer,
  OpenApiEchoTestServerShape
>()("@executor-js/plugin-openapi/testing/OpenApiEchoTestServer") {
  static readonly layer = (options?: OpenApiEchoTestServerOptions) =>
    Layer.effect(OpenApiEchoTestServer, serveOpenApiEchoTestServer(options));

  static readonly layerWithOAuth = (
    options?: Omit<OpenApiEchoTestServerOptions, "oauth2"> & {
      readonly scopes?: Readonly<Record<string, string>>;
      readonly wwwAuthenticate?: string;
    },
  ) => Layer.effect(OpenApiEchoTestServer, serveOpenApiEchoTestServerWithOAuth(options));
}

export const TestLayers = {
  httpApi: OpenApiHttpApiTestServer.layer,
  echo: OpenApiEchoTestServer.layer,
  echoWithOAuth: OpenApiEchoTestServer.layerWithOAuth,
};

const OpenApiTransportEnvelope = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
  data: Schema.Unknown,
});

const decodeOpenApiTransportEnvelope = Schema.decodeUnknownOption(OpenApiTransportEnvelope);

export interface OpenApiInvocationResult<TData = Record<string, unknown> | unknown[] | null> {
  readonly status: number | null;
  readonly headers: Record<string, string> | null;
  readonly data: TData;
  readonly error: unknown;
}

export const unwrapInvocation = <TData = Record<string, unknown> | null>(
  raw: unknown,
): OpenApiInvocationResult<TData> => {
  if (!isToolResult(raw)) {
    return {
      status: null,
      headers: null,
      data: raw as TData,
      error: null,
    };
  }
  if (raw.ok) {
    const inner = raw.data;
    const wrapped = Option.getOrUndefined(decodeOpenApiTransportEnvelope(inner));
    if (wrapped !== undefined) {
      return {
        status: wrapped.status,
        headers: wrapped.headers,
        data: wrapped.data as TData,
        error: null,
      };
    }
    return {
      status: null,
      headers: null,
      data: inner as TData,
      error: null,
    };
  }
  return {
    status: raw.error.status ?? null,
    headers: null,
    data: null as TData,
    error: raw.error.details ?? raw.error,
  };
};
