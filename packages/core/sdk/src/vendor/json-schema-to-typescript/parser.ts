import type { JSONSchema4Type, JSONSchema4TypeName } from "./types/json-schema";
import { findKey, isPlainObject, memoize, omit } from "./compat";
import type { Options } from "./";
import { applySchemaTyping } from "./applySchemaTyping";
import type {
  AST,
  TInterface,
  TInterfaceParam,
  TIntersection,
  TNamedInterface,
  TTuple,
} from "./types/AST";
import {
  T_ANY,
  T_ANY_ADDITIONAL_PROPERTIES,
  T_UNKNOWN,
  T_UNKNOWN_ADDITIONAL_PROPERTIES,
} from "./types/AST";
import type {
  EnumJSONSchema,
  JSONSchemaWithDefinitions,
  LinkedJSONSchema,
  NormalizedJSONSchema,
  SchemaSchema,
  SchemaType,
} from "./types/JSONSchema";
import { Intersection, Types, getRootSchema, isBoolean, isPrimitive } from "./types/JSONSchema";
import { generateName, maybeStripDefault } from "./utils";

export type Processed = Map<NormalizedJSONSchema, Map<SchemaType, AST>>;

export type UsedNames = Set<string>;

export function parse(
  schema: NormalizedJSONSchema | JSONSchema4Type,
  options: Options,
  keyName?: string,
  processed: Processed = new Map(),
  usedNames = new Set<string>(),
): AST {
  if (isPrimitive(schema)) {
    if (isBoolean(schema)) {
      return parseBooleanSchema(schema, keyName, options);
    }

    return parseLiteral(schema, keyName);
  }

  const normalizedSchema = schema as NormalizedJSONSchema;
  const intersection = normalizedSchema[Intersection];
  const types = normalizedSchema[Types];

  if (intersection) {
    const ast = parseAsTypeWithCache(
      intersection,
      "ALL_OF",
      options,
      keyName,
      processed,
      usedNames,
    ) as TIntersection;

    types.forEach((type) => {
      ast.params.push(
        parseAsTypeWithCache(normalizedSchema, type, options, keyName, processed, usedNames),
      );
    });

    return ast;
  }

  if (types.size === 1) {
    const type = [...types][0];
    const ast = parseAsTypeWithCache(
      normalizedSchema,
      type,
      options,
      keyName,
      processed,
      usedNames,
    );
    return ast;
  }

  throw new ReferenceError("Expected intersection schema. Please file an issue on GitHub.");
}

function parseAsTypeWithCache(
  schema: NormalizedJSONSchema,
  type: SchemaType,
  options: Options,
  keyName?: string,
  processed: Processed = new Map(),
  usedNames = new Set<string>(),
): AST {
  // If we've seen this node before, return it.
  let cachedTypeMap = processed.get(schema);
  if (!cachedTypeMap) {
    cachedTypeMap = new Map();
    processed.set(schema, cachedTypeMap);
  }
  const cachedAST = cachedTypeMap.get(type);
  if (cachedAST) {
    return cachedAST;
  }

  // Cache processed ASTs before they are actually computed, then update
  // them in place using set(). This is to avoid cycles.
  // TODO: Investigate alternative approaches (lazy-computing nodes, etc.)
  const ast = {} as AST;
  cachedTypeMap.set(type, ast);

  // Update the AST in place. This updates the `processed` cache, as well
  // as any nodes that directly reference the node.
  return Object.assign(ast, parseNonLiteral(schema, type, options, keyName, processed, usedNames));
}

function parseBooleanSchema(schema: boolean, keyName: string | undefined, options: Options): AST {
  if (schema) {
    return {
      keyName,
      type: options.unknownAny ? "UNKNOWN" : "ANY",
    };
  }

  return {
    keyName,
    type: "NEVER",
  };
}

function parseLiteral(schema: JSONSchema4Type, keyName: string | undefined): AST {
  return {
    keyName,
    params: schema,
    type: "LITERAL",
  };
}

function parseNonLiteral(
  schema: NormalizedJSONSchema,
  type: SchemaType,
  options: Options,
  keyName: string | undefined,
  processed: Processed,
  usedNames: UsedNames,
): AST {
  const definitions = getDefinitionsMemoized(getRootSchema(schema as any)); // TODO
  const keyNameFromDefinition = findKey(definitions, (_) => _ === schema);

  switch (type) {
    case "ALL_OF":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        params: schema.allOf!.map((_) => parse(_, options, undefined, processed, usedNames)),
        type: "INTERSECTION",
      };
    case "ANY":
      return {
        ...(options.unknownAny ? T_UNKNOWN : T_ANY),
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
      };
    case "ANY_OF":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        params: schema.anyOf!.map((_) => parse(_, options, undefined, processed, usedNames)),
        type: "UNION",
      };
    case "BOOLEAN":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: "BOOLEAN",
      };
    case "CUSTOM_TYPE":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        params: schema.tsType!,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: "CUSTOM_TYPE",
      };
    case "NAMED_ENUM":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(
          schema,
          keyNameFromDefinition ?? keyName,
          usedNames,
          options,
        )!,
        params: (schema as EnumJSONSchema).enum!.map((_, n) => ({
          ast: parseLiteral(_, undefined),
          keyName: schema.tsEnumNames![n],
        })),
        type: "ENUM",
      };
    case "NAMED_SCHEMA":
      return newInterface(schema as SchemaSchema, options, processed, usedNames, keyName);
    case "NEVER":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: "NEVER",
      };
    case "NULL":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: "NULL",
      };
    case "NUMBER":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: "NUMBER",
      };
    case "OBJECT":
      return {
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: "OBJECT",
        deprecated: schema.deprecated,
      };
    case "ONE_OF":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        params: schema.oneOf!.map((_) => parse(_, options, undefined, processed, usedNames)),
        type: "UNION",
      };
    case "REFERENCE":
      throw Error("Refs should have been resolved by the resolver.");
    case "STRING":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: "STRING",
      };
    case "TYPED_ARRAY":
      if (Array.isArray(schema.items)) {
        // normalised to not be undefined
        const minItems = schema.minItems!;
        const maxItems = schema.maxItems!;
        const arrayType: TTuple = {
          comment: schema.description,
          deprecated: schema.deprecated,
          keyName,
          maxItems,
          minItems,
          standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
          params: schema.items.map((_) => parse(_, options, undefined, processed, usedNames)),
          type: "TUPLE",
        };
        if (schema.additionalItems === true) {
          arrayType.spreadParam = options.unknownAny ? T_UNKNOWN : T_ANY;
        } else if (schema.additionalItems) {
          arrayType.spreadParam = parse(
            schema.additionalItems,
            options,
            undefined,
            processed,
            usedNames,
          );
        }
        return arrayType;
      } else {
        return {
          comment: schema.description,
          deprecated: schema.deprecated,
          keyName,
          standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
          params: parse(
            schema.items!,
            options,
            `{keyNameFromDefinition}Items`,
            processed,
            usedNames,
          ),
          type: "ARRAY",
        };
      }
    case "UNION":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        params: (schema.type as JSONSchema4TypeName[]).map((type) => {
          const member: LinkedJSONSchema = { ...omit(schema, "$id", "description", "title"), type };
          maybeStripDefault(member);
          applySchemaTyping(member);
          return parse(member, options, undefined, processed, usedNames);
        }),
        type: "UNION",
      };
    case "UNNAMED_ENUM":
      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        params: (schema as EnumJSONSchema).enum!.map((_) => parseLiteral(_, undefined)),
        type: "UNION",
      };
    case "UNNAMED_SCHEMA":
      return newInterface(
        schema as SchemaSchema,
        options,
        processed,
        usedNames,
        keyName,
        keyNameFromDefinition,
      );
    case "UNTYPED_ARRAY":
      // normalised to not be undefined
      const minItems = schema.minItems!;
      const maxItems = typeof schema.maxItems === "number" ? schema.maxItems : -1;
      const params = options.unknownAny ? T_UNKNOWN : T_ANY;
      if (minItems > 0 || maxItems >= 0) {
        return {
          comment: schema.description,
          deprecated: schema.deprecated,
          keyName,
          maxItems: schema.maxItems,
          minItems,
          // create a tuple of length N
          params: Array(Math.max(maxItems, minItems) || 0).fill(params),
          // if there is no maximum, then add a spread item to collect the rest
          spreadParam: maxItems >= 0 ? undefined : params,
          standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
          type: "TUPLE",
        };
      }

      return {
        comment: schema.description,
        deprecated: schema.deprecated,
        keyName,
        params,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames, options),
        type: "ARRAY",
      };
  }
}

/**
 * Compute a schema name using a series of fallbacks
 */
function standaloneName(
  schema: NormalizedJSONSchema,
  keyNameFromDefinition: string | undefined,
  usedNames: UsedNames,
  options: Options,
): string | undefined {
  const name =
    options.customName?.(schema, keyNameFromDefinition) ||
    schema.title ||
    schema.$id ||
    keyNameFromDefinition;
  if (name) {
    return generateName(name, usedNames);
  }
}

function newInterface(
  schema: SchemaSchema,
  options: Options,
  processed: Processed,
  usedNames: UsedNames,
  keyName?: string,
  keyNameFromDefinition?: string,
): TInterface {
  const name = standaloneName(schema, keyNameFromDefinition, usedNames, options)!;
  return {
    comment: schema.description,
    deprecated: schema.deprecated,
    keyName,
    params: parseSchema(schema, options, processed, usedNames, name),
    standaloneName: name,
    superTypes: parseSuperTypes(schema, options, processed, usedNames),
    type: "INTERFACE",
  };
}

function parseSuperTypes(
  schema: SchemaSchema,
  options: Options,
  processed: Processed,
  usedNames: UsedNames,
): TNamedInterface[] {
  // Type assertion needed because of dereferencing step
  // TODO: Type it upstream
  const superTypes = schema.extends as SchemaSchema[] | undefined;
  if (!superTypes) {
    return [];
  }
  return superTypes.map(
    (_) => parse(_, options, undefined, processed, usedNames) as TNamedInterface,
  );
}

/**
 * Helper to parse schema properties into params on the parent schema's type
 */
function parseSchema(
  schema: SchemaSchema,
  options: Options,
  processed: Processed,
  usedNames: UsedNames,
  parentSchemaName: string,
): TInterfaceParam[] {
  const required = new Set(schema.required ?? []);
  let asts: TInterfaceParam[] = Object.entries(schema.properties ?? {}).map(([key, value]) => ({
    ast: parse(value, options, key, processed, usedNames),
    isPatternProperty: false,
    isRequired: required.has(key),
    isUnreachableDefinition: false,
    keyName: key,
  }));

  let singlePatternProperty = false;
  if (schema.patternProperties) {
    // partially support patternProperties. in the case that
    // additionalProperties is not set, and there is only a single
    // value definition, we can validate against that.
    singlePatternProperty =
      !schema.additionalProperties && Object.keys(schema.patternProperties).length === 1;

    asts = asts.concat(
      Object.entries(schema.patternProperties).map(([key, value]) => {
        const ast = parse(value, options, key, processed, usedNames);
        const comment = `This interface was referenced by \`${parentSchemaName}\`'s JSON-Schema definition
via the \`patternProperty\` "${key.replace("*/", "*\\/")}".`;
        ast.comment = ast.comment ? `${ast.comment}\n\n${comment}` : comment;
        return {
          ast,
          isPatternProperty: !singlePatternProperty,
          isRequired: singlePatternProperty || required.has(key),
          isUnreachableDefinition: false,
          keyName: singlePatternProperty ? "[k: string]" : key,
        };
      }),
    );
  }

  if (options.unreachableDefinitions) {
    asts = asts.concat(
      Object.entries(schema.$defs ?? {}).map(([key, value]) => {
        const ast = parse(value, options, key, processed, usedNames);
        const comment = `This interface was referenced by \`${parentSchemaName}\`'s JSON-Schema
via the \`definition\` "${key}".`;
        ast.comment = ast.comment ? `${ast.comment}\n\n${comment}` : comment;
        return {
          ast,
          isPatternProperty: false,
          isRequired: required.has(key),
          isUnreachableDefinition: true,
          keyName: key,
        };
      }),
    );
  }

  // handle additionalProperties
  switch (schema.additionalProperties) {
    case undefined:
    case true:
      if (singlePatternProperty) {
        return asts;
      }
      return asts.concat({
        ast: options.unknownAny ? T_UNKNOWN_ADDITIONAL_PROPERTIES : T_ANY_ADDITIONAL_PROPERTIES,
        isPatternProperty: false,
        isRequired: true,
        isUnreachableDefinition: false,
        keyName: "[k: string]",
      });

    case false:
      return asts;

    // pass "true" as the last param because in TS, properties
    // defined via index signatures are already optional
    default:
      return asts.concat({
        ast: parse(schema.additionalProperties, options, "[k: string]", processed, usedNames),
        isPatternProperty: false,
        isRequired: true,
        isUnreachableDefinition: false,
        keyName: "[k: string]",
      });
  }
}

type Definitions = { [k: string]: NormalizedJSONSchema };

function getDefinitions(
  schema: NormalizedJSONSchema,
  isSchema = true,
  processed = new Set<NormalizedJSONSchema>(),
): Definitions {
  if (processed.has(schema)) {
    return {};
  }
  processed.add(schema);
  if (Array.isArray(schema)) {
    return schema.reduce(
      (prev, cur) => ({
        ...prev,
        ...getDefinitions(cur, false, processed),
      }),
      {},
    );
  }
  if (isPlainObject(schema)) {
    return {
      ...(isSchema && hasDefinitions(schema) ? schema.$defs : {}),
      ...Object.keys(schema).reduce<Definitions>(
        (prev, cur) => ({
          ...prev,
          ...getDefinitions(schema[cur], false, processed),
        }),
        {},
      ),
    };
  }
  return {};
}

const getDefinitionsMemoized = memoize(getDefinitions);

/**
 * TODO: Reduce rate of false positives
 */
function hasDefinitions(schema: NormalizedJSONSchema): schema is JSONSchemaWithDefinitions {
  return "$defs" in schema;
}
