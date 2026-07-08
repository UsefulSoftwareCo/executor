import { Schema, SchemaAST } from "effect";
import type { JsonSchema } from "effect/JsonSchema";
import type { LiveCatalog, SerializedCatalog } from "./registry";

function getSchemaIdentifier(schema: { ast: SchemaAST.AST }): string | undefined {
  return SchemaAST.resolveIdentifier(schema.ast);
}

export function serialize(catalog: LiveCatalog): typeof SerializedCatalog.Type {
  const defs: Record<string, JsonSchema> = {};

  function schemaToRef(schema: Schema.Top | undefined): string | undefined {
    if (!schema) return undefined;

    const identifier = getSchemaIdentifier(schema);
    const document = Schema.toJsonSchemaDocument(schema);
    Object.assign(defs, document.definitions);

    if (identifier) {
      return identifier;
    }

    // Inline schema without an identifier — store under a generated key
    const key = `__inline_${Object.keys(defs).length}`;
    defs[key] = document.schema;
    return key;
  }

  const tools = catalog.tools.map((tool) => ({
    path: tool.path,
    description: tool.description,
    integrationId: tool.integrationId,
    input: schemaToRef(tool.input),
    output: schemaToRef(tool.output),
    error: schemaToRef(tool.error),
  }));

  return {
    version: "v4.1" as const,
    types: defs as Record<string, unknown>,
    tools,
  };
}

export function deserializeToJsonSchema(serialized: typeof SerializedCatalog.Type): {
  tools: ReadonlyArray<{
    path: string;
    description?: string;
    tags?: ReadonlyArray<string>;
    namespace?: string;
    input?: JsonSchema;
    output?: JsonSchema;
    error?: JsonSchema;
  }>;
  types: Record<string, unknown>;
} {
  const types = serialized.types;

  function resolveRef(ref: string | undefined): JsonSchema | undefined {
    if (!ref) return undefined;
    const schema = types[ref];
    if (!schema) return undefined;
    return {
      ...(schema as JsonSchema),
      $defs: types as Record<string, JsonSchema>,
    };
  }

  return {
    tools: serialized.tools.map((tool) => ({
      path: tool.path,
      description: tool.description,
      integrationId: tool.integrationId,
      input: resolveRef(tool.input),
      output: resolveRef(tool.output),
      error: resolveRef(tool.error),
    })),
    types,
  };
}
