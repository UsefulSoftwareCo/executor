import type { OAuthStrategy } from "@executor-js/sdk/shared";

export const GOOGLE_DISCOVERY_OAUTH_POPUP_NAME = "google-discovery-oauth";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const GOOGLE_EXTRA_AUTHORIZATION_PARAMS = {
  access_type: "offline",
  include_granted_scopes: "true",
  prompt: "consent",
} as const;

export const googleDiscoveryOAuthStrategy = (input: {
  readonly clientIdSecretId: string;
  readonly clientSecretSecretId: string | null;
  readonly scopes: readonly string[];
}): OAuthStrategy => ({
  kind: "authorization-code",
  authorizationEndpoint: GOOGLE_AUTHORIZATION_URL,
  tokenEndpoint: GOOGLE_TOKEN_URL,
  issuerUrl: "https://accounts.google.com",
  clientIdSecretId: input.clientIdSecretId,
  clientSecretSecretId: input.clientSecretSecretId,
  scopes: [...input.scopes],
  extraAuthorizationParams: GOOGLE_EXTRA_AUTHORIZATION_PARAMS,
});
