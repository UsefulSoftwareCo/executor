import { Schema } from "effect";
import { OrganizationId } from "./organization.ts";
export const managedKeyName = "Executor app (created automatically)";
export const isManagedKey = (key: {
  readonly metadata?:
    | { readonly organization?: string | undefined; readonly executorApp?: true | undefined }
    | null
    | undefined;
}) => key.metadata?.executorApp === true && key.metadata.organization !== undefined;
export const ApiKeyId = Schema.NonEmptyString.pipe(Schema.brand("ApiKeyId"));
export const ApiKeyMetadata = Schema.Struct({
  organization: Schema.optional(OrganizationId),
  executorApp: Schema.optional(Schema.Literal(true)),
});
export type ApiKeyMetadata = typeof ApiKeyMetadata.Type;
export const ApiKeySummary = Schema.Struct({
  id: ApiKeyId,
  name: Schema.NullOr(Schema.String),
  start: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  lastRequest: Schema.NullOr(Schema.String),
  metadata: Schema.optional(Schema.NullOr(ApiKeyMetadata)),
});
export type ApiKeySummary = typeof ApiKeySummary.Type;
export const CreateApiKey = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80), Schema.isPattern(/\S/u)),
  expiresIn: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  metadata: Schema.optional(Schema.Struct({ organization: OrganizationId })),
});
export const CreatedApiKey = Schema.Struct({
  ...ApiKeySummary.fields,
  key: Schema.RedactedFromValue(Schema.NonEmptyString),
});
export const ApiKeyPage = Schema.Struct({
  apiKeys: Schema.Array(ApiKeySummary),
  total: Schema.Number,
});
