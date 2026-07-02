import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { GraphqlIntrospectionError } from "./errors";

// ---------------------------------------------------------------------------
// Introspection query — standard GraphQL introspection
// ---------------------------------------------------------------------------

const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind
        name
        description
        fields(includeDeprecated: false) {
          name
          description
          args {
            name
            description
            type {
              ...TypeRef
            }
            defaultValue
          }
          type {
            ...TypeRef
          }
        }
        inputFields {
          name
          description
          type {
            ...TypeRef
          }
          defaultValue
        }
        enumValues(includeDeprecated: false) {
          name
          description
        }
      }
    }
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Introspection result types
// ---------------------------------------------------------------------------

const IntrospectionTypeRefLeaf = Schema.Struct({
  kind: Schema.String,
  name: Schema.NullOr(Schema.String),
  ofType: Schema.optional(Schema.Null),
});

const IntrospectionTypeRef5 = Schema.Struct({
  kind: Schema.String,
  name: Schema.NullOr(Schema.String),
  ofType: Schema.optional(Schema.NullOr(IntrospectionTypeRefLeaf)),
});

const IntrospectionTypeRef4 = Schema.Struct({
  kind: Schema.String,
  name: Schema.NullOr(Schema.String),
  ofType: Schema.optional(Schema.NullOr(IntrospectionTypeRef5)),
});

const IntrospectionTypeRef3 = Schema.Struct({
  kind: Schema.String,
  name: Schema.NullOr(Schema.String),
  ofType: Schema.optional(Schema.NullOr(IntrospectionTypeRef4)),
});

const IntrospectionTypeRef2 = Schema.Struct({
  kind: Schema.String,
  name: Schema.NullOr(Schema.String),
  ofType: Schema.optional(Schema.NullOr(IntrospectionTypeRef3)),
});

const IntrospectionTypeRefSchema = Schema.Struct({
  kind: Schema.String,
  name: Schema.NullOr(Schema.String),
  ofType: Schema.optional(Schema.NullOr(IntrospectionTypeRef2)),
});

const IntrospectionInputValueSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  type: IntrospectionTypeRefSchema,
  defaultValue: Schema.NullOr(Schema.String),
});

const IntrospectionFieldSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  args: Schema.Array(IntrospectionInputValueSchema),
  type: IntrospectionTypeRefSchema,
});

const IntrospectionTypeSchema = Schema.Struct({
  kind: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  fields: Schema.NullOr(Schema.Array(IntrospectionFieldSchema)),
  inputFields: Schema.NullOr(Schema.Array(IntrospectionInputValueSchema)),
  enumValues: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.NullOr(Schema.String),
      }),
    ),
  ),
});

const IntrospectionResultSchema = Schema.Struct({
  __schema: Schema.Struct({
    queryType: Schema.NullOr(Schema.Struct({ name: Schema.String })),
    mutationType: Schema.NullOr(Schema.Struct({ name: Schema.String })),
    types: Schema.Array(IntrospectionTypeSchema),
  }),
});

const IntrospectionResponseSchema = Schema.Struct({
  data: Schema.optional(IntrospectionResultSchema),
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
});

const UpstreamErrorResponseSchema = Schema.Struct({
  message: Schema.optional(Schema.String),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.optional(Schema.String),
      }),
    ),
  ),
});

const IntrospectionJsonSchema = Schema.Union([
  Schema.Struct({ data: IntrospectionResultSchema }),
  IntrospectionResultSchema,
]);
const JsonTextSchema = Schema.fromJsonString(Schema.Unknown);

const decodeUpstreamErrorResponse = Schema.decodeUnknownOption(UpstreamErrorResponseSchema);

export type IntrospectionTypeRef = typeof IntrospectionTypeRefSchema.Type;
export type IntrospectionInputValue = typeof IntrospectionInputValueSchema.Type;
export type IntrospectionField = typeof IntrospectionFieldSchema.Type;
export type IntrospectionEnumValue = NonNullable<
  (typeof IntrospectionTypeSchema.Type)["enumValues"]
>[number];
export type IntrospectionType = typeof IntrospectionTypeSchema.Type;
export type IntrospectionSchema = (typeof IntrospectionResultSchema.Type)["__schema"];
export type IntrospectionResult = typeof IntrospectionResultSchema.Type;

const firstUpstreamErrorMessage = (value: unknown): string | null => {
  const decoded = decodeUpstreamErrorResponse(value);
  return Option.match(decoded, {
    onNone: () => null,
    onSome: (response) => {
      if (response.message) return response.message;
      for (const entry of response.errors ?? []) {
        const message = entry.message;
        if (message) return message;
      }
      return null;
    },
  });
};

const redactUpstreamBody = (body: string): string =>
  body
    .replaceAll(
      /("(?:access_token|refresh_token|id_token|client_secret|token|authorization)"\s*:\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replaceAll(
      /((?:access_token|refresh_token|id_token|client_secret|token|authorization)=)[^&\s]*/gi,
      "$1[redacted]",
    )
    .replaceAll(
      /((?:authorization|access-token|refresh-token|id-token|client-secret|token)\s*:\s*)(?:bearer\s+)?[^\s,;]+/gi,
      "$1[redacted]",
    );

const upstreamTextMessage = (body: string): string | null => {
  const text = redactUpstreamBody(body.replaceAll(/\s+/g, " ").trim());
  if (text.length === 0) return null;
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
};

// ---------------------------------------------------------------------------
// Introspect a GraphQL endpoint
// ---------------------------------------------------------------------------

export const introspect = Effect.fn("GraphQL.introspect")(function* (
  endpoint: string,
  headers?: Record<string, string>,
  queryParams?: Record<string, string>,
) {
  const client = yield* HttpClient.HttpClient;
  const requestEndpoint =
    queryParams && Object.keys(queryParams).length > 0
      ? (() => {
          const url = new URL(endpoint);
          for (const [name, value] of Object.entries(queryParams)) {
            url.searchParams.set(name, value);
          }
          return url.toString();
        })()
      : endpoint;

  let request = HttpClientRequest.post(requestEndpoint).pipe(
    HttpClientRequest.setHeader("Content-Type", "application/json"),
    HttpClientRequest.setHeader("Accept", "application/json"),
    HttpClientRequest.setHeader("User-Agent", "executor-graphql"),
    HttpClientRequest.bodyJsonUnsafe({
      query: INTROSPECTION_QUERY,
    }),
  );

  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      request = HttpClientRequest.setHeader(request, k, v);
    }
  }

  const response = yield* client.execute(request).pipe(
    Effect.tapCause((cause) => Effect.logError("graphql introspection request failed", cause)),
    Effect.mapError(
      () =>
        new GraphqlIntrospectionError({
          message: "Failed to reach GraphQL endpoint",
        }),
    ),
  );

  if (response.status !== 200) {
    const responseText = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
    const raw = responseText
      ? yield* Schema.decodeUnknownEffect(JsonTextSchema)(responseText).pipe(
          Effect.catch(() => Effect.succeed(null)),
        )
      : null;
    const upstreamMessage = upstreamTextMessage(
      (raw === null ? null : firstUpstreamErrorMessage(raw)) ?? responseText,
    );
    return yield* new GraphqlIntrospectionError({
      message: upstreamMessage
        ? `Introspection failed with status ${response.status}: ${upstreamMessage}`
        : `Introspection failed with status ${response.status}`,
    });
  }

  const raw = yield* response.json.pipe(
    Effect.tapCause((cause) => Effect.logError("graphql introspection JSON parse failed", cause)),
    Effect.mapError(
      () =>
        new GraphqlIntrospectionError({
          message: `Failed to parse introspection response as JSON`,
        }),
    ),
  );

  const json = yield* Schema.decodeUnknownEffect(IntrospectionResponseSchema)(raw).pipe(
    Effect.mapError(
      () =>
        new GraphqlIntrospectionError({
          message: "Introspection response has an invalid shape",
        }),
    ),
  );

  if (json.errors && Array.isArray(json.errors) && json.errors.length > 0) {
    const upstreamMessage = firstUpstreamErrorMessage(json);
    return yield* new GraphqlIntrospectionError({
      message: upstreamMessage
        ? `Introspection returned ${json.errors.length} error(s): ${upstreamMessage}`
        : `Introspection returned ${json.errors.length} error(s)`,
    });
  }

  if (!json.data?.__schema) {
    return yield* new GraphqlIntrospectionError({
      message: "Introspection response missing __schema",
    });
  }

  return json.data;
});

// ---------------------------------------------------------------------------
// Parse an introspection result from a JSON string (for offline/text input)
// ---------------------------------------------------------------------------

export const parseIntrospectionJson = (
  text: string,
): Effect.Effect<IntrospectionResult, GraphqlIntrospectionError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(IntrospectionJsonSchema))(text).pipe(
    Effect.map((parsed) => ("data" in parsed ? parsed.data : parsed)),
    Effect.mapError(
      () =>
        new GraphqlIntrospectionError({
          message: "Failed to parse introspection JSON",
        }),
    ),
  );
