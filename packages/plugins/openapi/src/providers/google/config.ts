import { Option, Schema } from "effect";

import { AuthenticationSchema } from "../../sdk/config";
import type { Authentication } from "../../sdk/types";

export const GoogleIntegrationConfigSchema = Schema.Struct({
  specHash: Schema.optional(Schema.String),
  specUrl: Schema.optional(Schema.String),
  googleDiscoveryUrls: Schema.optional(Schema.Array(Schema.String)),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  authenticationTemplate: Schema.optional(Schema.Array(AuthenticationSchema)),
});

export type GoogleIntegrationConfig = Omit<
  typeof GoogleIntegrationConfigSchema.Type,
  "authenticationTemplate"
> & {
  readonly authenticationTemplate?: readonly Authentication[];
};

const decodeConfig = Schema.decodeUnknownOption(GoogleIntegrationConfigSchema);

export const decodeGoogleIntegrationConfig = (value: unknown): GoogleIntegrationConfig | null =>
  Option.getOrNull(decodeConfig(value)) as GoogleIntegrationConfig | null;
