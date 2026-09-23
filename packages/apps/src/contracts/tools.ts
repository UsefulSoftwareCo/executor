/** Agent-facing metadata. Apps author queries and mutations. */
import { Schema } from "effect";

/** Advisory tool hints; neither the framework nor these declarations enforce access. */
export const ToolAnnotations = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  readOnlyHint: Schema.optionalKey(Schema.Boolean),
  destructiveHint: Schema.optionalKey(Schema.Boolean),
  idempotentHint: Schema.optionalKey(Schema.Boolean),
  openWorldHint: Schema.optionalKey(Schema.Boolean),
});
export type ToolAnnotations = typeof ToolAnnotations.Type;
