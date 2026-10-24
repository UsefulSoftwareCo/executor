/** API URL imports reuse the app framework's protocol readers and ordinary source templates. */
import { ByteSize, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClientRequest, HttpIncomingMessage } from "effect/http";
import { getIntrospectionQuery } from "graphql";
import { GraphqlIntrospection } from "apps/graphql";
import { prepareOpenapiImport } from "apps/openapi";
import {
  graphqlAppSource,
  openapiAppSource,
  type GeneratedAuthMethod,
} from "@executor-js/app-templates";
import { parseDestination } from "@executor-js/utils/url-policy";
import { withExecutorUserAgent } from "@executor-js/sdk/core";
import { CatalogImportFailed, type CatalogHost } from "../contracts/catalog.ts";
import type { CustomAppInput } from "../contracts/imports.ts";

const invalid = () =>
  new CatalogImportFailed({
    code: "invalid_source",
    reason:
      "This URL did not provide a supported API definition. Check the URL and API settings, or add the service with your agent.",
  });
const destination = (url: string, host: CatalogHost) =>
  parseDestination(url, host.egress.policy) === undefined
    ? Effect.fail(
        new CatalogImportFailed({
          code: "destination_blocked",
          reason: "This API address is not allowed by this Executor instance.",
        }),
      )
    : Effect.void;

/** Bound reads and refuse redirects through the same checked client as catalog and MCP imports. */
const read = (request: HttpClientRequest.HttpClientRequest, host: CatalogHost) =>
  Effect.gen(function* () {
    yield* destination(request.url, host);
    const response = yield* withExecutorUserAgent(host.egress.client).execute(request);
    if (response.status !== 200) return yield* invalid();
    return yield* response.text;
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(40_000_000)),
    Effect.timeout("30 seconds"),
    Effect.mapError(() => invalid()),
  );

const GraphqlResponse = Schema.Struct({
  data: Schema.Unknown,
  errors: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

export const generateApiApp = (
  input: Exclude<CustomAppInput, { kind: "mcp" }>,
  host: CatalogHost,
) =>
  Effect.gen(function* () {
    yield* destination(input.url, host);
    if (input.kind === "graphql") {
      // A protected schema becomes available after the caller connects an account. Public
      // endpoints must supply a usable schema before an app is installed.
      if (input.auth === undefined) {
        const request = yield* HttpClientRequest.post(input.url).pipe(
          HttpClientRequest.bodyJson({ query: getIntrospectionQuery() }),
        );
        const response = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GraphqlResponse))(
          yield* read(request, host),
        ).pipe(Effect.mapError(invalid));
        if (response.errors?.length) return yield* invalid();
        yield* Schema.decodeUnknownEffect(GraphqlIntrospection)(response.data).pipe(
          Effect.mapError(invalid),
        );
      }
      const methods: Record<string, GeneratedAuthMethod> =
        input.auth === undefined
          ? {}
          : {
              apiKey: {
                kind: "secrets",
                label: input.auth.kind === "bearer" ? "Bearer token" : "API key",
                fields: ["token"],
                placements: [
                  {
                    carrier: "header",
                    name: input.auth.kind === "bearer" ? "Authorization" : input.auth.header,
                    prefix: input.auth.kind === "bearer" ? "Bearer " : "",
                    field: "token",
                  },
                ],
              },
            };
      return yield* graphqlAppSource({ name: input.name, url: input.url, methods });
    }
    if (input.baseUrl !== undefined) yield* destination(input.baseUrl, host);
    const text = yield* read(HttpClientRequest.get(input.url), host);
    const prepared = yield* Effect.tryPromise({
      try: (signal) =>
        prepareOpenapiImport({
          text,
          url: input.url,
          signal,
          ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        }),
      catch: invalid,
    });
    if (prepared.skipped.length > 0)
      return yield* new CatalogImportFailed({
        code: "invalid_source",
        reason:
          "Some API operations are unsupported. Add this service with your agent to review the definition and choose which tools to expose.",
      });
    const [first, ...rest] = prepared.allowedOrigins;
    if (first === undefined) return yield* invalid();
    yield* Effect.forEach(prepared.allowedOrigins, (origin) => destination(origin, host));
    const methods: Record<string, GeneratedAuthMethod> = Object.fromEntries([
      ...prepared.secrets.map(
        (method) =>
          [
            method.name,
            {
              kind: "secrets" as const,
              label: method.label,
              fields: [...new Set(method.bindings.map(({ field }) => field))],
              // liveOpenapiRouter sends each binding only for operations that declare its scheme.
              placements: [],
            },
          ] as const,
      ),
      ...prepared.oauth.map(
        (method) =>
          [
            method.name,
            {
              kind: "oauth" as const,
              oauth: method.config,
              header: "Authorization",
              prefix: "Bearer ",
            },
          ] as const,
      ),
    ]);
    return yield* openapiAppSource({
      name: input.name,
      sourceUrl: input.url,
      methods,
      allowedOrigins: [first, ...rest],
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      security: {
        securitySchemes: prepared.securitySchemes,
        methods: prepared.methods,
        oauth: prepared.oauth.map(({ name }) => name),
      },
    });
  }).pipe(Effect.mapError((error) => (Schema.is(CatalogImportFailed)(error) ? error : invalid())));
