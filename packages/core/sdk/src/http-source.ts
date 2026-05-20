import { Effect, Schema } from "effect";

import {
  ConnectionId,
  ConfiguredCredentialBinding,
  credentialSlotPart,
  type ConfiguredCredentialValue,
  type CredentialBindingValue,
  type ScopedSecretCredentialInput,
  SecretId,
  ScopeId,
} from "./shared";

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
export type HttpCredentialInputType = HttpCredentialInput;

export const HttpConfiguredValueInput = Schema.Union([
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("secret"),
    prefix: Schema.optional(Schema.String),
  }),
]);
export type HttpConfiguredValueInput = typeof HttpConfiguredValueInput.Type;
export type HttpConfiguredValueInputType = HttpConfiguredValueInput;

export const OAuth2Flow = Schema.Literals(["authorizationCode", "clientCredentials"]);
export type OAuth2Flow = typeof OAuth2Flow.Type;
export type OAuth2FlowType = OAuth2Flow;

export const OAuth2SourceConfig = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  securitySchemeName: Schema.String,
  flow: OAuth2Flow,
  tokenUrl: Schema.String,
  authorizationUrl: Schema.NullOr(Schema.String).pipe(
    Schema.optional,
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  issuerUrl: Schema.optional(Schema.NullOr(Schema.String)),
  clientIdSlot: Schema.String,
  clientSecretSlot: Schema.NullOr(Schema.String),
  connectionSlot: Schema.String,
  scopes: Schema.Array(Schema.String),
}).annotate({ identifier: "OAuth2SourceConfig" });
export type OAuth2SourceConfig = typeof OAuth2SourceConfig.Type;
export type OAuth2SourceConfigType = OAuth2SourceConfig;

export const HttpOAuthConfigureInput = Schema.Struct({
  clientId: Schema.optional(HttpCredentialInput),
  clientSecret: Schema.optional(Schema.NullOr(HttpCredentialInput)),
  connection: Schema.optional(HttpCredentialInput),
}).annotate({ identifier: "HttpOAuthConfigureInput" });
export type HttpOAuthConfigureInput = typeof HttpOAuthConfigureInput.Type;
export type HttpOAuthConfigureInputType = HttpOAuthConfigureInput;

export type HttpCredentialSection = "request" | "specFetch" | "introspection";
export type HttpCredentialPlacement = "headers" | "query";

export const httpCredentialSlotKey = (
  section: HttpCredentialSection,
  placement: HttpCredentialPlacement,
  name: string,
): string => `${section}.${placement}.${credentialSlotPart(name)}`;

export const httpHeaderSlotKey = (section: HttpCredentialSection, name: string): string =>
  httpCredentialSlotKey(section, "headers", name);

export const httpQuerySlotKey = (section: HttpCredentialSection, name: string): string =>
  httpCredentialSlotKey(section, "query", name);

export const httpOAuthConnectionSlotKey = (section: HttpCredentialSection): string =>
  `${section}.oauth.connection`;

export const httpOAuthClientIdSlotKey = (section: HttpCredentialSection): string =>
  `${section}.oauth.clientId`;

export const httpOAuthClientSecretSlotKey = (section: HttpCredentialSection): string =>
  `${section}.oauth.clientSecret`;

export const httpSectionSlotPrefix = (section: HttpCredentialSection): string => `${section}.`;

export type HttpNamedCredentialInput =
  | ConfiguredCredentialValue
  | ScopedSecretCredentialInput
  | {
      readonly secretId: string;
      readonly prefix?: string;
      readonly targetScope?: string;
      readonly secretScopeId?: string;
    };

export interface CompiledHttpNamedCredentialBinding {
  readonly slot: string;
  readonly value: CredentialBindingValue;
  readonly targetScope?: string;
}

export const compileHttpNamedCredentialMap = (
  values: Record<string, HttpNamedCredentialInput | HttpCredentialInput> | undefined,
  slotForName: (name: string) => string,
): {
  readonly values: Record<string, ConfiguredCredentialValue>;
  readonly bindings: readonly CompiledHttpNamedCredentialBinding[];
} => {
  const nextValues: Record<string, ConfiguredCredentialValue> = {};
  const bindings: CompiledHttpNamedCredentialBinding[] = [];
  for (const [name, value] of Object.entries(values ?? {})) {
    if (typeof value === "string") {
      nextValues[name] = value;
      continue;
    }
    if ("kind" in value) {
      if (value.kind === "binding") {
        nextValues[name] = value;
        continue;
      }
      const slot = slotForName(name);
      nextValues[name] = ConfiguredCredentialBinding.make({
        kind: "binding",
        slot,
        prefix: "prefix" in value ? value.prefix : undefined,
      });
      bindings.push({
        slot,
        value: httpCredentialInputToBindingValue(value),
      });
      continue;
    }
    const slot = slotForName(name);
    nextValues[name] = ConfiguredCredentialBinding.make({
      kind: "binding",
      slot,
      prefix: value.prefix,
    });
    bindings.push({
      slot,
      targetScope: "targetScope" in value ? value.targetScope : undefined,
      value: {
        kind: "secret",
        secretId: SecretId.make(value.secretId),
        ...("secretScopeId" in value && value.secretScopeId
          ? { secretScopeId: ScopeId.make(value.secretScopeId) }
          : {}),
      },
    });
  }
  return { values: nextValues, bindings };
};

export const httpCredentialInputToBindingValue = (
  input: HttpCredentialInput,
): CredentialBindingValue => {
  if (typeof input === "string") {
    return {
      kind: "text",
      text: input,
    };
  }
  if (input.kind === "text") {
    return {
      kind: "text",
      text: input.text,
    };
  }
  if (input.kind === "secret") {
    return {
      kind: "secret",
      secretId: SecretId.make(input.secretId),
      ...(input.secretScope ? { secretScopeId: ScopeId.make(input.secretScope) } : {}),
    };
  }
  if (input.kind === "connection") {
    return {
      kind: "connection",
      connectionId: ConnectionId.make(input.connectionId),
    };
  }
  return input;
};
