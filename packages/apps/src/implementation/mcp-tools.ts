import type { ProviderError } from "../contracts/provider-error.ts";
import type { NetworkRefused } from "../contracts/network.ts";
import { ToolResultObservation } from "../contracts/host.ts";
/** Adapt any MCP transport into ordinary tools with shared validation behavior. */
import { Effect, Schema } from "effect";
import { McpError, type McpTools, type McpToolMetadata } from "../contracts/mcp.ts";
import { JsonObject, type JsonValue, jsonSchemaDecoder } from "../effect.ts";
import type { McpClient } from "./mcp-client.ts";
import { nestJsonSchema, preparedJsonSchemaDecoder } from "./schema.ts";

/** The fields of every `McpToolResult`. */
const resultFields = {
  content: { type: "array", items: { type: "object" } },
  structuredContent: { type: "object" },
  isError: { type: "boolean" },
  _meta: { type: "object" },
} satisfies JsonObject;

/** References that resolve the same from any document root that holds the same definitions. */
const definitionReference = /^#\/(?:\$defs|definitions)\/[^/]+$/;
/** Keywords that resolve relative to the schema resource that contains them. */
const locating = new Set(["$id", "$anchor", "$dynamicAnchor", "$recursiveAnchor"]);
const onlyDefinitionReferences = (value: JsonValue): boolean =>
  Array.isArray(value)
    ? value.every(onlyDefinitionReferences)
    : value === null || typeof value !== "object"
      ? true
      : Object.entries(value).every(([key, item]) =>
          locating.has(key) || key === "$dynamicRef" || key === "$recursiveRef"
            ? false
            : key === "$ref"
              ? typeof item === "string" && definitionReference.test(item)
              : onlyDefinitionReferences(item),
        );

/**
 * Place a server's output schema at `pointer` in a result schema. Its definitions move to the
 * result's root when every reference names one, so its references, and the named types an agent
 * reads, stay as the server wrote them. Otherwise references are rewritten to the new location.
 * One whose references cannot be resolved is kept as it is: it is still listed, and fails to
 * compile before a call.
 */
const placed = (
  structuredContent: JsonObject,
  pointer: string,
): { readonly schema: JsonObject; readonly root: JsonObject } => {
  if (onlyDefinitionReferences(structuredContent)) {
    const { $defs, definitions, $schema: _draft, ...schema } = structuredContent;
    return {
      schema,
      root: {
        ...($defs === undefined ? {} : { $defs }),
        ...(definitions === undefined ? {} : { definitions }),
      },
    };
  }
  try {
    return { schema: nestJsonSchema(structuredContent, pointer), root: {} };
  } catch {
    return { schema: structuredContent, root: {} };
  }
};

/**
 * The output schema of a call, which returns the whole `McpToolResult`. A server's own output
 * schema describes only `structuredContent`: a successful result must match it, and a remote
 * tool failure (`isError: true`) is not required to. Without one, any result object is described.
 */
const resultSchema = (structuredContent: JsonObject | undefined): JsonObject => {
  if (structuredContent === undefined)
    return { type: "object", properties: resultFields, required: ["content"] };
  const { schema, root } = placed(structuredContent, "#/anyOf/0/properties/structuredContent");
  return {
    // The envelope's keywords mean the same in every draft, so the server's draft applies.
    ...(structuredContent.$schema === undefined ? {} : { $schema: structuredContent.$schema }),
    ...root,
    anyOf: [
      {
        type: "object",
        properties: { ...resultFields, structuredContent: schema, isError: { const: false } },
        required: ["content", "structuredContent"],
      },
      {
        type: "object",
        properties: { ...resultFields, isError: { const: true } },
        required: ["content", "isError"],
      },
    ],
  };
};

/** Compile only the selected tool and bind its executable to the current invocation. */
export const adaptMcpTool = (client: McpClient, tool: McpToolMetadata) =>
  Effect.gen(function* () {
    const decoder = yield* jsonSchemaDecoder(tool.inputSchema).pipe(
      Effect.mapError(() => new McpError({ phase: "schema", reason: "invalid_response" })),
    );
    // One schema both describes and checks the result: the host decodes every call's
    // returned value with `output`, and catalogs render the same decoder's document.
    const output = preparedJsonSchemaDecoder(resultSchema(tool.outputSchema));
    const { outputSchema: _upstream, ...metadata } = tool;
    const adapted: McpTools[string] = {
      ...metadata,
      description: tool.description ?? tool.title ?? tool.name,
      input: decoder,
      output: output.decoder,
      ...(tool.annotations?.readOnlyHint === undefined
        ? {}
        : { readOnly: tool.annotations.readOnlyHint }),
      run: (context, input) =>
        Effect.gen(function* () {
          const arguments_ = yield* Schema.decodeUnknownEffect(decoder)(input).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(JsonObject)),
            Effect.mapError(() => new McpError({ phase: "call", reason: "invalid_input" })),
          );
          // Compile the output schema before sending a potentially mutating
          // call, so an unsupported schema cannot fail after its effects.
          yield* output.compile.pipe(
            Effect.mapError(() => new McpError({ phase: "schema", reason: "invalid_response" })),
          );
          const result = yield* client.call(tool, arguments_, context);
          if (result.isError === true) {
            (yield* ToolResultObservation).failed();
            yield* Effect.annotateCurrentSpan({
              "executor.outcome": "failed",
              "error.type": "McpToolError",
            });
          }
          return result;
        }),
    };
    return adapted;
  });

/** Discover a complete catalog for probes and uncached low-level callers. */
export const adaptMcpTools = (
  client: McpClient,
): Effect.Effect<McpTools, McpError | ProviderError | NetworkRefused> =>
  Effect.gen(function* () {
    const { tools: metadata } = yield* client.list;
    const entries = yield* Effect.forEach(metadata, (tool) =>
      adaptMcpTool(client, tool).pipe(Effect.map((adapted) => [tool.name, adapted] as const)),
    );
    return Object.fromEntries(entries);
  });
