import { UserFacingError } from "@executor-js/utils/user-facing-error";
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
export const ProviderNotFound = UserFacingError.define({
  tag: "ProviderNotFound",
  status: 404,
  fields: { provider: ProviderId },
  title: "Service no longer available",
  description: "Executor could not find the requested service configuration.",
  recovery: {
    action:
      "Close this form and reload the app. If the service is still missing, copy the fix prompt into your agent to repair its configuration.",
    instructions:
      "Inspect the current app’s account requirements and provider definitions. Determine whether the service was removed or its provider reference changed. Repair an incorrect definition or requirement and reopen setup against the current provider.",
  },
});
/** Parsed ProviderNotFound failure. */
export type ProviderNotFound = typeof ProviderNotFound.Type;

/** The named method is absent or is the wrong kind for this operation. */
export const AuthMethodInvalid = UserFacingError.define({
  tag: "AuthMethodInvalid",
  status: 422,
  fields: { provider: ProviderId, method: AuthMethodName },
  title: "Sign-in method unavailable",
  description: "The selected sign-in method is missing or cannot be used for this action.",
  recovery: {
    action: "Reopen setup and select a supported sign-in method.",
    instructions:
      "Inspect the current provider definition and the methods supported by the failed operation. Use a current compatible method. If the provider definition removed the intended method by mistake, correct it; do not reuse the stale method reference.",
  },
});
/** Parsed AuthMethodInvalid failure. */
export type AuthMethodInvalid = typeof AuthMethodInvalid.Type;
