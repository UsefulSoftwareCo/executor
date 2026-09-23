/** Protocol templates produce retained files for the ordinary deployment API. */
import { Schema } from "effect";

/** Stable diagnostic reasons; authored names and source never enter telemetry. */
export const TemplateErrorCode = Schema.Literals([
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
export class TemplateError extends Schema.TaggedError<TemplateError>()("TemplateError", {
  code: TemplateErrorCode,
  reason: Schema.String,
}) {}

/** Credential-free provider declaration and API key placement. */
export interface RemoteAuth {
  readonly oauth?:
    | { readonly discover: string }
    | {
        readonly authorizationUrl: string;
        readonly tokenUrl: string;
        readonly scopes: readonly string[];
      };
  readonly apiKey?: { readonly header: string; readonly prefix: string };
}

/** Local-process configuration; environment values are supplied by accounts at runtime. */
export interface StdioAppInput {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  readonly environment: readonly string[];
  readonly timeoutMs?: number | undefined;
}
