import { type SsoConfig } from "../config";

type OAuthTokens = { readonly idToken?: string; readonly accessToken?: string };

type OidcClaims = {
  readonly sub?: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly name?: string;
  readonly picture?: string;
};

// The IdP's JSON is cast, not validated, so a claim is usable only when it is
// a non-empty string.
const claimString = (value: string | undefined): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

// Decode the claims payload only. The genericOAuth plugin already receives the
// ID token from its validated OAuth callback; this is not token validation.
const decodeIdTokenClaims = (idToken: string): OidcClaims | null => {
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a malformed third-party JWT payload must decline the profile, not fail the OAuth callback
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: genericOAuth provides a validated JWT; only its optional claims payload is decoded here
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OidcClaims;
  } catch {
    return null;
  }
};

// An ID token whose email claims are incomplete is resolved through UserInfo,
// because admission requires a verified email. A supplied ID token must carry
// a subject, and UserInfo claims are used only when their subject matches it.
export const ssoUserInfo = async (discoveryUrl: string, tokens: OAuthTokens) => {
  let idSub: string | null = null;
  if (tokens.idToken) {
    const claims = decodeIdTokenClaims(tokens.idToken);
    const sub = claims === null ? null : claimString(claims.sub);
    if (claims === null || sub === null) return null;
    idSub = sub;
    const email = claimString(claims.email);
    if (email !== null && claims.email_verified !== undefined) {
      return {
        ...claims,
        id: sub,
        email,
        emailVerified: claims.email_verified === true,
        name: claims.name,
        image: claims.picture,
      };
    }
  }

  if (!tokens.accessToken) return null;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: an unavailable IdP must decline the profile rather than reject the OAuth callback
  try {
    const discoveryResponse = await fetch(discoveryUrl);
    if (!discoveryResponse.ok) return null;
    const discovery = (await discoveryResponse.json()) as { userinfo_endpoint?: string };
    if (!discovery.userinfo_endpoint) return null;

    const profileResponse = await fetch(discovery.userinfo_endpoint, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!profileResponse.ok) return null;
    const profile = (await profileResponse.json()) as OidcClaims;
    const sub = claimString(profile.sub);
    const email = claimString(profile.email);
    if (sub === null || email === null) return null;
    if (idSub !== null && sub !== idSub) return null;

    return {
      ...profile,
      id: sub,
      email,
      emailVerified: profile.email_verified === true,
      name: profile.name,
      image: profile.picture,
    };
  } catch {
    return null;
  }
};

// Better Auth serves OAuth sign-in callbacks at `/oauth2/callback/:providerId`
// (genericOAuth) and `/callback/:providerId` (built-in social providers) — the
// only paths an IdP-initiated user creation arrives on, so this splits "a
// stranger signed in at the IdP" from server-side creation (the seed, admin
// add-user), which never carries either.
export const isOAuthCallback = (path: string | undefined): boolean =>
  path?.startsWith("/oauth2/callback/") === true || path?.startsWith("/callback/") === true;

// The domain of a well-formed address, or null — so a malformed email can never
// match an allowlist entry (`emailDomain("@example.com")` is null, not "example.com").
export const emailDomain = (email: string): string | null => {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
};

// Admission = the IdP vouches for the address (`email_verified`, mapped to
// `emailVerified` by the genericOAuth callback) AND its domain is allowlisted.
// Without the verified check, anyone could register an IdP account with a
// made-up allowlisted address and walk in.
export const isAdmitted = (
  sso: SsoConfig,
  user: { email: string; emailVerified: boolean },
): boolean => {
  if (!user.emailVerified) return false;
  const domain = emailDomain(user.email);
  return domain !== null && sso.allowedDomains.includes(domain);
};

// The genericOAuth registration for the configured provider, derived from its
// OIDC discovery document. For Google with a single allowed domain, `hd`
// pre-filters the account chooser — a UX hint only (Google treats it as
// advisory); the create-hook gate is the enforcement.
export const ssoProviderConfig = (sso: SsoConfig) => ({
  providerId: sso.providerId,
  clientId: sso.clientId,
  clientSecret: sso.clientSecret,
  discoveryUrl: sso.discoveryUrl,
  getUserInfo: (tokens: OAuthTokens) => ssoUserInfo(sso.discoveryUrl, tokens),
  scopes: ["openid", "email", "profile"],
  pkce: true,
  ...(sso.providerId === "google" && sso.allowedDomains.length === 1
    ? { authorizationUrlParams: { hd: sso.allowedDomains[0]! } }
    : {}),
});
