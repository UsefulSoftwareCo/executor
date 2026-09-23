import { Schema } from "effect";
import { OrganizationId } from "./organization.ts";
/** Public identifier, never the bearer credential. */
export const ApiKeyId = Schema.NonEmptyString.pipe(Schema.brand("ApiKeyId"));
/**
 * Stored key scope. A recorded organization pins the key to that organization;
 * a key without one authorizes every organization the user belongs to.
 */
export const ApiKeyMetadata = Schema.Struct({ organization: Schema.optional(OrganizationId) });
export type ApiKeyMetadata = typeof ApiKeyMetadata.Type;
/** Native Better Auth key metadata; secret hashes are excluded. */
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
/** PAT creation uses Better Auth's expiry duration in seconds and an optional organization pin. */
export const CreateApiKey = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80), Schema.isPattern(/\S/)),
  expiresIn: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  metadata: Schema.optional(Schema.Struct({ organization: OrganizationId })),
});
/** Only the native creation response contains the secret. */
export const CreatedApiKey = Schema.Struct({
  ...ApiKeySummary.fields,
  key: Schema.RedactedFromValue(Schema.NonEmptyString),
});
/** Native paginated response from Better Auth. */
export const ApiKeyPage = Schema.Struct({
  apiKeys: Schema.Array(ApiKeySummary),
  total: Schema.Number,
});
