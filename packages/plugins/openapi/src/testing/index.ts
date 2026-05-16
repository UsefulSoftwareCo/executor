import { Context, Data, Effect, Layer, Predicate, Ref, Schema, Scope } from "effect";
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
}

export interface OpenApiHttpApiTestServerShape extends OpenApiTestServerShape {
  readonly specUrl: string;
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

const OpenApiEchoItemsGroup = HttpApiGroup.make("items")
  .add(HttpApiEndpoint.get("listItems", "/items", { success: Schema.Array(OpenApiEchoItem) }))
  .add(HttpApiEndpoint.get("echoHeaders", "/echo-headers", { success: OpenApiEchoHeaders }));

const OpenApiEchoApi = HttpApi.make("executorOpenApiTest")
  .add(OpenApiEchoItemsGroup)
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
    try: () => {
      const annotated = (api as HttpApi.AnyWithProps).annotateMerge(
        OpenApi.annotations({
          servers: [{ url: baseUrl }],
          transform: transformSpec,
        }),
      );
      return JSON.stringify(OpenApi.fromApi(annotated));
    },
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
                      headers: { "www-authenticate": options.oauth2.wwwAuthenticate },
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
      handlersLayer: makeOpenApiEchoItemsGroupLive(requests, options),
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
