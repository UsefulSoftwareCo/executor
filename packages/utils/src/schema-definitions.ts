import type { Schema } from "effect";

export const putEntry = <A>(target: Record<string, A>, name: string, value: A) => {
  if (name === "__proto__")
    Object.defineProperty(target, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  else target[name] = value;
};

type JsonEntries = { readonly [key: string]: Schema.Json };
const isEntries = (value: Schema.Json | undefined): value is JsonEntries =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const schemaDefinitions = (schema: JsonEntries | undefined): JsonEntries | undefined => {
  const definitions = schema?.$defs;
  return isEntries(definitions) ? definitions : undefined;
};
