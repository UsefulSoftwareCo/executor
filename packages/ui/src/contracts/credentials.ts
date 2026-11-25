import type { OAuthClientId, OAuthClientSelection } from "@executor-js/sdk";
import { Option, Schema, type Redacted } from "effect";
import type { ReactNode } from "react";

const Field = Schema.Struct({
  type: Schema.Literals(["string", "number", "integer", "boolean"]),
  description: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  enum: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
});
const NullField = Schema.Struct({ type: Schema.Literal("null") });
const NullableField = Schema.Struct({
  anyOf: Schema.Union([Schema.Tuple([Field, NullField]), Schema.Tuple([NullField, Field])]),
  description: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
});
const Fields = Schema.Struct({
  properties: Schema.Record(Schema.String, Schema.Unknown),
  required: Schema.optional(Schema.Array(Schema.String)),
});
export type AccountFormFields = {
  readonly properties: Readonly<Record<string, typeof Field.Type>>;
  readonly required?: readonly string[] | undefined;
  readonly plain?: readonly string[] | undefined;
  readonly raw?: readonly string[] | undefined;
};
export const credentialValues = (
  fields: AccountFormFields,
  values: Readonly<Record<string, string>>,
) =>
  Object.fromEntries(
    Object.entries(fields.properties).flatMap(([name, field]) => {
      const value = values[name] ?? "";
      if (value === "" && !fields.required?.includes(name)) return [];
      return [
        [
          name,
          field.type === "boolean"
            ? value === "true"
            : field.type === "string"
              ? value
              : Number(value),
        ],
      ];
    }),
  );
export const credentialsComplete = (
  fields: AccountFormFields,
  values: Readonly<Record<string, string>>,
) => (fields.required ?? []).every((name) => values[name] !== undefined && values[name] !== "");
export const accountFields = (
  method:
    | {
        readonly type: "secrets";
        readonly fields: unknown;
        readonly plain?: readonly string[];
        readonly raw?: readonly string[];
      }
    | { readonly type: "oauth2" },
) =>
  method.type === "secrets"
    ? Option.gen(function* () {
        const fields = yield* Schema.decodeUnknownOption(Fields)(method.fields);
        const properties: Record<string, typeof Field.Type> = {};
        for (const [name, value] of Object.entries(fields.properties)) {
          properties[name] = yield* Schema.decodeUnknownOption(Field)(value).pipe(
            Option.orElse(() =>
              Option.gen(function* () {
                const nullable = yield* Schema.decodeUnknownOption(NullableField)(value);
                const field = yield* Option.fromUndefinedOr(
                  nullable.anyOf.find((item) => item.type !== "null"),
                );
                return {
                  ...field,
                  ...(nullable.title === undefined ? {} : { title: nullable.title }),
                  ...(nullable.description === undefined
                    ? {}
                    : { description: nullable.description }),
                };
              }),
            ),
          );
        }
        return {
          ...fields,
          properties,
          ...(method.plain === undefined ? {} : { plain: method.plain }),
          ...(method.raw === undefined ? {} : { raw: method.raw }),
        };
      })
    : undefined;

export interface AccountSubmission {
  readonly method: string;
  readonly fields: Redacted.Redacted<Readonly<Record<string, string | number | boolean>>>;
}
export interface AccountOAuthProps {
  readonly method: string;
  readonly disabled: boolean;
  readonly clientGuide: string | undefined;
  readonly onPendingChange: (pending: boolean) => void;
  readonly access: ReactNode;
}

export interface OAuthSubmission {
  readonly client?: OAuthClientSelection;
  readonly register?: boolean;
  readonly update?: OAuthClientId;
}
