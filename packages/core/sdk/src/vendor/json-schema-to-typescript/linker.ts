import { Parent } from "./types/JSONSchema";
import type { JSONSchema, LinkedJSONSchema } from "./types/JSONSchema";
import { isPlainObject } from "./compat";
import type { JSONSchema4Type } from "./types/json-schema";

/**
 * Traverses over the schema, giving each node a reference to its
 * parent node. We need this for downstream operations.
 */
export function link(
  schema: JSONSchema4Type | JSONSchema,
  parent: JSONSchema4Type | null = null,
): LinkedJSONSchema {
  if (!Array.isArray(schema) && !isPlainObject(schema)) {
    return schema as LinkedJSONSchema;
  }

  // Handle cycles
  if ((schema as JSONSchema).hasOwnProperty(Parent)) {
    return schema as LinkedJSONSchema;
  }

  // Add a reference to this schema's parent
  Object.defineProperty(schema, Parent, {
    enumerable: false,
    value: parent,
    writable: false,
  });

  // Arrays
  if (Array.isArray(schema)) {
    schema.forEach((child) => link(child, schema));
  }

  // Objects
  for (const key in schema as JSONSchema) {
    link((schema as JSONSchema)[key], schema);
  }

  return schema as LinkedJSONSchema;
}
