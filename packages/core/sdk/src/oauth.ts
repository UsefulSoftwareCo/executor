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

/** Query parameter used to carry the URL-selected org through OAuth callbacks. */
export const OAUTH_CALLBACK_ORG_QUERY_PARAM = "executor_org" as const;
