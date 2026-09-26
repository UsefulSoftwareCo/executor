/** Protocol templates produce retained files for the ordinary deployment API. */

/** Stable diagnostic reasons; authored names and source never enter telemetry. */
import { Schema } from "effect";
export const TemplateErrorCode = Schema.Literals(["source_generation", "authoring_reference"]);
export class TemplateError extends Schema.TaggedError<TemplateError>()("TemplateError", {
  code: TemplateErrorCode,
  reason: Schema.String,
}) {}
