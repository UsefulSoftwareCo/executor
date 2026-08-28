import { Schema } from "effect";
import type { JsonSchema } from "effect/JsonSchema";

export const ToolRegistration = Schema.Struct({
  path: Schema.String,
  description: Schema.optional(Schema.String),
  integrationId: Schema.String,
  input: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type ToolRegistration = typeof ToolRegistration.Type;

export const SerializedCatalog = Schema.Struct({
  version: Schema.Literal("v4.1"),
  types: Schema.Record(Schema.String, Schema.Unknown),
  tools: Schema.Array(ToolRegistration),
});
export type SerializedCatalog = typeof SerializedCatalog.Type;

export interface LiveToolRegistration {
  readonly path: string;
  readonly description?: string;
  readonly integrationId: string;
  readonly input?: Schema.Top;
  readonly output?: Schema.Top;
  readonly error?: Schema.Top;
}

export interface LiveCatalog {
  readonly version: "v4.1";
  readonly types: Record<string, JsonSchema>;
  readonly tools: readonly LiveToolRegistration[];
}
