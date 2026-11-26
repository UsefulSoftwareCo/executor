export type JsonSchema = { readonly [key: string]: unknown };

export const isSchema = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const text = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

export const display = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
