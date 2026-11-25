import { Schema } from "effect";
export const TemplateErrorCode = Schema.Literals(["source_generation", "authoring_reference"]);
export class TemplateError extends Schema.TaggedError<TemplateError>()("TemplateError", {
  code: TemplateErrorCode,
  reason: Schema.String,
}) {}

export interface CredentialPlacement {
  readonly carrier: "header" | "query";
  readonly name: string;
  readonly prefix?: string | undefined;
  readonly prefixField?: string | undefined;
  readonly field?: string | undefined;
  readonly literal?: string | undefined;
}

export type GeneratedHealthCheck =
  | {
      readonly kind: "request";
      readonly method: string;
      readonly url: string;
      readonly query: ReadonlyArray<readonly [string, string]>;
      readonly headers: Readonly<Record<string, string>>;
      readonly body?: string | undefined;
      readonly identity?:
        | {
            readonly path: readonly string[];
            readonly as: "username" | "displayName";
          }
        | undefined;
      readonly description: string;
    }
  | { readonly kind: "graphql"; readonly query: string };

export type GeneratedAuthMethod =
  | {
      readonly kind: "secrets";
      readonly label: string;
      readonly fields: readonly string[];
      readonly placements: readonly CredentialPlacement[];
    }
  | {
      readonly kind: "oauth";
      readonly oauth: Readonly<Record<string, unknown>>;
      readonly header: string;
      readonly prefix: string;
    };

export interface GeneratedToolRules {
  readonly names?:
    | { readonly kind: "map"; readonly names: Readonly<Record<string, string>> }
    | {
        readonly kind: "lower_snake";
        readonly overrides?: Readonly<Record<string, string>> | undefined;
      }
    | { readonly kind: "graphql_path" };
  readonly approvals?: Readonly<Record<string, "always" | "never">>;
  readonly omitted?: readonly string[];
  readonly otherwise?:
    | { readonly rule: "always" | "omitted"; readonly known: readonly string[] }
    | undefined;
}

export interface GeneratedFixedAccount {
  readonly fields: readonly string[];
  readonly placements: readonly CredentialPlacement[];
}

export interface ProtocolAppOptions {
  readonly name: string;
  readonly methods: Readonly<Record<string, GeneratedAuthMethod>>;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly queryParams?: Readonly<Record<string, string>> | undefined;
  readonly tools?: GeneratedToolRules | undefined;
  readonly health?: GeneratedHealthCheck | undefined;
  readonly appLinkedAccounts?: boolean | undefined;
  readonly fixedAccount?: GeneratedFixedAccount | undefined;
}
