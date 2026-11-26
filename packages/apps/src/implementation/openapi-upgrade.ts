/**
 * Upgrade an OpenAPI 3.0 document to 3.1 in place.
 *
 * The rules are those of `upgradeFromThreeToThreeOne` in @scalar/openapi-upgrader 0.3.1, applied
 * to each node after its children, as its traversal does. That traversal copies every node and
 * every path it visits, which for a large API is most of an app's memory and seconds of CPU. This
 * walks the document once, with one path stack, and its result equals Scalar's. The document must
 * be a tree: Scalar transforms each place an object appears separately, and an object reached twice
 * would be transformed once, in place.
 */
import { isSchemaPath } from "@scalar/helpers/openapi/is-schema-path";

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const namedSchemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions"]);
/** Whether `path.slice(0, end)` is a map of named subschemas. */
const isNamedSchemaMap = (path: readonly string[], end: number) => {
  const last = end > 0 ? path[end - 1] : undefined;
  if (last === undefined) return false;
  if (last === "schemas" && path[end - 2] === "components") return true;
  return namedSchemaMaps.has(last);
};
const dataKeywords = new Set(["example", "default", "const", "enum"]);
/**
 * Whether the path's last segment enters a data value: a data keyword, or the `value` of an Example
 * Object. No rule applies anywhere inside one, so the walk does not descend into it.
 */
const entersDataValue = (path: readonly string[]) => {
  const index = path.length - 1;
  const segment = path[index];
  if (segment === undefined) return false;
  if (dataKeywords.has(segment) && !isNamedSchemaMap(path, index)) return true;
  return (
    segment === "value" && path[index - 2] === "examples" && !isNamedSchemaMap(path, index - 2)
  );
};
const isInsideExamplesMap = (path: readonly string[]) =>
  path.some(
    (segment, index) => segment === "examples" && index > 0 && !isNamedSchemaMap(path, index),
  );

/**
 * A copy of `node` without `drop` and with `set`, in the key order the rules produce in place:
 * a set key keeps its position, and a new one is appended. Rules never delete properties, which
 * would leave V8 objects in a slower, several times larger representation for the rest of the
 * compilation.
 */
const replaceKeys = (node: Node, set: Node, drop: readonly string[]): Node => {
  const result: Node = {};
  for (const key of Object.keys(node))
    if (!drop.includes(key)) result[key] = Object.hasOwn(set, key) ? set[key] : node[key];
  for (const key of Object.keys(set)) if (!Object.hasOwn(result, key)) result[key] = set[key];
  return result;
};

/** One node's rules, outside any data value. Returns the node or its replacement. */
const upgradeNode = (input: Node, path: readonly string[]): Node => {
  let schema = input;
  if (schema.type !== undefined && schema.nullable === true) {
    schema = replaceKeys(schema, { type: [schema.type, "null"] }, ["nullable"]);
  } else if (schema.nullable === true && schema.type === undefined) {
    if (typeof schema.$ref === "string") {
      const { nullable: _nullable, $ref, ...rest } = schema;
      return { ...rest, anyOf: [{ $ref }, { type: "null" }] };
    }
    if (Array.isArray(schema.allOf)) {
      const { nullable: _nullable, allOf, ...rest } = schema;
      const base: unknown = allOf.length === 1 ? allOf[0] : { allOf };
      return { ...rest, anyOf: [base, { type: "null" }] };
    }
  }
  if (schema.exclusiveMinimum === true && schema.minimum !== undefined)
    schema = replaceKeys(schema, { exclusiveMinimum: schema.minimum }, ["minimum"]);
  else if (typeof schema.exclusiveMinimum === "boolean")
    schema = replaceKeys(schema, {}, ["exclusiveMinimum"]);
  if (schema.exclusiveMaximum === true && schema.maximum !== undefined)
    schema = replaceKeys(schema, { exclusiveMaximum: schema.maximum }, ["maximum"]);
  else if (typeof schema.exclusiveMaximum === "boolean")
    schema = replaceKeys(schema, {}, ["exclusiveMaximum"]);
  if (
    schema.example !== undefined &&
    !isInsideExamplesMap(path) &&
    !isNamedSchemaMap(path, path.length)
  )
    schema = replaceKeys(
      schema,
      {
        examples: isSchemaPath(path) ? [schema.example] : { default: { value: schema.example } },
      },
      ["example"],
    );
  if (schema.type === "string" || (Array.isArray(schema.type) && schema.type.includes("string"))) {
    if (schema.format === "binary") {
      const { format: _format, type: _type, ...binarySchema } = schema;
      const hasMediaType = path.at(-1) === "schema" && path.at(-3) === "content";
      return hasMediaType
        ? binarySchema
        : { contentMediaType: "application/octet-stream", ...binarySchema };
    }
    if (schema.format === "base64" || schema.format === "byte") {
      const { format: _format, ...rest } = schema;
      return { ...rest, contentEncoding: "base64" };
    }
  }
  if (schema["x-webhooks"] !== undefined && path.length === 0)
    schema = replaceKeys(schema, { webhooks: schema["x-webhooks"] }, ["x-webhooks"]);
  return schema;
};

/** Upgrade a 3.0 document the caller owns. Any other version is returned unchanged. */
export const upgradeOpenApi30InPlace = (document: Node): Node => {
  if (typeof document.openapi !== "string" || !document.openapi.startsWith("3.0")) return document;
  document.openapi = "3.1.1";
  const path: string[] = [];
  const visit = (node: Node): Node => {
    for (const key of Object.keys(node)) {
      const value = node[key];
      path.push(key);
      if (entersDataValue(path)) {
        path.pop();
        continue;
      }
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
          const item: unknown = value[index];
          if (isNode(item)) {
            path.push(String(index));
            value[index] = visit(item);
            path.pop();
          }
        }
      } else if (isNode(value)) node[key] = visit(value);
      path.pop();
    }
    return upgradeNode(node, path);
  };
  return visit(document);
};
