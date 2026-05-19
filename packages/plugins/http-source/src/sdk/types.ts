import { Schema } from "effect";

export const HttpCredentialInput = Schema.Union([
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("secret"),
    secretId: Schema.String,
    secretScope: Schema.optional(Schema.String),
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("connection"),
    connectionId: Schema.String,
  }),
]);
export type HttpCredentialInput = typeof HttpCredentialInput.Type;

export const HttpConfiguredValueInput = Schema.Union([
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("secret"),
    prefix: Schema.optional(Schema.String),
  }),
]);
export type HttpConfiguredValueInput = typeof HttpConfiguredValueInput.Type;

export const OAuth2Flow = Schema.Literals(["authorizationCode", "clientCredentials"]);
export type OAuth2Flow = typeof OAuth2Flow.Type;

export const OAuth2SourceConfig = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  securitySchemeName: Schema.String,
  flow: OAuth2Flow,
  tokenUrl: Schema.String,
  authorizationUrl: Schema.NullOr(Schema.String),
  issuerUrl: Schema.optional(Schema.NullOr(Schema.String)),
  clientIdSlot: Schema.String,
  clientSecretSlot: Schema.NullOr(Schema.String),
  connectionSlot: Schema.String,
  scopes: Schema.Array(Schema.String),
}).annotate({ identifier: "OAuth2SourceConfig" });
export type OAuth2SourceConfig = typeof OAuth2SourceConfig.Type;

export const HttpOAuthConfigureInput = Schema.Struct({
  clientId: Schema.optional(HttpCredentialInput),
  clientSecret: Schema.optional(Schema.NullOr(HttpCredentialInput)),
  connection: Schema.optional(HttpCredentialInput),
}).annotate({ identifier: "HttpOAuthConfigureInput" });
export type HttpOAuthConfigureInput = typeof HttpOAuthConfigureInput.Type;
