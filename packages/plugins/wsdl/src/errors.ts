import { Schema } from "effect";
export class WsdlError extends Schema.TaggedErrorClass<WsdlError>()("WsdlError", {
  message: Schema.String,
}) {}
