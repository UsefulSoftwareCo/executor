/** Shared OpenAPI compilation diagnostics. */
import { Schema } from "effect";
export const OpenapiCompileErrorCode = Schema.Literals([
  "server_protocol",
  "server_url",
  "external_reference",
  "circular_reference",
  "schema_keyword",
  "schema_reference",
  "missing_component",
  "openapi_version",
  "auth_helper",
  "auth_missing",
  "operation_path",
  "duplicate_operation",
  "server_missing",
  "multiple_hosts",
  "parameter_encoding",
  "parameter_style",
  "request_body",
  "combined_oauth",
  "auth_method",
  "input_schema",
  "no_operations",
  "no_supported_operations",
  "invalid_document",
  "source_generation",
  "authoring_reference",
]);

/** A safe generation failure, translated into product HTTP errors at the boundary. */
export class OpenapiCompileError extends Schema.TaggedError<OpenapiCompileError>()(
  "OpenapiCompileError",
  {
    code: OpenapiCompileErrorCode,
    reason: Schema.String,
  },
) {}
