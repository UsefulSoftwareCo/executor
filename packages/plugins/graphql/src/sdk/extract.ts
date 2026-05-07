import { Effect, Match, Option } from "effect";

import { GraphqlExtractionError } from "./errors";
import type {
  IntrospectionResult,
  IntrospectionSchema,
  IntrospectionType,
  IntrospectionTypeRef,
  IntrospectionInputValue,
} from "./introspect";
import {
  ExtractedField,
  ExtractionResult,
  GraphqlArgument,
  type GraphqlOperationKind,
} from "./types";

// ---------------------------------------------------------------------------
// Type ref helpers
// ---------------------------------------------------------------------------

/** Unwrap NON_NULL / LIST wrappers to get the leaf type name */
const unwrapTypeName = (ref: IntrospectionTypeRef): string => {
  if (ref.name) return ref.name;
  if (ref.ofType) return unwrapTypeName(ref.ofType);
  return "Unknown";
};

/** Check if a type ref is non-null (required) */
const isNonNull = (ref: IntrospectionTypeRef): boolean => ref.kind === "NON_NULL";

// ---------------------------------------------------------------------------
// Build shared definitions from all INPUT_OBJECT and ENUM types
// ---------------------------------------------------------------------------

const buildDefinitions = (
  types: ReadonlyMap<string, IntrospectionType>,
): Record<string, unknown> => {
  const defs: Record<string, unknown> = {};

  for (const [name, type] of types) {
    // Skip internal types
    if (name.startsWith("__")) continue;

    if (type.kind === "INPUT_OBJECT" && type.inputFields) {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const field of type.inputFields) {
        const schema = typeRefToJsonSchema(field.type, types);
        if (field.description) {
          (schema as Record<string, unknown>).description = field.description;
        }
        properties[field.name] = schema;
        if (isNonNull(field.type)) {
          required.push(field.name);
        }
      }

      const def: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) def.required = required;
      if (type.description) def.description = type.description;
      defs[name] = def;
    }

    if (type.kind === "ENUM" && type.enumValues) {
      defs[name] = {
        type: "string",
        enum: type.enumValues.map((v) => v.name),
        ...(type.description ? { description: type.description } : {}),
      };
    }
  }

  return defs;
};

// ---------------------------------------------------------------------------
// Convert a type ref to JSON Schema using $ref for complex types
// ---------------------------------------------------------------------------

const typeRefToJsonSchema = (
  ref: IntrospectionTypeRef,
  // oxlint-disable-next-line only-used-in-recursion
  types: ReadonlyMap<string, IntrospectionType>,
): Record<string, unknown> =>
  Match.value(ref.kind).pipe(
    Match.when(
      "NON_NULL",
      (): Record<string, unknown> => (ref.ofType ? typeRefToJsonSchema(ref.ofType, types) : {}),
    ),
    Match.when(
      "LIST",
      (): Record<string, unknown> => ({
        type: "array",
        items: ref.ofType ? typeRefToJsonSchema(ref.ofType, types) : {},
      }),
    ),
    Match.when("SCALAR", (): Record<string, unknown> => scalarToJsonSchema(ref.name ?? "String")),
    Match.when(
      "ENUM",
      (): Record<string, unknown> =>
        ref.name ? { $ref: `#/$defs/${ref.name}` } : { type: "string" },
    ),
    Match.when(
      "INPUT_OBJECT",
      (): Record<string, unknown> =>
        ref.name ? { $ref: `#/$defs/${ref.name}` } : { type: "object" },
    ),
    Match.whenOr(
      "OBJECT",
      "INTERFACE",
      "UNION",
      (): Record<string, unknown> => ({ type: "object" }),
    ),
    Match.option,
    Option.getOrElse((): Record<string, unknown> => ({})),
  );

const scalarToJsonSchema = (name: string): Record<string, unknown> =>
  Match.value(name).pipe(
    Match.whenOr("String", "ID", (): Record<string, unknown> => ({ type: "string" })),
    Match.when("Int", (): Record<string, unknown> => ({ type: "integer" })),
    Match.when("Float", (): Record<string, unknown> => ({ type: "number" })),
    Match.when("Boolean", (): Record<string, unknown> => ({ type: "boolean" })),
    Match.option,
    Option.getOrElse(
      (): Record<string, unknown> => ({ type: "string", description: `Custom scalar: ${name}` }),
    ),
  );

// ---------------------------------------------------------------------------
// Build input JSON Schema from field arguments
// ---------------------------------------------------------------------------

const buildInputSchema = (
  args: readonly IntrospectionInputValue[],
  types: ReadonlyMap<string, IntrospectionType>,
): Record<string, unknown> | undefined => {
  if (args.length === 0) return undefined;

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const arg of args) {
    const schema = typeRefToJsonSchema(arg.type, types);
    if (arg.description) {
      (schema as Record<string, unknown>).description = arg.description;
    }
    properties[arg.name] = schema;
    if (isNonNull(arg.type)) {
      required.push(arg.name);
    }
  }

  const inputSchema: Record<string, unknown> = {
    type: "object",
    properties,
  };
  if (required.length > 0) inputSchema.required = required;
  return inputSchema;
};

/** Format a type ref back to GraphQL type notation (e.g. "[String!]!") */
const formatTypeRef = (ref: IntrospectionTypeRef): string =>
  Match.value(ref.kind).pipe(
    Match.when("NON_NULL", () => (ref.ofType ? `${formatTypeRef(ref.ofType)}!` : "Unknown!")),
    Match.when("LIST", () => (ref.ofType ? `[${formatTypeRef(ref.ofType)}]` : "[Unknown]")),
    Match.option,
    Option.getOrElse(() => ref.name ?? "Unknown"),
  );

// ---------------------------------------------------------------------------
// Extract fields from schema
// ---------------------------------------------------------------------------

const extractFields = (
  _schema: IntrospectionSchema,
  kind: GraphqlOperationKind,
  typeName: string | null | undefined,
  types: ReadonlyMap<string, IntrospectionType>,
): ExtractedField[] => {
  if (!typeName) return [];

  const type = types.get(typeName);
  if (!type?.fields) return [];

  return type.fields
    .filter((f) => !f.name.startsWith("__"))
    .map((field) => {
      const args = field.args.map(
        (arg) =>
          new GraphqlArgument({
            name: arg.name,
            typeName: formatTypeRef(arg.type),
            required: isNonNull(arg.type),
            description: arg.description ? Option.some(arg.description) : Option.none(),
          }),
      );

      const inputSchema = buildInputSchema(field.args, types);

      return new ExtractedField({
        fieldName: field.name,
        kind,
        description: field.description ? Option.some(field.description) : Option.none(),
        arguments: args,
        inputSchema: inputSchema ? Option.some(inputSchema) : Option.none(),
        returnTypeName: unwrapTypeName(field.type),
      });
    });
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExtractionOutput {
  readonly result: ExtractionResult;
  /** Shared JSON Schema definitions for INPUT_OBJECT and ENUM types.
   *  Tool input schemas use `$ref` pointers into these. */
  readonly definitions: Record<string, unknown>;
}

export const extract = (
  introspection: IntrospectionResult,
): Effect.Effect<ExtractionOutput, GraphqlExtractionError> =>
  Effect.try({
    try: () => {
      const schema = introspection.__schema;
      const typeMap = new Map<string, IntrospectionType>();
      for (const t of schema.types) {
        typeMap.set(t.name, t);
      }

      const definitions = buildDefinitions(typeMap);

      const queryFields = extractFields(schema, "query", schema.queryType?.name, typeMap);
      const mutationFields = extractFields(schema, "mutation", schema.mutationType?.name, typeMap);

      return {
        result: new ExtractionResult({
          schemaName: Option.none(),
          fields: [...queryFields, ...mutationFields],
        }),
        definitions,
      };
    },
    catch: () =>
      new GraphqlExtractionError({
        message: "Failed to extract GraphQL schema",
      }),
  });
