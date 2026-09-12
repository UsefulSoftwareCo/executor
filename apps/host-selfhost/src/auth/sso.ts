import { type SsoConfig } from "../config";

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
  scopes: ["openid", "email", "profile"],
  pkce: true,
  ...(sso.providerId === "google" && sso.allowedDomains.length === 1
    ? { authorizationUrlParams: { hd: sso.allowedDomains[0]! } }
    : {}),
});
