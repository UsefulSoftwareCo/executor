/** Project document-local references into the root definitions CodeMode can render. */
import type { Tool } from "@opencode-ai/codemode";
import { JsonPointer } from "effect";

const maps = ["properties", "$defs", "definitions"] as const;
const arrays = ["anyOf", "oneOf", "allOf"] as const;

const relocatedReference = (schema: Tool.JsonSchema): boolean => {
  const tokens = schema.$ref === undefined ? undefined : JsonPointer.parseUriFragment(schema.$ref);
  return (
    (tokens !== undefined &&
      (tokens.length !== 2 ||
        (tokens[0] !== "$defs" && tokens[0] !== "definitions") ||
        tokens[1] === "" ||
        schema.$ref?.includes("%") === true)) ||
    maps.some((key) => Object.values(schema[key] ?? {}).some(relocatedReference)) ||
    arrays.some((key) => schema[key]?.some(relocatedReference)) ||
    (schema.items !== undefined && relocatedReference(schema.items)) ||
    (typeof schema.additionalProperties === "object" &&
      relocatedReference(schema.additionalProperties))
  );
};

/**
 * Account routers relocate definitions under each account's input/output branch. CodeMode
 * only resolves root definition references, so give each referenced schema its own root name.
 * Names follow targets rather than upstream names: two accounts may declare different schemas
 * with the same name. References stay references, including recursive ones.
 */
export const signatureSchema = (input: Tool.JsonSchema): Tool.JsonSchema => {
  // Ordinary tools keep their schemas and shared definition objects without allocating an index.
  if (!relocatedReference(input)) return input;
  const nodes = new Map<string, Tool.JsonSchema>();
  const index = (schema: Tool.JsonSchema, path: readonly string[]) => {
    nodes.set(JSON.stringify(path), schema);
    for (const key of maps)
      for (const [name, child] of Object.entries(schema[key] ?? {}))
        index(child, [...path, key, name]);
    for (const key of arrays)
      schema[key]?.forEach((child, position) => index(child, [...path, key, String(position)]));
    if (schema.items !== undefined) index(schema.items, [...path, "items"]);
    if (typeof schema.additionalProperties === "object")
      index(schema.additionalProperties, [...path, "additionalProperties"]);
  };
  index(input, []);

  const names = new Map<Tool.JsonSchema, string>();
  const definitions: Record<string, Tool.JsonSchema> = {};
  const rewrite = (schema: Tool.JsonSchema): Tool.JsonSchema => {
    const { $defs: _definitions, definitions: _legacy, ...rest } = schema;
    const tokens =
      schema.$ref === undefined ? undefined : JsonPointer.parseUriFragment(schema.$ref);
    const target = tokens === undefined ? undefined : nodes.get(JSON.stringify(tokens));
    let reference = schema.$ref;
    if (target !== undefined) {
      let name = names.get(target);
      if (name === undefined) {
        name = `reference_${names.size}`;
        // Register before rewriting the target, so a cycle points back to this definition.
        names.set(target, name);
        definitions[name] = rewrite(target);
      }
      reference = `#/$defs/${name}`;
    }
    return {
      ...rest,
      ...(reference === undefined ? {} : { $ref: reference }),
      ...(schema.properties === undefined
        ? {}
        : {
            properties: Object.fromEntries(
              Object.entries(schema.properties).map(([name, child]) => [name, rewrite(child)]),
            ),
          }),
      ...(schema.items === undefined ? {} : { items: rewrite(schema.items) }),
      ...(typeof schema.additionalProperties === "object"
        ? { additionalProperties: rewrite(schema.additionalProperties) }
        : {}),
      ...Object.fromEntries(
        arrays.flatMap((key) =>
          schema[key] === undefined ? [] : [[key, schema[key].map(rewrite)]],
        ),
      ),
    };
  };
  return { ...rewrite(input), $defs: definitions };
};
