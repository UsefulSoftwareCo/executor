import type { LinkedJSONSchema } from "./types/JSONSchema";
import { Intersection, Parent, Types } from "./types/JSONSchema";
import { typesOfSchema } from "./typesOfSchema";

export function applySchemaTyping(schema: LinkedJSONSchema) {
  const types = typesOfSchema(schema);

  Object.defineProperty(schema, Types, {
    enumerable: false,
    value: types,
    writable: false,
  });

  if (types.size === 1) {
    return;
  }

  // Some schemas can be understood as multiple possible types (see related
  // comment in `typesOfSchema.ts`). In such cases, we generate an `ALL_OF`
  // intersection that will ultimately be used to generate a union type.
  //
  // The original schema's name, title, and description are hoisted to the
  // new intersection schema to prevent duplication.
  //
  // If the original schema also contained its own `ALL_OF` property, it is
  // also hoiested to the new intersection schema.
  const intersection = {
    [Parent]: schema,
    [Types]: new Set(["ALL_OF"]),
    $id: schema.$id,
    description: schema.description,
    name: schema.name,
    title: schema.title,
    allOf: schema.allOf ?? [],
    required: [],
    additionalProperties: false,
  };

  types.delete("ALL_OF");
  delete schema.allOf;
  delete schema.$id;
  delete schema.description;
  delete schema.name;
  delete schema.title;

  Object.defineProperty(schema, Intersection, {
    enumerable: false,
    value: intersection,
    writable: false,
  });
}
