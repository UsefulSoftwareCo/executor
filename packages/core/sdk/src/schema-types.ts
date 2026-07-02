import { hoistDefinitions, normalizeRefs } from "./schema-refs";
import { compile } from "./vendor/json-schema-to-typescript";

type JsonSchemaRecord = Record<string, unknown>;
type CompilerJsonSchema = JsonSchemaRecord | boolean;
type CompilerFormatOptions = {
  [key: string]: unknown;
  printWidth?: number;
  semi?: boolean;
  singleQuote?: boolean;
  trailingComma?: "none" | "es5" | "all";
};
type SchemaCompilerOptions = {
  [key: string]: unknown;
  additionalProperties?: boolean;
  bannerComment?: string;
  enableConstEnums?: boolean;
  format?: boolean;
  style?: CompilerFormatOptions;
  unknownAny?: boolean;
  unreachableDefinitions?: boolean;
};

export type TypeScriptRenderOptions = {
  compilerOptions?: Partial<SchemaCompilerOptions>;
};

export type TypeScriptSchemaPreview = {
  readonly type: string;
  readonly definitions: Record<string, string>;
};

const ROOT_WRAPPER_NAME = "SchemaPreview";
const ROOT_PROPERTY_NAME = "__root";
const TOOL_INPUT_PROPERTY_NAME = "__input";
const TOOL_OUTPUT_PROPERTY_NAME = "__output";

const DEFAULT_COMPILER_OPTIONS = {
  additionalProperties: false,
  bannerComment: "",
  enableConstEnums: false,
  format: false,
  unknownAny: true,
  unreachableDefinitions: false,
  style: {
    printWidth: 120,
    semi: true,
    singleQuote: false,
    trailingComma: "none",
  },
} satisfies Partial<SchemaCompilerOptions>;

const DEFINITION_REF_PATTERN = /^#\/definitions\/(.+)$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const asRecord = (value: unknown): JsonSchemaRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonSchemaRecord)
    : {};

const asCompilerSchema = (value: unknown): CompilerJsonSchema => {
  if (typeof value === "boolean") {
    return value;
  }

  if (value !== null && typeof value === "object") {
    return value as JsonSchemaRecord;
  }

  return {};
};

const isNullSchema = (value: unknown): boolean => {
  if (value === false) {
    return false;
  }

  const schema = asRecord(value);
  return schema.type === "null" || schema.const === null;
};

const appendNullSchema = (schemas: ReadonlyArray<unknown>): Array<unknown> =>
  schemas.some(isNullSchema) ? [...schemas] : [...schemas, { type: "null" }];

const schemaAlreadyAllowsNull = (schema: JsonSchemaRecord): boolean => {
  if (schema.type === "null" || schema.const === null) {
    return true;
  }

  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    return true;
  }

  if (Array.isArray(schema.enum) && schema.enum.includes(null)) {
    return true;
  }

  const compositeSchemas = [
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
  ];
  return compositeSchemas.some(isNullSchema);
};

const normalizeNullable = (schema: JsonSchemaRecord): JsonSchemaRecord => {
  if (schema.nullable !== true) {
    return schema;
  }

  const { nullable: _nullable, ...base } = schema;
  if (schemaAlreadyAllowsNull(base)) {
    return base;
  }

  if ("const" in base) {
    const { const: constValue, type: _type, ...rest } = base;
    return { ...rest, enum: [constValue, null] };
  }

  if (Array.isArray(base.enum)) {
    return { ...base, enum: [...base.enum, null] };
  }

  if (typeof base.type === "string") {
    return { ...base, type: [base.type, "null"] };
  }

  if (Array.isArray(base.type)) {
    const types = base.type.filter((value): value is string => typeof value === "string");
    return types.length > 0
      ? { ...base, type: [...types, "null"] }
      : { anyOf: [base, { type: "null" }] };
  }

  if (Array.isArray(base.oneOf)) {
    return { ...base, oneOf: appendNullSchema(base.oneOf) };
  }

  if (Array.isArray(base.anyOf)) {
    return { ...base, anyOf: appendNullSchema(base.anyOf) };
  }

  return { anyOf: [base, { type: "null" }] };
};

const normalizeSchema = (node: unknown): unknown => {
  if (node === null || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((item) => normalizeSchema(item));
  }

  const schema = node as JsonSchemaRecord;
  const normalized: JsonSchemaRecord = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref" && typeof value === "string") {
      const definitionName = value.match(DEFINITION_REF_PATTERN)?.[1];
      normalized[key] = definitionName ? `#/$defs/${definitionName}` : value;
      continue;
    }

    normalized[key] = normalizeSchema(value);
  }

  const nullable = normalizeNullable(normalized);
  if (
    nullable.type === "object" &&
    nullable.properties === undefined &&
    nullable.additionalProperties === undefined
  ) {
    return { ...nullable, additionalProperties: {} };
  }
  return nullable;
};

const mergeDefinitions = (
  externalDefs: ReadonlyMap<string, unknown>,
  localDefs: Record<string, unknown>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = {};

  for (const [name, schema] of externalDefs) {
    merged[name] = normalizeSchema(normalizeRefs(asCompilerSchema(schema)));
  }

  for (const [name, schema] of Object.entries(localDefs)) {
    merged[name] = normalizeSchema(normalizeRefs(asCompilerSchema(schema)));
  }

  return merged;
};

const buildWrappedObjectSchema = (
  properties: ReadonlyArray<readonly [string, unknown]>,
  defs: ReadonlyMap<string, unknown>,
): JsonSchemaRecord => {
  const normalizedProperties: Record<string, unknown> = {};
  const localDefs: Record<string, unknown> = {};

  for (const [name, schema] of properties) {
    const normalizedSchema = normalizeSchema(normalizeRefs(asCompilerSchema(schema)));
    const { stripped, defs: schemaDefs } = hoistDefinitions(normalizedSchema);
    normalizedProperties[name] = asCompilerSchema(stripped);
    Object.assign(localDefs, schemaDefs);
  }

  const mergedDefs = mergeDefinitions(defs, localDefs);
  const wrappedSchema: JsonSchemaRecord = {
    type: "object",
    properties: normalizedProperties,
    required: properties.map(([name]) => name),
    additionalProperties: false,
  };

  if (Object.keys(mergedDefs).length > 0) {
    wrappedSchema.$defs = mergedDefs;
  }

  return wrappedSchema;
};

const buildWrappedSchema = (
  schema: unknown,
  defs: ReadonlyMap<string, unknown>,
): JsonSchemaRecord => buildWrappedObjectSchema([[ROOT_PROPERTY_NAME, schema]], defs);

const compilerOptionsFrom = (options: TypeScriptRenderOptions): Partial<SchemaCompilerOptions> => ({
  ...DEFAULT_COMPILER_OPTIONS,
  ...options.compilerOptions,
  bannerComment: "",
  format: false,
  style: {
    ...DEFAULT_COMPILER_OPTIONS.style,
    ...options.compilerOptions?.style,
  },
});

type GeneratedDeclaration = {
  readonly kind: "interface" | "type";
  readonly name: string;
  readonly body: string;
};

type ScanState = {
  quote: '"' | "'" | "`" | null;
  escaping: boolean;
  lineComment: boolean;
  blockComment: boolean;
};

const emptyScanState = (): ScanState => ({
  quote: null,
  escaping: false,
  lineComment: false,
  blockComment: false,
});

const stepScanState = (state: ScanState, current: string, next: string): { skipNext: boolean } => {
  if (state.lineComment) {
    if (current === "\n" || current === "\r") {
      state.lineComment = false;
    }
    return { skipNext: false };
  }

  if (state.blockComment) {
    if (current === "*" && next === "/") {
      state.blockComment = false;
      return { skipNext: true };
    }
    return { skipNext: false };
  }

  if (state.quote) {
    if (state.escaping) {
      state.escaping = false;
      return { skipNext: false };
    }

    if (current === "\\") {
      state.escaping = true;
      return { skipNext: false };
    }

    if (current === state.quote) {
      state.quote = null;
    }
    return { skipNext: false };
  }

  if (current === "/" && next === "/") {
    state.lineComment = true;
    return { skipNext: true };
  }

  if (current === "/" && next === "*") {
    state.blockComment = true;
    return { skipNext: true };
  }

  if (current === '"' || current === "'" || current === "`") {
    state.quote = current;
  }

  return { skipNext: false };
};

const findMatchingBrace = (source: string, start: number): number => {
  const state = emptyScanState();
  let depth = 0;

  for (let index = start; index < source.length; index += 1) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    const wasCode = !state.quote && !state.lineComment && !state.blockComment;
    const { skipNext } = stepScanState(state, current, next);

    if (wasCode && !state.quote && !state.lineComment && !state.blockComment) {
      if (current === "{") {
        depth += 1;
      } else if (current === "}") {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
      }
    }

    if (skipNext) {
      index += 1;
    }
  }

  return -1;
};

const findMatchingParen = (source: string, start: number): number => {
  const state = emptyScanState();
  let depth = 0;

  for (let index = start; index < source.length; index += 1) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    const wasCode = !state.quote && !state.lineComment && !state.blockComment;
    const { skipNext } = stepScanState(state, current, next);

    if (wasCode && !state.quote && !state.lineComment && !state.blockComment) {
      if (current === "(") {
        depth += 1;
      } else if (current === ")") {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
      }
    }

    if (skipNext) {
      index += 1;
    }
  }

  return -1;
};

const findTypeAliasEnd = (source: string, start: number): number => {
  const state = emptyScanState();
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let seenToken = false;

  for (let index = start; index < source.length; index += 1) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    const wasCode = !state.quote && !state.lineComment && !state.blockComment;
    const { skipNext } = stepScanState(state, current, next);

    if (wasCode && !state.quote && !state.lineComment && !state.blockComment) {
      if (current === "{") {
        braceDepth += 1;
      } else if (current === "}") {
        braceDepth = Math.max(0, braceDepth - 1);
      } else if (current === "[") {
        bracketDepth += 1;
      } else if (current === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
      } else if (current === "(") {
        parenDepth += 1;
      } else if (current === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
      }

      if (!/\s/.test(current)) {
        seenToken = true;
      }

      if (
        seenToken &&
        (current === ";" || current === "\n" || current === "\r") &&
        braceDepth === 0 &&
        bracketDepth === 0 &&
        parenDepth === 0
      ) {
        return index;
      }
    }

    if (skipNext) {
      index += 1;
    }
  }

  return -1;
};

const parseGeneratedDeclarations = (source: string): Array<GeneratedDeclaration> => {
  const declarations: Array<GeneratedDeclaration> = [];
  const pattern = /export\s+(interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const kind = match[1] as "interface" | "type";
    const name = match[2] ?? "";

    if (!IDENTIFIER_PATTERN.test(name)) {
      continue;
    }

    if (kind === "interface") {
      const braceStart = source.indexOf("{", pattern.lastIndex);
      if (braceStart < 0) {
        continue;
      }

      const braceEnd = findMatchingBrace(source, braceStart);
      if (braceEnd < 0) {
        continue;
      }

      declarations.push({
        kind,
        name,
        body: source.slice(braceStart, braceEnd + 1),
      });
      pattern.lastIndex = braceEnd + 1;
      continue;
    }

    const equalsIndex = source.indexOf("=", pattern.lastIndex);
    if (equalsIndex < 0) {
      continue;
    }

    const end = findTypeAliasEnd(source, equalsIndex + 1);
    if (end < 0) {
      continue;
    }

    declarations.push({
      kind,
      name,
      body: source.slice(equalsIndex + 1, end).trim(),
    });
    pattern.lastIndex = end + 1;
  }

  return declarations;
};

const extractPropertyType = (interfaceBody: string, propertyName: string): string | null => {
  const propertyIndex = interfaceBody.indexOf(propertyName);
  if (propertyIndex < 0) {
    return null;
  }

  const colonIndex = interfaceBody.indexOf(":", propertyIndex + propertyName.length);
  if (colonIndex < 0) {
    return null;
  }

  const end = findTypeAliasEnd(interfaceBody, colonIndex + 1);
  if (end < 0) {
    return null;
  }

  return interfaceBody.slice(colonIndex + 1, end).trim();
};

const containsTopLevelUnion = (source: string): boolean => {
  const state = emptyScanState();
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    const wasCode = !state.quote && !state.lineComment && !state.blockComment;
    const { skipNext } = stepScanState(state, current, next);

    if (wasCode && !state.quote && !state.lineComment && !state.blockComment) {
      if (current === "{") {
        braceDepth += 1;
      } else if (current === "}") {
        braceDepth = Math.max(0, braceDepth - 1);
      } else if (current === "[") {
        bracketDepth += 1;
      } else if (current === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
      } else if (current === "(") {
        parenDepth += 1;
      } else if (current === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
      } else if (current === "|" && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
        return true;
      }
    }

    if (skipNext) {
      index += 1;
    }
  }

  return false;
};

const significantBefore = (source: string, start: number): string => {
  for (let index = start; index >= 0; index -= 1) {
    const char = source[index] ?? "";
    if (!/\s/.test(char)) {
      return char;
    }
  }
  return "";
};

const significantAfter = (source: string, start: number): string => {
  for (let index = start; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (!/\s/.test(char)) {
      return char;
    }
  }
  return "";
};

const stripRedundantUnionParens = (source: string): string => {
  let output = "";

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index] ?? "";
    if (current !== "(") {
      output += current;
      continue;
    }

    const end = findMatchingParen(source, index);
    if (end < 0) {
      output += current;
      continue;
    }

    const previous = significantBefore(source, index - 1);
    const next = significantAfter(source, end + 1);
    const inner = source.slice(index + 1, end);
    const keepParens =
      !containsTopLevelUnion(inner) ||
      /[A-Za-z0-9_$]/.test(previous) ||
      next === "[" ||
      next === "." ||
      next === "<";

    if (keepParens) {
      output += source.slice(index, end + 1);
    } else {
      output += stripRedundantUnionParens(inner);
    }
    index = end;
  }

  return output;
};

const compactTypeScript = (value: string): string => {
  const state = emptyScanState();
  let output = "";
  let pendingWhitespace = false;
  let braceDepth = 0;

  const emitWhitespace = () => {
    if (output.length > 0) {
      pendingWhitespace = true;
    }
  };

  const previousSignificant = (): string => output.trimEnd().at(-1) ?? "";

  const nextSignificant = (start: number): string => {
    for (let index = start; index < value.length; index += 1) {
      const char = value[index] ?? "";
      if (!/\s/.test(char)) {
        return char;
      }
    }
    return "";
  };

  const terminateMemberAtNewline = (index: number): void => {
    if (braceDepth <= 0) {
      return;
    }

    const previous = previousSignificant();
    if (!previous || previous === "{" || previous === ";" || previous === "|" || previous === "&") {
      return;
    }

    const next = nextSignificant(index + 1);
    if (!next || next === "|" || next === "&" || next === ")" || next === "]" || next === ",") {
      return;
    }

    output = output.trimEnd() + ";";
    pendingWhitespace = true;
  };

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index] ?? "";
    const next = value[index + 1] ?? "";

    if (!state.quote && !state.lineComment && !state.blockComment) {
      if (current === "/" && next === "/") {
        emitWhitespace();
        index += 1;
        state.lineComment = true;
        continue;
      }

      if (current === "/" && next === "*") {
        emitWhitespace();
        index += 1;
        state.blockComment = true;
        continue;
      }

      if (/\s/.test(current)) {
        if (current === "\n" || current === "\r") {
          terminateMemberAtNewline(index);
        }
        emitWhitespace();
        continue;
      }
    }

    if (state.lineComment) {
      if (current === "\n" || current === "\r") {
        state.lineComment = false;
      }
      continue;
    }

    if (state.blockComment) {
      if (current === "*" && next === "/") {
        state.blockComment = false;
        index += 1;
      }
      continue;
    }

    if (pendingWhitespace && output.length > 0) {
      output += " ";
    }
    pendingWhitespace = false;
    output += current;

    if (state.quote) {
      if (state.escaping) {
        state.escaping = false;
      } else if (current === "\\") {
        state.escaping = true;
      } else if (current === state.quote) {
        state.quote = null;
      }
      continue;
    }

    if (current === '"' || current === "'" || current === "`") {
      state.quote = current;
      continue;
    }

    if (current === "{") {
      braceDepth += 1;
    } else if (current === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  return stripRedundantUnionParens(output.trim());
};

const getDefinitionsFromDeclarations = (
  declarations: ReadonlyArray<GeneratedDeclaration>,
): Record<string, string> =>
  Object.fromEntries(
    declarations
      .filter((declaration) => declaration.name !== ROOT_WRAPPER_NAME)
      .map((declaration) => [declaration.name, compactTypeScript(declaration.body)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );

const previewFromCompiledTypeScript = (source: string): TypeScriptSchemaPreview => {
  const declarations = parseGeneratedDeclarations(source);
  const rootDeclaration = declarations.find(
    (declaration) => declaration.name === ROOT_WRAPPER_NAME,
  );
  const rootType =
    rootDeclaration?.kind === "interface"
      ? extractPropertyType(rootDeclaration.body, ROOT_PROPERTY_NAME)
      : null;

  return {
    type: compactTypeScript(rootType ?? "unknown"),
    definitions: getDefinitionsFromDeclarations(declarations),
  };
};

const previewToolFromCompiledTypeScript = (source: string): ToolTypeScriptPreview => {
  const declarations = parseGeneratedDeclarations(source);
  const rootDeclaration = declarations.find(
    (declaration) => declaration.name === ROOT_WRAPPER_NAME,
  );
  const inputType =
    rootDeclaration?.kind === "interface"
      ? extractPropertyType(rootDeclaration.body, TOOL_INPUT_PROPERTY_NAME)
      : null;
  const outputType =
    rootDeclaration?.kind === "interface"
      ? extractPropertyType(rootDeclaration.body, TOOL_OUTPUT_PROPERTY_NAME)
      : null;
  const definitions = getDefinitionsFromDeclarations(declarations);

  return {
    ...(inputType ? { inputTypeScript: compactTypeScript(inputType) } : {}),
    ...(outputType ? { outputTypeScript: compactTypeScript(outputType) } : {}),
    ...(Object.keys(definitions).length > 0 ? { typeScriptDefinitions: definitions } : {}),
  };
};

const compileSchemaPreview = async (
  schema: unknown,
  defs: ReadonlyMap<string, unknown>,
  options: TypeScriptRenderOptions,
): Promise<TypeScriptSchemaPreview> => {
  const wrappedSchema = buildWrappedSchema(schema, defs);
  const source = compile(wrappedSchema, ROOT_WRAPPER_NAME, compilerOptionsFrom(options));
  return previewFromCompiledTypeScript(source);
};

export const schemaToTypeScriptPreview = (
  schema: unknown,
  options: TypeScriptRenderOptions = {},
): Promise<TypeScriptSchemaPreview> => {
  const localDefs = new Map<string, unknown>(
    Object.entries(hoistDefinitions(asCompilerSchema(schema)).defs),
  );
  return schemaToTypeScriptPreviewWithDefs(schema, localDefs, options);
};

export const schemaToTypeScriptPreviewWithDefs = (
  schema: unknown,
  defs: ReadonlyMap<string, unknown>,
  options: TypeScriptRenderOptions = {},
): Promise<TypeScriptSchemaPreview> =>
  compileSchemaPreview(schema, defs, options).then(
    (preview) => preview,
    () => ({
      type: "unknown",
      definitions: {},
    }),
  );

export type ToolTypeScriptPreview = {
  inputTypeScript?: string;
  outputTypeScript?: string;
  typeScriptDefinitions?: Record<string, string>;
};

export const buildToolTypeScriptPreview = async (input: {
  inputSchema?: unknown;
  outputSchema?: unknown;
  defs: ReadonlyMap<string, unknown>;
  options?: TypeScriptRenderOptions;
}): Promise<ToolTypeScriptPreview> => {
  const properties: Array<readonly [string, unknown]> = [];
  if (input.inputSchema !== undefined) {
    properties.push([TOOL_INPUT_PROPERTY_NAME, input.inputSchema]);
  }
  if (input.outputSchema !== undefined) {
    properties.push([TOOL_OUTPUT_PROPERTY_NAME, input.outputSchema]);
  }
  if (properties.length === 0) {
    return {};
  }

  const wrappedSchema = buildWrappedObjectSchema(properties, input.defs);
  return Promise.resolve()
    .then(() => compile(wrappedSchema, ROOT_WRAPPER_NAME, compilerOptionsFrom(input.options ?? {})))
    .then(
      (source) => previewToolFromCompiledTypeScript(source),
      () => ({
        ...(input.inputSchema !== undefined ? { inputTypeScript: "unknown" } : {}),
        ...(input.outputSchema !== undefined ? { outputTypeScript: "unknown" } : {}),
      }),
    );
};
