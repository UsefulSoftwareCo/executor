import { owned } from "@executor-js/telemetry";
import { httpProviderError, graphqlProviderError, accountProviderError } from "./provider-error.ts";
import { ProviderError } from "../contracts/provider-error.ts";
import { NetworkRefused } from "../contracts/network.ts";
import { failOnNetworkRefusal } from "./network.ts";
/** Discover GraphQL tools live; transport, decoding and cancellation stay in Effect. */
import { Effect, Option, Redacted, Ref, Result, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import {
  getIntrospectionQuery,
  Kind,
  OperationTypeNode,
  parse,
  parseType,
  print,
  type SelectionSetNode,
} from "graphql";
import {
  defaultGraphqlClientLimits,
  GraphqlError,
  GraphqlIntrospection,
  GraphqlResponse,
  GraphqlToolsOptions,
  maxGraphqlStatedErrors,
  maxGraphqlStatedExtensions,
  maxGraphqlStatedFieldLength,
  type GraphqlStatedError,
  type GraphqlToolDefinition,
  type GraphqlField,
  type GraphqlTools,
  type GraphqlTypeRef,
} from "../contracts/graphql.ts";
import { FailureFieldName, maxUpstreamMessageLength } from "../contracts/failure.ts";
import { defaultOpenapiErrorLimits } from "../contracts/api-response-error.ts";
import { JsonObject } from "../effect.ts";
import { jsonSchemaDecoder } from "../effect.ts";
import { boundStated } from "./upstream-error.ts";

function wrapped(type: GraphqlTypeRef): GraphqlTypeRef {
  if (!type.ofType) throw new GraphqlError({ phase: "discover", reason: "invalid_response" });
  return type.ofType;
}
function named(type: GraphqlTypeRef): GraphqlTypeRef {
  return type.kind === "LIST" || type.kind === "NON_NULL" ? named(wrapped(type)) : type;
}
function typeName(type: GraphqlTypeRef): string {
  if (type.kind === "NON_NULL") return typeName(wrapped(type)) + "!";
  if (type.kind === "LIST") return "[" + typeName(wrapped(type)) + "]";
  if (!type.name) throw new GraphqlError({ phase: "discover", reason: "invalid_response" });
  return type.name;
}

function fieldInput(
  field: GraphqlField,
  types: ReadonlyMap<string, GraphqlIntrospection["__schema"]["types"][number]>,
) {
  const definitions = new Map<string, JsonObject>();
  const convert = (ref: GraphqlTypeRef): JsonObject =>
    ref.kind === "NON_NULL" ? nonNull(wrapped(ref)) : { anyOf: [nonNull(ref), { type: "null" }] };
  const nonNull = (ref: GraphqlTypeRef): JsonObject => {
    if (ref.kind === "LIST") return { type: "array", items: convert(wrapped(ref)) };
    if (!ref.name) throw new GraphqlError({ phase: "discover", reason: "invalid_response" });
    const type = types.get(ref.name);
    if (!type) throw new GraphqlError({ phase: "discover", reason: "invalid_response" });
    if (type.kind === "ENUM" && type.enumValues)
      return { type: "string", enum: type.enumValues.map((item) => item.name) };
    if (type.kind === "INPUT_OBJECT" && type.inputFields) {
      if (!definitions.has(type.name)) {
        definitions.set(type.name, {});
        definitions.set(type.name, argsSchema(type.inputFields));
      }
      return { $ref: "#/$defs/" + type.name };
    }
    if (type.kind !== "SCALAR")
      throw new GraphqlError({ phase: "discover", reason: "invalid_response" });
    switch (type.name) {
      case "Int":
        return { type: "integer", minimum: -2147483648, maximum: 2147483647 };
      case "Float":
        return { type: "number" };
      case "Boolean":
        return { type: "boolean" };
      case "ID":
        return { anyOf: [{ type: "string" }, { type: "integer" }] };
      case "String":
        return { type: "string" };
      default:
        return {}; // A custom scalar's wire format belongs to the upstream server.
    }
  };
  const argsSchema = (args: GraphqlField["args"]): JsonObject => ({
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      args.map((arg) => [
        arg.name,
        { ...convert(arg.type), ...(arg.description ? { description: arg.description } : {}) },
      ]),
    ),
    required: args
      .filter((arg) => arg.type.kind === "NON_NULL" && arg.defaultValue === null)
      .map((arg) => arg.name),
  });
  const output = named(field.type);
  const composite = ["OBJECT", "INTERFACE", "UNION"].includes(output.kind);
  const leaves =
    types
      .get(output.name ?? "")
      ?.fields?.filter((child) => {
        const type = named(child.type);
        return (
          (type.kind === "SCALAR" || type.kind === "ENUM") &&
          child.args.every((arg) => arg.type.kind !== "NON_NULL" || arg.defaultValue !== null)
        );
      })
      .map((child) => child.name) ?? [];
  const arguments_ = argsSchema(field.args);
  return {
    composite,
    selection: leaves.length ? leaves.join(" ") : "__typename",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        arguments: arguments_,
        ...(composite
          ? {
              select: {
                type: "string",
                minLength: 1,
                description:
                  "Fields to return, e.g. id name items { id title }. Omit to select scalar fields.",
              },
            }
          : {}),
      },
      required: field.args.some((arg) => arg.type.kind === "NON_NULL" && arg.defaultValue === null)
        ? ["arguments"]
        : [],
      $defs: Object.fromEntries(definitions),
    },
  };
}

/** One error of a GraphQL response's `errors` list; fields the specification does not document are not read. */
const ResponseError = Schema.Struct({
  message: Schema.String,
  path: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Int]))),
  extensions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

/**
 * The first segments of a response path, as many as a path of the longest carried length shows,
 * each bounded. They stay the server's segments: a segment can carry an account secret, which is
 * replaced before the path is written. A written segment is at least as long as counted here.
 */
const boundedPath = (path: ReadonlyArray<string | number>) => {
  const segments: Array<string | number> = [];
  let length = 0;
  for (const segment of path) {
    if (length > maxGraphqlStatedFieldLength) break;
    const bounded =
      typeof segment === "number" ? segment : boundStated(segment, maxGraphqlStatedFieldLength);
    length +=
      typeof bounded === "number"
        ? String(bounded).length + 2
        : Math.max(bounded.length, 1) + (segments.length === 0 ? 0 : 1);
    segments.push(bounded);
  }
  return segments;
};

/** The scalar `extensions` entries, `code` first; objects and lists, such as stack traces, are left out. */
const extensionEntries = (extensions: Readonly<Record<string, unknown>>) => {
  const entries: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const key of [
    ...(Object.hasOwn(extensions, "code") ? ["code"] : []),
    ...Object.keys(extensions).filter((key) => key !== "code"),
  ]) {
    if (count === maxGraphqlStatedExtensions) break;
    const value = extensions[key];
    if (!Schema.is(FailureFieldName)(key)) continue;
    if (typeof value === "string") entries[key] = boundStated(value, maxGraphqlStatedFieldLength);
    else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
      entries[key] = value;
    else continue;
    count++;
  }
  return count === 0 ? undefined : entries;
};

/**
 * The first errors a GraphQL server stated, bounded, and how many it stated when that is more.
 * Only the first errors of the list are read. Account secrets are not known here; they are
 * replaced when the failure leaves the app.
 */
const statedErrors = (errors: ReadonlyArray<unknown>) => {
  const stated = errors
    .slice(0, maxGraphqlStatedErrors)
    .flatMap((error) => Option.toArray(Schema.decodeUnknownOption(ResponseError)(error)))
    .map(({ message, path, extensions }): GraphqlStatedError => {
      const entries = extensions === undefined ? undefined : extensionEntries(extensions);
      return {
        message: boundStated(message, maxUpstreamMessageLength),
        ...(path === undefined || path.length === 0 ? {} : { path: boundedPath(path) }),
        ...(entries === undefined ? {} : { extensions: entries }),
      };
    });
  return {
    ...(stated.length === 0 ? {} : { errors: stated }),
    ...(errors.length > stated.length ? { stated: errors.length } : {}),
  };
};

type UnreadBody = NonNullable<GraphqlError["unreadBody"]>;

/** The `errors` list of a refused request's body; other content is not decoded. */
const RefusedBody = Schema.fromJsonString(
  Schema.Struct({ errors: Schema.optional(Schema.Array(Schema.Unknown)) }),
);

/**
 * The errors a refused request's JSON body stated, read within the bounds of OpenAPI error bodies.
 * Other bodies state nothing. A body that is too large or does not arrive in time is not read; the
 * refusal keeps its status.
 */
const refusedBody = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    if (
      !/^application\/(?:[\w.-]+\+)?json$/i.test(
        response.headers["content-type"]?.split(";")[0]?.trim() ?? "",
      )
    )
      return {};
    const length = response.headers["content-length"];
    if (length !== undefined && Number(length) > defaultOpenapiErrorLimits.maxBodyBytes)
      return { unreadBody: "too_large" as const };
    const text = yield* response.stream.pipe(
      Stream.mapError((): UnreadBody => "incomplete"),
      Stream.limitBytes(defaultOpenapiErrorLimits.maxBodyBytes, () =>
        Stream.fail<UnreadBody>("too_large"),
      ),
      Stream.decodeText,
      Stream.mkString,
      Effect.timeoutOrElse({
        duration: defaultOpenapiErrorLimits.readTimeoutMs,
        orElse: () => Effect.fail<UnreadBody>("incomplete"),
      }),
      Effect.result,
    );
    if (Result.isFailure(text)) return { unreadBody: text.failure };
    const body = Schema.decodeUnknownOption(RefusedBody)(text.success);
    return Option.isSome(body) && body.value.errors?.length ? statedErrors(body.value.errors) : {};
  });

function selection(text: string): SelectionSetNode {
  const document = parse("query { result { " + text + " } }");
  const definition = document.definitions[0];
  if (
    document.definitions.length !== 1 ||
    definition?.kind !== Kind.OPERATION_DEFINITION ||
    definition.selectionSet.selections.length !== 1
  ) {
    throw new GraphqlError({ phase: "call", reason: "invalid_input" });
  }
  const field = definition.selectionSet.selections[0];
  if (field?.kind !== Kind.FIELD || field.name.value !== "result" || !field.selectionSet)
    throw new GraphqlError({ phase: "call", reason: "invalid_input" });
  return field.selectionSet;
}

/** Resolve schema and calls per account evaluation; never cache credentials or tools globally. */
export const graphqlClientEffect = (input: GraphqlToolsOptions) =>
  Effect.gen(function* () {
    const options = yield* Schema.decodeUnknownEffect(GraphqlToolsOptions)(input).pipe(
      Effect.mapError(() => new GraphqlError({ phase: "discover", reason: "invalid_input" })),
    );
    const url = new URL(options.url);
    if (url.username || url.password || url.hash)
      return yield* new GraphqlError({ phase: "discover", reason: "invalid_input" });
    const headers = Redacted.make({ ...options.headers });
    const request = (phase: "discover" | "call", query: string, variables: JsonObject = {}) =>
      Effect.gen(function* () {
        // The status of a refused request, so a body still arriving at the deadline keeps it.
        const refusal = yield* Ref.make(Option.none<number>());
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient;
            const response = yield* HttpClient.withScope(client).execute(
              HttpClientRequest.post(url.href).pipe(
                // GitHub requires this header; Workers do not supply one by default.
                HttpClientRequest.setHeader("user-agent", "Executor"),
                HttpClientRequest.setHeaders(Redacted.value(headers)),
                HttpClientRequest.bodyJsonUnsafe({ query, variables }),
              ),
            );
            // Executor's network refused the request; its reason names the host or credential at fault.
            yield* failOnNetworkRefusal(response);
            if (response.status < 200 || response.status >= 300) {
              const classified = httpProviderError(response.status, response.headers);
              if (classified !== undefined) return yield* classified;
              // A server can answer a request it refuses, such as one that fails validation, with
              // a client error status and its errors in a GraphQL response body.
              yield* Ref.set(refusal, Option.some(response.status));
              const refused = yield* refusedBody(response).pipe(
                owned("upstream", "provider.http.response.read"),
              );
              return yield* new GraphqlError({
                phase,
                reason: "request",
                status: response.status,
                ...refused,
              });
            }
            const result = yield* response.json.pipe(
              owned("upstream", "provider.http.response.read"),
              Effect.flatMap(Schema.decodeUnknownEffect(GraphqlResponse)),
              Effect.mapError(() => new GraphqlError({ phase, reason: "invalid_response" })),
            );
            if (result.errors?.length)
              return yield* (
                graphqlProviderError(result.errors, response.status) ??
                  new GraphqlError({
                    phase,
                    reason: "execution",
                    status: response.status,
                    ...statedErrors(result.errors),
                  })
              );
            if (result.data == null)
              return yield* new GraphqlError({ phase, reason: "invalid_response" });
            return result.data;
          }),
        ).pipe(
          owned("upstream", "provider.graphql.request", {
            attributes: {
              "executor.operation": phase,
              "server.address": url.hostname,
            },
          }),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
          Effect.provide(FetchHttpClient.layer),
          Effect.timeoutOrElse({
            duration: options.timeoutMs ?? defaultGraphqlClientLimits.timeoutMs,
            orElse: () =>
              Effect.flatMap(Ref.get(refusal), (status) =>
                Effect.fail(
                  Option.isSome(status)
                    ? new GraphqlError({
                        phase,
                        reason: "request",
                        status: status.value,
                        unreadBody: "incomplete",
                      })
                    : new GraphqlError({ phase, reason: "timeout" }),
                ),
              ),
          }),
          Effect.mapError((error) =>
            error instanceof ProviderError && options.accountId !== undefined
              ? accountProviderError(error, options.accountId)
              : error instanceof GraphqlError ||
                  error instanceof ProviderError ||
                  error instanceof NetworkRefused
                ? error
                : new GraphqlError({ phase, reason: "request" }),
          ),
        );
      });
    const discover = request("discover", getIntrospectionQuery()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GraphqlIntrospection)),
      Effect.mapError((error) =>
        error instanceof GraphqlError ||
        error instanceof ProviderError ||
        error instanceof NetworkRefused
          ? error
          : new GraphqlError({ phase: "discover", reason: "invalid_response" }),
      ),
    );
    return { request, discover };
  });

/** Build serializable definitions once per introspection revision, without compiling validators. */
export const graphqlDefinitions = (catalog: GraphqlIntrospection) =>
  Effect.gen(function* () {
    const types = new Map(catalog.__schema.types.map((type) => [type.name, type]));
    const roots = (
      [
        { kind: OperationTypeNode.QUERY, type: catalog.__schema.queryType },
        { kind: OperationTypeNode.MUTATION, type: catalog.__schema.mutationType },
      ] as const
    ).flatMap(({ kind, type }) =>
      (catalog.__schema.types.find((item) => item.name === type?.name)?.fields ?? []).map(
        (field) => ({ kind, field }),
      ),
    );
    return yield* Effect.forEach(roots, ({ kind, field }) =>
      Effect.gen(function* () {
        const definition = yield* Effect.try({
          try: () => fieldInput(field, types),
          catch: () => new GraphqlError({ phase: "discover", reason: "invalid_response" }),
        });
        return yield* Effect.try({
          try: () => ({
            name: kind + "_" + field.name,
            kind,
            field: field.name,
            description: field.description ?? field.name,
            arguments: field.args.map((arg) => ({ name: arg.name, type: typeName(arg.type) })),
            inputSchema: definition.schema,
            composite: definition.composite,
            selection: definition.selection,
          }),
          catch: () => new GraphqlError({ phase: "discover", reason: "invalid_response" }),
        });
      }),
    );
  });

/** Bind only the selected definition to current credentials and compile its input decoder. */
export const adaptGraphqlTool = (
  client: Effect.Success<ReturnType<typeof graphqlClientEffect>>,
  definition: GraphqlToolDefinition,
) =>
  Effect.gen(function* () {
    const decoder = yield* jsonSchemaDecoder(definition.inputSchema).pipe(
      Effect.mapError(() => new GraphqlError({ phase: "discover", reason: "invalid_response" })),
    );
    const kind = definition.kind === "query" ? OperationTypeNode.QUERY : OperationTypeNode.MUTATION;
    const name = definition.name;
    const tool: GraphqlTools[string] = {
      description: definition.description,
      readOnly: kind === OperationTypeNode.QUERY,
      input: decoder,
      run: (_context, input) =>
        Effect.gen(function* () {
          const args = yield* Schema.decodeUnknownEffect(decoder)(input).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(JsonObject)),
            Effect.mapError(() => new GraphqlError({ phase: "call", reason: "invalid_input" })),
          );
          const variables = yield* Schema.decodeUnknownEffect(JsonObject)(
            args.arguments ?? {},
          ).pipe(
            Effect.mapError(() => new GraphqlError({ phase: "call", reason: "invalid_input" })),
          );
          const query = yield* Effect.try({
            try: () => {
              const used = definition.arguments.filter((arg) => Object.hasOwn(variables, arg.name));
              return print({
                kind: Kind.DOCUMENT,
                definitions: [
                  {
                    kind: Kind.OPERATION_DEFINITION,
                    operation: kind,
                    variableDefinitions: used.map((arg) => ({
                      kind: Kind.VARIABLE_DEFINITION,
                      variable: {
                        kind: Kind.VARIABLE,
                        name: { kind: Kind.NAME, value: arg.name },
                      },
                      type: parseType(arg.type),
                    })),
                    selectionSet: {
                      kind: Kind.SELECTION_SET,
                      selections: [
                        {
                          kind: Kind.FIELD,
                          name: { kind: Kind.NAME, value: definition.field },
                          arguments: used.map((arg) => ({
                            kind: Kind.ARGUMENT,
                            name: { kind: Kind.NAME, value: arg.name },
                            value: {
                              kind: Kind.VARIABLE,
                              name: { kind: Kind.NAME, value: arg.name },
                            },
                          })),
                          ...(definition.composite
                            ? {
                                selectionSet: selection(
                                  typeof args.select === "string"
                                    ? args.select
                                    : definition.selection,
                                ),
                              }
                            : {}),
                        },
                      ],
                    },
                  },
                ],
              });
            },
            catch: () => new GraphqlError({ phase: "call", reason: "invalid_input" }),
          });
          const data = yield* client.request("call", query, variables);
          const value = Object.hasOwn(data, definition.field) ? data[definition.field] : undefined;
          if (value === undefined)
            return yield* new GraphqlError({ phase: "call", reason: "invalid_response" });
          return value;
        }).pipe(
          owned("upstream", "provider.graphql.call", {
            attributes: {
              "graphql.operation.type": kind,
              "executor.tool.name": name,
            },
          }),
        ),
    };
    return tool;
  });

/** Low-level callers can still request a complete invocation-owned tool map. */
export const graphqlToolsEffect = (
  input: GraphqlToolsOptions,
): Effect.Effect<GraphqlTools, GraphqlError | ProviderError | NetworkRefused> =>
  Effect.gen(function* () {
    const client = yield* graphqlClientEffect(input);
    const definitions = yield* client.discover.pipe(Effect.flatMap(graphqlDefinitions));
    return Object.fromEntries(
      yield* Effect.forEach(definitions, (definition) =>
        adaptGraphqlTool(client, definition).pipe(
          Effect.map((tool) => [definition.name, tool] as const),
        ),
      ),
    );
  });
