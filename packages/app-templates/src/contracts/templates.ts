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
  /** Offer an explicit credential-free connection alongside sign-in methods; never selected automatically. */
  readonly public?: true;
  readonly oauth?:
    | { readonly discover: string }
    | {
        readonly authorizationUrl: string;
        readonly tokenUrl: string;
        readonly scopes: readonly string[];
        readonly tokenEndpointAuthMethod?: "client_secret_basic";
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

/**
 * One API operation left out of an otherwise usable import. It holds only names from the API
 * definition and a reason code, never upstream text. `summary` gives the fixed copy for a code.
 */
export const SkippedOperation = Schema.Struct({
  tool: Schema.String,
  method: Schema.String,
  path: Schema.String,
  reason: TemplateErrorCode,
});
export type SkippedOperation = typeof SkippedOperation.Type;

/** Short, fixed copy for why an operation was skipped. */
export const skippedOperationSummary = (reason: SkippedOperation["reason"]): string => {
  switch (reason) {
    case "multiple_hosts":
      return "Uses a different API host.";
    case "request_body":
      return "Uses an unsupported request body.";
    case "parameter_encoding":
      return "Uses an unsupported parameter encoding.";
    case "parameter_style":
      return "Uses an unsupported parameter style.";
    case "auth_method":
    case "combined_oauth":
      return "Uses an unsupported authentication method.";
    case "operation_path":
      return "Has an invalid path.";
    case "duplicate_operation":
      return "Has the same tool name as another operation.";
    case "server_missing":
    case "server_url":
    case "server_protocol":
      return "Has no usable server URL.";
    case "input_schema":
    case "schema_keyword":
    case "schema_reference":
    case "missing_component":
    case "external_reference":
    case "circular_reference":
      return "Uses a schema that cannot be imported.";
    default:
      return "Uses an API feature that cannot be imported.";
  }
};
