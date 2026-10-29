import { Equal, Option, Schema } from "effect";
import { projectResponseFields, type HealthCheckCandidate } from "@executor-js/sdk/core";

import type { McpToolManifestEntry } from "./manifest";

/** A health probe runs unattended and repeatedly, so only a tool the server
 *  lists exactly once, declared read-only and not also destructive, may serve
 *  as one. */
export const findProbeTool = (
  tools: readonly McpToolManifestEntry[],
  name: string,
): McpToolManifestEntry | undefined => {
  const [tool, ...duplicates] = tools.filter((entry) => entry.toolName === name);
  return tool !== undefined &&
    duplicates.length === 0 &&
    tool.annotations?.readOnlyHint === true &&
    tool.annotations.destructiveHint !== true
    ? tool
    : undefined;
};

const InputSchema = Schema.Struct({
  properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  required: Schema.optional(Schema.Array(Schema.String)),
});
const decodeInputSchema = Schema.decodeUnknownOption(InputSchema);

const SchemaDefs = Schema.Struct({
  $defs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeSchemaDefs = Schema.decodeUnknownOption(SchemaDefs);

/** Project a tool into a candidate whose arguments are edited as one JSON
 *  object. A schema that requires an argument it never declares cannot be
 *  filled in, so that tool is not offered. */
const toCandidate = (tool: McpToolManifestEntry): HealthCheckCandidate[] => {
  const input = Option.getOrUndefined(decodeInputSchema(tool.inputSchema));
  if (input === undefined) return [];
  const properties = input.properties ?? {};
  const required = new Set(input.required ?? []);
  if ([...required].some((name) => !Object.hasOwn(properties, name))) return [];
  const defs = Option.getOrUndefined(decodeSchemaDefs(tool.outputSchema))?.$defs;
  return [
    {
      operation: tool.toolName,
      method: "mcp",
      destructive: false,
      explicitSelectionOnly: true,
      jsonArguments: true,
      requiredArgCount: required.size,
      ...(tool.description === null ? {} : { summary: tool.description }),
      parameters: Object.keys(properties).map((name) => ({
        name,
        location: "argument",
        required: required.has(name),
      })),
      responseFields: projectResponseFields(tool.outputSchema, defs),
    },
  ];
};

/**
 * The tools that can serve as the integration's health probe. One spec runs
 * against every connection, so a tool qualifies only when every catalog has
 * it as a probe tool with identical input and output schemas. An empty catalog
 * (including one that could not be read) therefore empties the result instead
 * of being skipped.
 */
export const compatibleHealthCandidates = (
  catalogs: readonly (readonly McpToolManifestEntry[])[],
): readonly HealthCheckCandidate[] => {
  const [first = [], ...rest] = catalogs;
  return first.flatMap((tool) =>
    findProbeTool(first, tool.toolName) === tool &&
    rest.every((catalog) => {
      const peer = findProbeTool(catalog, tool.toolName);
      return (
        peer !== undefined &&
        Equal.equals(peer.inputSchema, tool.inputSchema) &&
        Equal.equals(peer.outputSchema, tool.outputSchema)
      );
    })
      ? toCandidate(tool)
      : [],
  );
};
