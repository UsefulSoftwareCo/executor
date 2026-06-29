// ---------------------------------------------------------------------------
// OAuth — v2 surface re-exports.
//
// The v2 OAuth contracts (the `OAuthClient`, `OAuthService`, input/result
// shapes, and tagged errors) live in `oauth-client.ts`; this module re-exports
// them so existing imports of `./oauth` keep resolving. The OAuth 2.1 *protocol*
// implementation (PKCE/DCR/token exchange + refresh) lives in `oauth-helpers`
// and `oauth-discovery`; the runtime service is `oauth-service.ts`.
//
// v1's scope/secret-coupled OAuthService, strategy descriptors, and provider
// state schemas are gone — OAuth refresh material now lives on the connection
// row and core owns the flow (D14).
// ---------------------------------------------------------------------------

import { Encoding, Option, Result, Schema } from "effect";

export {
  type OAuthGrant,
  type OAuthAuthentication,
  type OAuthClient,
  type CreateOAuthClientInput,
  type ConnectResult,
  type OAuthStartInput,
  type OAuthCompleteInput,
  type OAuthProbeInput,
  type OAuthProbeResult,
  type OAuthService,
  OAuthStartError,
  OAuthCompleteError,
  OAuthProbeError,
  OAuthSessionNotFoundError,
} from "./oauth-client";

/** The canonical credential-provider key OAuth-minted connections persist
 *  their access token under (the default writable store). */
export const OAUTH2_PROVIDER_KEY = "oauth2" as const;

/** How long a pending authorization stays redeemable. */
export const OAUTH2_SESSION_TTL_MS = 15 * 60 * 1000;

const OAuthCallbackStateSchema = Schema.Struct({
  state: Schema.String,
  orgSlug: Schema.String,
});

export type OAuthCallbackState = typeof OAuthCallbackStateSchema.Type;

const OAuthCallbackStateFromJson = Schema.fromJsonString(OAuthCallbackStateSchema);
const decodeOAuthCallbackStateJson = Schema.decodeUnknownOption(OAuthCallbackStateFromJson);
const encodeOAuthCallbackStateJson = Schema.encodeSync(OAuthCallbackStateFromJson);

/** Encode URL selected callback routing data into OAuth `state`.
 *
 * The persisted OAuth session still uses the raw random state. Only the value
 * sent to the authorization server is wrapped, so providers can keep a static
 * redirect_uri while echoing enough state for the callback edge to pick the
 * correct organization before completing the flow.
 */
export const encodeOAuthCallbackState = (input: {
  readonly state: string;
  readonly orgSlug?: string | null;
}): string => {
  const orgSlug = input.orgSlug?.trim();
  if (!orgSlug) return input.state;
  return Encoding.encodeBase64Url(encodeOAuthCallbackStateJson({ state: input.state, orgSlug }));
};

/** Decode a callback state value minted by `encodeOAuthCallbackState`.
 *
 * Returns null for raw or foreign state values, which lets non-org hosts use
 * the raw OAuth state unchanged.
 */
export const decodeOAuthCallbackState = (
  value: string | null | undefined,
): OAuthCallbackState | null => {
  if (!value) return null;
  const json = Result.getOrNull(Encoding.decodeBase64UrlString(value));
  if (json === null) return null;
  const decoded = Option.getOrNull(decodeOAuthCallbackStateJson(json));
  if (decoded === null) return null;
  const orgSlug = decoded.orgSlug.trim();
  return orgSlug ? { state: decoded.state, orgSlug } : null;
};
