/** Protocol templates produce retained files for the ordinary deployment API. */

/** Stable diagnostic reasons; authored names and source never enter telemetry. */
import { Schema } from "effect";
export const TemplateErrorCode = Schema.Literals(["source_generation", "authoring_reference"]);
export class TemplateError extends Schema.TaggedError<TemplateError>()("TemplateError", {
  code: TemplateErrorCode,
  reason: Schema.String,
}) {}

/** Where an account's credential, or a fixed value, goes on each request. */
export interface CredentialPlacement {
  readonly carrier: "header" | "query";
  readonly name: string;
  readonly prefix?: string | undefined;
  /** An account field sent before the value instead of `prefix`, for a prefix that is secret. */
  readonly prefixField?: string | undefined;
  /** The account field sent. Absent when `literal` is sent instead. */
  readonly field?: string | undefined;
  readonly literal?: string | undefined;
}

/**
 * How a generated provider checks an account. `request` sends one fixed request with the account's
 * credentials and the app's fixed values: 401 and 403 refuse the credentials, except a 403 whose
 * Google-style error names a service that is not enabled (`forbidden`); `identity` names the
 * response field that names the account. `graphql` introspects the endpoint's schema.
 */
export type GeneratedHealthCheck =
  | {
      readonly kind: "request";
      readonly method: string;
      /** The URL without its query; `query` pairs follow the fixed and credential values. */
      readonly url: string;
      readonly query: ReadonlyArray<readonly [string, string]>;
      readonly headers: Readonly<Record<string, string>>;
      readonly body?: string | undefined;
      readonly identity?:
        | {
            readonly path: readonly string[];
            /** What a value that is not an email address names. */
            readonly as: "username" | "displayName";
          }
        | undefined;
      /** What the comment says the request is, such as `GET /me`. */
      readonly description: string;
    }
  | { readonly kind: "graphql"; readonly query: string };

/** One sign-in method of a generated provider. */
export type GeneratedAuthMethod =
  | {
      readonly kind: "secrets";
      readonly label: string;
      /** Secret fields the connect form asks for. */
      readonly fields: readonly string[];
      readonly placements: readonly CredentialPlacement[];
    }
  | {
      readonly kind: "oauth";
      /** The `oauth2(...)` declaration, written into the source as JSON. */
      readonly oauth: Readonly<Record<string, unknown>>;
      /** The header that carries the access token, and its prefix. */
      readonly header: string;
      readonly prefix: string;
    };

/** How a generated app names its tools and which ones ask before running. */
export interface GeneratedToolRules {
  /**
   * How upstream names become exposed names: a fixed map (unmapped tools are left out), lower
   * snake case with exceptions by upstream name, or GraphQL's `query.<field>` and
   * `mutation.<field>` paths.
   */
  readonly names?:
    | { readonly kind: "map"; readonly names: Readonly<Record<string, string>> }
    | {
        readonly kind: "lower_snake";
        readonly overrides?: Readonly<Record<string, string>> | undefined;
      }
    | { readonly kind: "graphql_path" };
  /** Exposed names that always ask (`always`) or never ask (`never`) before running. */
  readonly approvals?: Readonly<Record<string, "always" | "never">>;
  /** Exposed names the app leaves out. */
  readonly omitted?: readonly string[];
}

/** Settings shared by the protocol generators. No methods makes a public app. */
export interface ProtocolAppOptions {
  readonly name: string;
  readonly methods: Readonly<Record<string, GeneratedAuthMethod>>;
  /** Fixed, non-credential headers and query parameters sent on every request. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly queryParams?: Readonly<Record<string, string>> | undefined;
  readonly tools?: GeneratedToolRules | undefined;
  /** How the provider checks an account; without one an OpenAPI or GraphQL app has no check. */
  readonly health?: GeneratedHealthCheck | undefined;
}
