import { httpProviderError, graphqlProviderError, accountProviderError } from "./provider-error.ts";
import { ProviderError } from "../contracts/provider-error.ts";
/** Discover GraphQL tools live; transport, decoding and cancellation stay in Effect. */
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
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
  type GraphqlField,
  type GraphqlTools,
  type GraphqlTypeRef,
} from "../contracts/graphql.ts";
import { JsonObject } from "../effect.ts";
import { jsonSchemaDecoder } from "../effect.ts";

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

function fieldInput(field: GraphqlField, catalog: GraphqlIntrospection) {
  const types = new Map(catalog.__schema.types.map((type) => [type.name, type]));
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
export const graphqlToolsEffect = (
  input: GraphqlToolsOptions,
): Effect.Effect<GraphqlTools, GraphqlError | ProviderError> =>
  Effect.gen(function* () {
    const options = yield* Schema.decodeUnknownEffect(GraphqlToolsOptions)(input).pipe(
      Effect.mapError(() => new GraphqlError({ phase: "discover", reason: "invalid_input" })),
    );
    const url = new URL(options.url);
    if (url.username || url.password || url.hash)
      return yield* new GraphqlError({ phase: "discover", reason: "invalid_input" });
    const headers = Redacted.make({ ...options.headers });
    const request = (phase: "discover" | "call", query: string, variables: JsonObject = {}) =>
      Effect.scoped(
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
          if (response.status < 200 || response.status >= 300)
            return yield* (
              httpProviderError(response.status, response.headers) ??
                new GraphqlError({ phase, reason: "request", status: response.status })
            );
          const result = yield* response.json.pipe(
            Effect.withSpan("provider.http.response.read"),
            Effect.flatMap(Schema.decodeUnknownEffect(GraphqlResponse)),
            Effect.mapError(() => new GraphqlError({ phase, reason: "invalid_response" })),
          );
          if (result.errors?.length)
            return yield* (
              graphqlProviderError(result.errors, response.status) ??
                new GraphqlError({ phase, reason: "execution", status: response.status })
            );
          if (result.data == null)
            return yield* new GraphqlError({ phase, reason: "invalid_response" });
          return result.data;
        }),
      ).pipe(
        Effect.withSpan("provider.graphql.request", {
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
          orElse: () => Effect.fail(new GraphqlError({ phase, reason: "timeout" })),
        }),
        Effect.mapError((error) =>
          error instanceof ProviderError && options.accountId !== undefined
            ? accountProviderError(error, options.accountId)
            : error instanceof GraphqlError || error instanceof ProviderError
              ? error
              : new GraphqlError({ phase, reason: "request" }),
        ),
      );
    const catalog = yield* request("discover", getIntrospectionQuery()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GraphqlIntrospection)),
      Effect.mapError((error) =>
        error instanceof GraphqlError || error instanceof ProviderError
          ? error
          : new GraphqlError({ phase: "discover", reason: "invalid_response" }),
      ),
    );
    const roots = [
      { kind: OperationTypeNode.QUERY, type: catalog.__schema.queryType },
      { kind: OperationTypeNode.MUTATION, type: catalog.__schema.mutationType },
    ].flatMap(({ kind, type }) =>
      (catalog.__schema.types.find((item) => item.name === type?.name)?.fields ?? []).map(
        (field) => ({ kind, field }),
      ),
    );
    const entries = yield* Effect.forEach(roots, ({ kind, field }) =>
      Effect.gen(function* () {
        const definition = yield* Effect.try({
          try: () => fieldInput(field, catalog),
          catch: () => new GraphqlError({ phase: "discover", reason: "invalid_response" }),
        });
        const decoder = yield* jsonSchemaDecoder(definition.schema).pipe(
          Effect.mapError(
            () => new GraphqlError({ phase: "discover", reason: "invalid_response" }),
          ),
        );
        const name = kind + "_" + field.name;
        const tool: GraphqlTools[string] = {
          description: field.description ?? field.name,
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
                  const used = field.args.filter((arg) => Object.hasOwn(variables, arg.name));
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
                          type: parseType(typeName(arg.type)),
                        })),
                        selectionSet: {
                          kind: Kind.SELECTION_SET,
                          selections: [
                            {
                              kind: Kind.FIELD,
                              name: { kind: Kind.NAME, value: field.name },
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
              const data = yield* request("call", query, variables);
              const value = Object.hasOwn(data, field.name) ? data[field.name] : undefined;
              if (value === undefined)
                return yield* new GraphqlError({ phase: "call", reason: "invalid_response" });
              return value;
            }).pipe(
              Effect.withSpan("provider.graphql.call", {
                attributes: {
                  "graphql.operation.type": kind,
                  "executor.tool.name": name,
                },
              }),
            ),
        };
        return [name, tool] as const;
      }),
    );
    return Object.fromEntries(entries);
  });
