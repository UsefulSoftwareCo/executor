type JsonObject = Readonly<Record<string, unknown>>;

export type ToolInputConstraint = {
  readonly path: string;
  readonly rules: readonly string[];
};

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const rulesForSchema = (schema: JsonObject): readonly string[] => {
  const rules: string[] = [];
  const minimum = finiteNumber(schema.minimum);
  const exclusiveMinimum = finiteNumber(schema.exclusiveMinimum);
  const maximum = finiteNumber(schema.maximum);
  const exclusiveMaximum = finiteNumber(schema.exclusiveMaximum);
  const multipleOf = finiteNumber(schema.multipleOf);
  const minLength = nonNegativeInteger(schema.minLength);
  const maxLength = nonNegativeInteger(schema.maxLength);
  const minItems = nonNegativeInteger(schema.minItems);
  const maxItems = nonNegativeInteger(schema.maxItems);
  const minProperties = nonNegativeInteger(schema.minProperties);
  const maxProperties = nonNegativeInteger(schema.maxProperties);
  const pattern = stringValue(schema.pattern);
  const format = stringValue(schema.format);

  if (exclusiveMinimum !== undefined) {
    rules.push(`value > ${exclusiveMinimum}`);
  } else if (minimum !== undefined) {
    rules.push(`${schema.exclusiveMinimum === true ? "value >" : "value >="} ${minimum}`);
  }
  if (exclusiveMaximum !== undefined) {
    rules.push(`value < ${exclusiveMaximum}`);
  } else if (maximum !== undefined) {
    rules.push(`${schema.exclusiveMaximum === true ? "value <" : "value <="} ${maximum}`);
  }
  if (multipleOf !== undefined) rules.push(`multiple of ${multipleOf}`);
  if (minLength !== undefined && minLength > 0) rules.push(`length >= ${minLength}`);
  if (maxLength !== undefined) rules.push(`length <= ${maxLength}`);
  if (minItems !== undefined && minItems > 0) rules.push(`items >= ${minItems}`);
  if (maxItems !== undefined) rules.push(`items <= ${maxItems}`);
  if (schema.uniqueItems === true) rules.push("items unique");
  if (minProperties !== undefined && minProperties > 0)
    rules.push(`properties >= ${minProperties}`);
  if (maxProperties !== undefined) rules.push(`properties <= ${maxProperties}`);
  if (pattern !== undefined) rules.push(`matches ${JSON.stringify(pattern)}`);
  if (format !== undefined) rules.push(`format ${format}`);

  return rules;
};

const decodeJsonPointerSegment = (segment: string): string =>
  segment.replaceAll("~1", "/").replaceAll("~0", "~");

const resolveReference = (
  reference: string,
  root: JsonObject,
  definitions: Readonly<Record<string, unknown>>,
): unknown => {
  if (!reference.startsWith("#/")) return undefined;
  const segments = reference.slice(2).split("/").map(decodeJsonPointerSegment);
  let current: unknown = root;
  for (const segment of segments) {
    if (!isJsonObject(current) || !(segment in current)) {
      current = undefined;
      break;
    }
    current = current[segment];
  }
  if (current !== undefined) return current;

  // executor.tools.schema() stores referenced definitions separately from the
  // input root. Only fall back for the exact flat definition shape it exposes;
  // guessing from the final segment of a deeper pointer can return a different
  // schema and publish incorrect constraints.
  const flatDefinition = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(reference);
  return flatDefinition === null
    ? undefined
    : definitions[decodeJsonPointerSegment(flatDefinition[1] ?? "")];
};

/**
 * Summarize the validation keywords that TypeScript cannot express.
 *
 * The result stays intentionally compact: callers still use the TypeScript
 * preview for shape and only consult this list for numeric, collection, and
 * string constraints that would otherwise be invisible.
 */
export const summarizeInputConstraints = (
  inputSchema: unknown,
  schemaDefinitions: Readonly<Record<string, unknown>> = {},
): readonly ToolInputConstraint[] => {
  if (!isJsonObject(inputSchema)) return [];

  const byPath = new Map<string, Set<string>>();
  const activeReferences = new Set<string>();

  const addRules = (path: string, rules: readonly string[]): void => {
    if (rules.length === 0) return;
    const existing = byPath.get(path) ?? new Set<string>();
    for (const rule of rules) existing.add(rule);
    byPath.set(path, existing);
  };

  const visit = (value: unknown, path: string): void => {
    if (!isJsonObject(value)) return;

    const reference = stringValue(value.$ref);
    if (reference !== undefined && !activeReferences.has(reference)) {
      const resolved = resolveReference(reference, inputSchema, schemaDefinitions);
      if (resolved !== undefined) {
        activeReferences.add(reference);
        visit(resolved, path);
        activeReferences.delete(reference);
      }
    } else if (reference !== undefined) {
      const resolved = resolveReference(reference, inputSchema, schemaDefinitions);
      if (isJsonObject(resolved)) addRules(path, rulesForSchema(resolved));
    }

    addRules(path, rulesForSchema(value));

    if (isJsonObject(value.properties)) {
      for (const [name, child] of Object.entries(value.properties)) {
        visit(child, path === "(root)" ? name : `${path}.${name}`);
      }
    }

    if (Array.isArray(value.prefixItems)) {
      value.prefixItems.forEach((child, index) => visit(child, `${path}[${index}]`));
    }
    if (Array.isArray(value.items)) {
      value.items.forEach((child, index) => visit(child, `${path}[${index}]`));
    } else if (isJsonObject(value.items)) {
      visit(value.items, `${path}[]`);
    }
    if (isJsonObject(value.additionalProperties)) visit(value.additionalProperties, `${path}.*`);

    // allOf constraints are conjunctive. anyOf/oneOf constraints are not: a
    // flat list would turn alternatives into an impossible conjunction, so we
    // intentionally omit branch-local rules until the contract can represent
    // per-branch groups.
    if (Array.isArray(value.allOf)) {
      for (const variant of value.allOf) visit(variant, path);
    }
  };

  visit(inputSchema, "(root)");
  return [...byPath.entries()].map(([path, rules]) => ({ path, rules: [...rules] }));
};
