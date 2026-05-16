import {
  Context,
  Data,
  Effect,
  Layer,
  Predicate,
  Ref,
  Schema as EffectSchema,
  Scope,
} from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { GraphQLSchema } from "graphql";
import {
  createSchema,
  createYoga,
  type GraphQLParams,
  type YogaInitialContext,
} from "graphql-yoga";
import { OAuthTestServer, serveTestHttpApp } from "@executor-js/sdk/testing";

const GraphqlRequestPayload = EffectSchema.Struct({
  query: EffectSchema.optional(EffectSchema.String),
  variables: EffectSchema.optional(EffectSchema.Record(EffectSchema.String, EffectSchema.Unknown)),
  operationName: EffectSchema.optional(EffectSchema.NullOr(EffectSchema.String)),
});

type GraphqlRequestPayload = typeof GraphqlRequestPayload.Type;

export interface GraphqlTestRequest {
  readonly url: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: GraphqlRequestPayload;
}

export interface GraphqlTestContext {
  readonly request: GraphqlTestRequest;
}

export interface GraphqlTestServerOptions {
  readonly schema: GraphQLSchema;
  readonly path?: string;
  readonly auth?: {
    readonly validateAuthorization: (authorization: string | null) => Effect.Effect<boolean>;
    readonly wwwAuthenticate?: string;
  };
}

export interface GraphqlTestServerShape {
  readonly endpoint: string;
  readonly schema: GraphQLSchema;
  readonly requests: Effect.Effect<readonly GraphqlTestRequest[]>;
  readonly clearRequests: Effect.Effect<void>;
}

class GraphqlTestServerAddressError extends Data.TaggedError("GraphqlTestServerAddressError")<{
  readonly address: unknown;
}> {}

class GraphqlTestServerHandlerError extends Data.TaggedError("GraphqlTestServerHandlerError")<{
  readonly cause: unknown;
}> {}

const headersFromRequest = (headers: Headers): Readonly<Record<string, string>> =>
  Object.fromEntries(headers.entries());

const payloadFromParams = (params: GraphQLParams): GraphqlRequestPayload => ({
  query: params.query,
  variables:
    typeof params.variables === "object" && params.variables !== null
      ? params.variables
      : undefined,
  operationName: params.operationName ?? null,
});

const captureRequest = (
  initial: YogaInitialContext,
  requests: Ref.Ref<readonly GraphqlTestRequest[]>,
) => {
  const url = new URL(initial.request.url);
  const captured: GraphqlTestRequest = {
    url: initial.request.url,
    method: initial.request.method,
    path: url.pathname,
    headers: headersFromRequest(initial.request.headers),
    payload: payloadFromParams(initial.params),
  };
  return Effect.runPromise(
    Ref.update(requests, (all) => [...all, captured]).pipe(Effect.as(captured)),
  );
};

export const serveGraphqlTestServer = (
  options: GraphqlTestServerOptions,
): Effect.Effect<
  GraphqlTestServerShape,
  GraphqlTestServerAddressError | GraphqlTestServerHandlerError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<readonly GraphqlTestRequest[]>([]);
    const path = options.path ?? "/graphql";

    const yoga = createYoga<Record<string, never>, GraphqlTestContext>({
      schema: options.schema,
      graphqlEndpoint: path,
      graphiql: false,
      landingPage: false,
      logging: false,
      maskedErrors: false,
      context: (initial) =>
        captureRequest(initial, requests).then((request) => ({
          request,
        })),
    });

    const server = yield* serveTestHttpApp((request) =>
      Effect.gen(function* () {
        if (options.auth) {
          const accepted = yield* options.auth.validateAuthorization(
            request.headers.authorization ?? null,
          );
          if (!accepted) {
            const responseOptions = options.auth.wwwAuthenticate
              ? {
                  status: 401,
                  headers: { "www-authenticate": options.auth.wwwAuthenticate },
                }
              : { status: 401 };
            return HttpServerResponse.jsonUnsafe(
              { errors: [{ message: "Unauthorized" }] },
              responseOptions,
            );
          }
        }
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.promise(() => Promise.resolve(yoga.handle(webRequest, {})));
        return HttpServerResponse.fromWeb(response);
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.text("GraphQL test server failed", {
              status: 500,
              contentType: "text/plain",
            }),
          ),
        ),
      ),
    ).pipe(
      Effect.mapError((error) =>
        Predicate.isTagged(error, "TestHttpServerAddressError")
          ? new GraphqlTestServerAddressError({ address: error.address })
          : new GraphqlTestServerHandlerError({ cause: error.cause }),
      ),
    );

    return {
      endpoint: server.url(path),
      schema: options.schema,
      requests: Ref.get(requests),
      clearRequests: Ref.set(requests, []),
    };
  });

export const serveGraphqlFailureTestServer = (options: {
  readonly status: number;
  readonly body: string;
  readonly contentType?: string;
  readonly path?: string;
}) =>
  serveTestHttpApp(() =>
    Effect.succeed(
      HttpServerResponse.text(options.body, {
        status: options.status,
        contentType: options.contentType ?? "text/plain",
      }),
    ),
  ).pipe(
    Effect.map((server) => ({
      endpoint: server.url(options.path ?? "/graphql"),
      httpClientLayer: server.httpClientLayer,
    })),
  );

export class GraphqlTestServer extends Context.Service<GraphqlTestServer, GraphqlTestServerShape>()(
  "@executor-js/plugin-graphql/testing/GraphqlTestServer",
) {
  static readonly layer = (options: GraphqlTestServerOptions) =>
    Layer.effect(GraphqlTestServer, serveGraphqlTestServer(options));

  static readonly layerWithOAuth = (options: Omit<GraphqlTestServerOptions, "auth">) =>
    Layer.effect(
      GraphqlTestServer,
      Effect.gen(function* () {
        const oauth = yield* OAuthTestServer;
        return yield* serveGraphqlTestServer({
          ...options,
          auth: {
            validateAuthorization: oauth.acceptsAuthorizationHeader,
            wwwAuthenticate: 'Bearer error="invalid_token"',
          },
        });
      }),
    );
}

const stringArgument = (
  args: Readonly<Record<string, unknown>>,
  key: string,
  fallback: string,
): string => {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
};

export const makeGreetingGraphqlSchema = (
  options: { readonly includeMutation?: boolean } = {},
): GraphQLSchema => {
  const includeMutation = options.includeMutation ?? true;
  return createSchema<GraphqlTestContext>({
    typeDefs: /* GraphQL */ `
      type Query {
        hello(name: String): String
      }

      ${
        includeMutation
          ? /* GraphQL */ `
              type Mutation {
                setGreeting(message: String!): String
              }
            `
          : ""
      }
    `,
    resolvers: {
      Query: {
        hello: (_source: unknown, args: Readonly<Record<string, unknown>>) =>
          `Hello ${stringArgument(args, "name", "world")}`,
      },
      ...(includeMutation
        ? {
            Mutation: {
              setGreeting: (_source: unknown, args: Readonly<Record<string, unknown>>) =>
                stringArgument(args, "message", ""),
            },
          }
        : {}),
    },
  });
};

export const TestLayers = {
  greeting: () => GraphqlTestServer.layer({ schema: makeGreetingGraphqlSchema() }),
  greetingWithOAuth: () =>
    GraphqlTestServer.layerWithOAuth({ schema: makeGreetingGraphqlSchema() }),
};
