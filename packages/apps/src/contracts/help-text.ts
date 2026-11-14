/**
 * Setup help: how an app explains a provider's methods to people connecting an account. A secrets
 * method's `guide`, an OAuth method's `clientGuide`, and every `title` and `description` in the
 * method's fields or response JSON Schema, at any depth. All of it is Markdown except a title. The
 * connect form shows the guides and each field's own help; agents read all of it.
 *
 * Help belongs to the app version that declares it, not to the provider. It is not part of the
 * provider's identity, so editing it never changes which accounts fit a requirement, and two apps
 * may explain one provider differently.
 */
import type { DeclaredAuthMethod, DeclaredProvider } from "./protocols/current.ts";
import type { JsonObject, JsonValue } from "./schema.ts";

/** The longest help a host accepts, in characters: a guide or client guide, a field description. */
export const helpTextLimits = { guide: 4000, description: 1000 } as const;

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Keywords whose values are schemas: one schema, a list of them (`items` may be either), or a map
 * of them by name (a `dependencies` entry may list property names instead). Every other keyword
 * holds data, such as `default`, `examples`, `const` and `enum`, whose `title` and `description`
 * keys are values, not help.
 */
const schemaNodes = new Set([
  "items",
  "additionalItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);
const schemaLists = new Set(["allOf", "anyOf", "oneOf", "prefixItems", "items"]);
const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

/**
 * A JSON Schema document with `edit` applied to every schema in it, since help can sit in any of
 * them: the root, each property at any depth, array items, `anyOf`, `oneOf` and `allOf` members,
 * and the `$defs` entry a `$ref` names. An optional field keeps its help on its `anyOf` member.
 */
export const mapFieldHelp = (
  document: JsonObject,
  edit: (schema: JsonObject) => JsonObject,
): JsonObject => {
  const schema = (value: JsonValue): JsonValue =>
    isObject(value) ? mapFieldHelp(value, edit) : value;
  return Object.fromEntries(
    Object.entries(edit(document)).map(([keyword, value]) => [
      keyword,
      Array.isArray(value)
        ? schemaLists.has(keyword)
          ? value.map(schema)
          : value
        : isObject(value) && schemaMaps.has(keyword)
          ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, schema(item)]))
          : schemaNodes.has(keyword)
            ? schema(value)
            : value,
    ]),
  );
};

/**
 * Each field's Markdown help in a fields or response JSON Schema, where the connect form shows it:
 * a property's `description`, or an optional field's on its `anyOf` member. Help nested deeper,
 * such as on an object field's own properties, is never shown, so a deploy does not check it.
 */
export const fieldDescriptions = (
  document: JsonObject,
): ReadonlyArray<readonly [field: string, description: string]> => {
  const properties = document["properties"];
  if (!isObject(properties)) return [];
  const descriptions = (schema: JsonValue): ReadonlyArray<string> => {
    if (!isObject(schema)) return [];
    const { description, anyOf } = schema;
    return [
      ...(typeof description === "string" ? [description] : []),
      ...(Array.isArray(anyOf) ? anyOf.flatMap(descriptions) : []),
    ];
  };
  return Object.entries(properties).flatMap(([name, schema]) =>
    descriptions(schema).map((description) => [name, description] as const),
  );
};

const withoutFieldHelp = ({ title: _title, description: _description, ...field }: JsonObject) =>
  field;

const methodWithoutHelp = (method: DeclaredAuthMethod): DeclaredAuthMethod => {
  if (method.type === "secrets") {
    const { guide: _guide, ...defined } = method;
    return { ...defined, fields: mapFieldHelp(method.fields, withoutFieldHelp) };
  }
  const { clientGuide: _clientGuide, ...defined } = method;
  return { ...defined, response: mapFieldHelp(method.response, withoutFieldHelp) };
};

/** A provider without its setup help, which account matching and provider identity ignore. */
export const withoutHelp = (provider: DeclaredProvider): DeclaredProvider => ({
  ...provider,
  auth: Object.fromEntries(
    Object.entries(provider.auth).map(([name, method]) => [name, methodWithoutHelp(method)]),
  ),
});
