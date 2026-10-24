/** Custom imports retain public configuration; credentials are connected after deploying. */
import { Schema } from "effect";
import { HttpUrl } from "@executor-js/sdk";

/** Credential-free URL syntax; the product decides which network destinations are allowed. */
export const ImportUrl = HttpUrl.check(
  Schema.makeFilter(
    (value) => {
      const url = new URL(value);
      return !url.username && !url.password && !url.hash && !url.search && !/[{}]/.test(value);
    },
    { expected: "an HTTP(S) URL without credentials, query parameters, fragments or placeholders" },
  ),
);
/** Public configuration only. Credentials are connected through the app's account requirements. */
export const CustomAppInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("mcp"), name: Schema.NonEmptyString, url: ImportUrl }),
  Schema.Struct({
    kind: Schema.Literal("openapi"),
    name: Schema.NonEmptyString,
    url: ImportUrl,
    /** Override a definition's server when it does not describe the intended API endpoint. */
    baseUrl: Schema.optionalKey(ImportUrl),
  }),
  Schema.Struct({
    kind: Schema.Literal("graphql"),
    name: Schema.NonEmptyString,
    url: ImportUrl,
    /** GraphQL has no standard authentication declaration to discover. */
    auth: Schema.optionalKey(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal("bearer") }),
        Schema.Struct({
          kind: Schema.Literal("apiKey"),
          header: Schema.String.check(Schema.isPattern(/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/u)),
        }),
      ]),
    ),
  }),
]);
export type CustomAppInput = typeof CustomAppInput.Type;
