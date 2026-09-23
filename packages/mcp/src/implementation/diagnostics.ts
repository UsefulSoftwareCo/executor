import { Schema, SchemaAST } from "effect";

/** Schema identifiers are static; an error's name, message and fields can contain private upstream data. */
export const diagnostic = (error: Error): string => {
  const schema = error.constructor;
  return Schema.isSchema(schema) ? (SchemaAST.resolveIdentifier(schema.ast) ?? "Error") : "Error";
};
