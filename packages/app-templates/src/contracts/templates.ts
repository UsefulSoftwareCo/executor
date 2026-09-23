/** Protocol templates produce retained files for the ordinary deployment API. */
import { Schema } from "effect";

/** A safe generation failure, translated into product HTTP errors at the boundary. */
export class TemplateError extends Schema.TaggedError<TemplateError>()("TemplateError", {
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
