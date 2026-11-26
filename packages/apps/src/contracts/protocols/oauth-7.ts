/** OAuth declarations frozen for host protocol 14, including its PKCE compatibility option. */
import { Schema } from "effect";
import { OAuth2Config as PreviousOAuth2Config } from "./oauth-6.ts";
import { declaredAuthorizationQuery } from "./oauth.ts";

const declaredPkce = Schema.makeFilter(
  (config: { readonly pkce?: false; readonly tokenEndpointAuthMethod?: string }) =>
    config.pkce === false &&
    (config.tokenEndpointAuthMethod === undefined || config.tokenEndpointAuthMethod === "none")
      ? {
          path: ["pkce"],
          issue:
            "pkce: false requires tokenEndpointAuthMethod client_secret_post, client_secret_basic or client_secret_basic_raw.",
        }
      : undefined,
);

const { discover, authorizationServerMetadataUrl, ...authorizationCodeFields } =
  PreviousOAuth2Config.members[1].fields;

export const OAuth2Config = Schema.Union([
  Schema.Struct(PreviousOAuth2Config.members[0].fields),
  Schema.Struct({
    ...authorizationCodeFields,
    pkce: Schema.optionalKey(Schema.Literal(false)),
    discover,
    authorizationServerMetadataUrl,
  }).check(declaredAuthorizationQuery, declaredPkce),
  Schema.Struct(PreviousOAuth2Config.members[2].fields),
  Schema.Struct(PreviousOAuth2Config.members[3].fields),
]);
export type OAuth2Config = typeof OAuth2Config.Type;
