import { Match, Option } from "effect";

type JsonSchemaRecord = Record<string, unknown>;

export type TypeScriptRenderOptions = {
  maxLength?: number;
  maxDepth?: number;
  maxProperties?: number;
  maxRefDepth?: number;
  maxCompositeMembers?: number;
};

export type TypeScriptSchemaPreview = {
  readonly type: string;
  readonly definitions: Record<string, string>;
};

const VALID_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const REF_PATTERN = /^#\/(?:\$defs|definitions)\/(.+)$/;

const asRecord = (value: unknown): JsonSchemaRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonSchemaRecord)
    : {};

const asStringArray = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 4))} ...`;

const formatPropertyKey = (value: string): string =>
  VALID_IDENTIFIER_PATTERN.test(value) ? value : JSON.stringify(value);

const refNameFromPointer = (ref: string): string | undefined => ref.match(REF_PATTERN)?.[1];

const refFallbackLabel = (ref: string): string =>
  refNameFromPointer(ref) ?? ref.split("/").at(-1) ?? ref;

const summarizeLargeComposite = (
  schema: JsonSchemaRecord,
  maxCompositeMembers: number,
): { kind: "oneOf" | "anyOf"; count: number } | null => {
  for (const kind of ["oneOf", "anyOf"] as const) {
    const items = schema[kind];
    if (Array.isArray(items) && items.length > maxCompositeMembers) {
      return { kind, count: items.length };
    }
  }

  return null;
};

const primitiveTypeName = (value: string): string =>
  Match.value(value).pipe(
    Match.whenOr("integer", "number", () => "number"),
    Match.whenOr("string", "boolean", "null", (v) => v),
    Match.when("array", () => "unknown[]"),
    Match.when("object", () => "Record<string, unknown>"),
    Match.option,
    Option.getOrElse(() => "unknown"),
  );

const renderComposite = (input: {
  key: "oneOf" | "anyOf" | "allOf";
  schema: JsonSchemaRecord;
  render: (value: unknown, depthRemaining: number) => string;
  depthRemaining: number;
}): string | null => {
  const rawItems = input.schema[input.key];
  const items: JsonSchemaRecord[] = Array.isArray(rawItems)
    ? rawItems.map((item: unknown) => asRecord(item))
    : [];
  if (items.length === 0) {
    return null;
  }

  const labels = items
    .map((item: JsonSchemaRecord) => input.render(item, input.depthRemaining - 1))
    .filter((label: string) => label.length > 0);

  if (labels.length === 0) {
    return null;
  }

  return labels.join(input.key === "allOf" ? " & " : " | ");
};

const localDefinitionsFromSchema = (schema: unknown): Map<string, unknown> => {
  const root = asRecord(schema);
  const defs = new Map<string, unknown>();

  for (const [key, value] of Object.entries(asRecord(root.$defs))) {
    defs.set(key, value);
  }

  for (const [key, value] of Object.entries(asRecord(root.definitions))) {
    defs.set(key, value);
  }

  return defs;
};

export const schemaToTypeScriptPreview = (
  schema: unknown,
  options: TypeScriptRenderOptions = {},
): TypeScriptSchemaPreview => {
  const localDefs = localDefinitionsFromSchema(schema);
  return schemaToTypeScriptPreviewWithDefs(schema, localDefs, options);
};

export const schemaToTypeScriptPreviewWithDefs = (
  schema: unknown,
  defs: ReadonlyMap<string, unknown>,
  options: TypeScriptRenderOptions = {},
): TypeScriptSchemaPreview => {
  const maxLength = options.maxLength ?? 400;
  const maxDepth = options.maxDepth ?? 6;
  const maxProperties = options.maxProperties ?? 12;
  const maxRefDepth = options.maxRefDepth ?? 3;
  const maxCompositeMembers = options.maxCompositeMembers ?? 8;

  const render = (input: {
    currentInput: unknown;
    depthRemaining: number;
    refDepthRemaining: number;
  }): string => {
    const current = asRecord(input.currentInput);

    if (input.depthRemaining <= 0) {
      if (typeof current.title === "string" && current.title.length > 0) {
        return current.title;
      }

      if (current.type === "array") {
        return "unknown[]";
      }

      if (current.type === "object" || current.properties) {
        return "Record<string, unknown>";
      }

      return "unknown";
    }

    if (typeof current.$ref === "string") {
      const refLabel = refFallbackLabel(current.$ref);
      return input.refDepthRemaining > 0 ? refLabel : `unknown /* ${refLabel} omitted */`;
    }

    if ("const" in current) {
      return JSON.stringify(current.const);
    }

    const enumValues = Array.isArray(current.enum) ? current.enum : [];
    if (enumValues.length > 0) {
      return truncate(enumValues.map((value) => JSON.stringify(value)).join(" | "), maxLength);
    }

    const largeComposite = summarizeLargeComposite(current, maxCompositeMembers);
    if (largeComposite) {
      return `unknown /* ${largeComposite.count}-way ${largeComposite.kind} omitted */`;
    }

    const renderNested = (value: unknown): string =>
      render({
        currentInput: value,
        depthRemaining: input.depthRemaining - 1,
        refDepthRemaining: input.refDepthRemaining,
      });

    const composite =
      renderComposite({
        key: "oneOf",
        schema: current,
        render: (value) => renderNested(value),
        depthRemaining: input.depthRemaining,
      }) ??
      renderComposite({
        key: "anyOf",
        schema: current,
        render: (value) => renderNested(value),
        depthRemaining: input.depthRemaining,
      }) ??
      renderComposite({
        key: "allOf",
        schema: current,
        render: (value) => renderNested(value),
        depthRemaining: input.depthRemaining,
      });
    if (composite) {
      return truncate(composite, maxLength);
    }

    if (current.nullable === true) {
      const { nullable: _nullable, ...rest } = current;
      return truncate(
        `${render({
          currentInput: rest,
          depthRemaining: input.depthRemaining,
          refDepthRemaining: input.refDepthRemaining,
        })} | null`,
        maxLength,
      );
    }

    if (current.type === "array") {
      const itemLabel = current.items
        ? render({
            currentInput: current.items,
            depthRemaining: input.depthRemaining - 1,
            refDepthRemaining: input.refDepthRemaining,
          })
        : "unknown";
      return truncate(`${itemLabel}[]`, maxLength);
    }

    if (current.type === "object" || current.properties) {
      const properties = asRecord(current.properties);
      const propertyKeys = Object.keys(properties);
      const required = new Set(asStringArray(current.required));

      const additionalProperties = current.additionalProperties;
      const additionalPropertiesLabel =
        additionalProperties && typeof additionalProperties === "object"
          ? render({
              currentInput: additionalProperties,
              depthRemaining: input.depthRemaining - 1,
              refDepthRemaining: input.refDepthRemaining,
            })
          : additionalProperties === true
            ? "unknown"
            : null;

      if (propertyKeys.length === 0) {
        if (additionalPropertiesLabel) {
          return truncate(`Record<string, ${additionalPropertiesLabel}>`, maxLength);
        }

        return "Record<string, unknown>";
      }

      const visibleKeys = propertyKeys.slice(0, maxProperties);
      const parts = visibleKeys.map(
        (key) =>
          `${formatPropertyKey(key)}${required.has(key) ? "" : "?"}: ${render({
            currentInput: properties[key],
            depthRemaining: input.depthRemaining - 1,
            refDepthRemaining: input.refDepthRemaining,
          })}`,
      );

      if (visibleKeys.length < propertyKeys.length) {
        parts.push("...");
      }

      if (additionalPropertiesLabel) {
        parts.push(`[key: string]: ${additionalPropertiesLabel}`);
      }

      return truncate(`{ ${parts.join("; ")} }`, maxLength);
    }

    if (Array.isArray(current.type)) {
      return truncate(
        current.type
          .filter((value): value is string => typeof value === "string")
          .map(primitiveTypeName)
          .join(" | "),
        maxLength,
      );
    }

    if (typeof current.type === "string") {
      return primitiveTypeName(current.type);
    }

    return "unknown";
  };

  const referencedDepths = new Map<string, number>();

  const collectPreviewRefs = (currentInput: unknown, refDepth: number): void => {
    const current = asRecord(currentInput);

    if (summarizeLargeComposite(current, maxCompositeMembers)) {
      return;
    }

    if (typeof current.$ref === "string") {
      const name = refNameFromPointer(current.$ref);
      if (!name) {
        return;
      }

      const existingDepth = referencedDepths.get(name);
      if (existingDepth !== undefined && existingDepth <= refDepth) {
        return;
      }

      referencedDepths.set(name, refDepth);

      if (refDepth >= maxRefDepth) {
        return;
      }

      const target = defs.get(name);
      if (target !== undefined) {
        collectPreviewRefs(target, refDepth + 1);
      }
      return;
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        if (Array.isArray(value)) {
          for (const item of value) {
            collectPreviewRefs(item, refDepth);
          }
        } else {
          collectPreviewRefs(value, refDepth);
        }
      }
    }
  };

  collectPreviewRefs(schema, 1);

  const definitions = Object.fromEntries(
    [...referencedDepths.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, refDepth]) => {
        const target = defs.get(name);
        if (target === undefined) {
          return [];
        }

        return [
          [
            name,
            render({
              currentInput: target,
              depthRemaining: maxDepth,
              refDepthRemaining: Math.max(0, maxRefDepth - refDepth),
            }),
          ],
        ] as const;
      }),
  );

  return {
    type: render({
      currentInput: schema,
      depthRemaining: maxDepth,
      refDepthRemaining: maxRefDepth,
    }),
    definitions,
  };
};

export type ToolTypeScriptPreview = {
  inputTypeScript?: string;
  outputTypeScript?: string;
  typeScriptDefinitions?: Record<string, string>;
};

export const buildToolTypeScriptPreview = (input: {
  inputSchema?: unknown;
  outputSchema?: unknown;
  defs: ReadonlyMap<string, unknown>;
  options?: TypeScriptRenderOptions;
}): ToolTypeScriptPreview => {
  const inputPreview =
    input.inputSchema !== undefined
      ? schemaToTypeScriptPreviewWithDefs(input.inputSchema, input.defs, input.options)
      : null;
  const outputPreview =
    input.outputSchema !== undefined
      ? schemaToTypeScriptPreviewWithDefs(input.outputSchema, input.defs, input.options)
      : null;

  const mergedDefinitions = {
    ...inputPreview?.definitions,
    ...outputPreview?.definitions,
  };

  return {
    ...(inputPreview ? { inputTypeScript: inputPreview.type } : {}),
    ...(outputPreview ? { outputTypeScript: outputPreview.type } : {}),
    ...(Object.keys(mergedDefinitions).length > 0
      ? { typeScriptDefinitions: mergedDefinitions }
      : {}),
  };
};
