/** Provider definitions are authored in apps, not registered through SDK CRUD. */
import { Schema } from "effect";
import { ProviderId } from "./shared.ts";
import { DeclaredAuthMethod } from "apps/contracts";

/** An author-chosen method name such as apiKey or oauth. */
export const AuthMethodName = Schema.NonEmptyString;

/** Serializable auth configuration is owned by the app framework and interpreted by the host. */
export const ProviderAuthMethod = DeclaredAuthMethod;

export type ProviderAuthMethod = typeof ProviderAuthMethod.Type;

/**
 * Normalized, credential-free content used to derive a provider reference.
 * Matching definitions across apps produce the same reference. Authors do
 * not choose a global ID or register an owner-specific provider. The host's
 * normalization and hash implementation derive the reference; OAuth client resolution remains deferred.
 */
export const ProviderDefinition = Schema.Struct({
  name: Schema.NonEmptyString,
  auth: Schema.Record(AuthMethodName, ProviderAuthMethod),
});

export type ProviderDefinition = typeof ProviderDefinition.Type;

/** A provider reference with its definition, as exposed in app requirements. */
export const Provider = Schema.Struct({
  id: ProviderId,
  definition: ProviderDefinition,
});

export type Provider = typeof Provider.Type;

/** The provider reference did not resolve in this Executor host. */
export class ProviderNotFound extends Schema.TaggedError<ProviderNotFound>()(
  "ProviderNotFound",
  { provider: ProviderId },
  { httpApiStatus: 404, description: "No provider definition matches this reference." },
) {}

/** The named method is absent or is the wrong kind for this operation. */
export class AuthMethodInvalid extends Schema.TaggedError<AuthMethodInvalid>()(
  "AuthMethodInvalid",
  { provider: ProviderId, method: AuthMethodName },
  {
    httpApiStatus: 422,
    description: "Select a secrets method for add, or an OAuth method for startOAuth.",
  },
) {}
