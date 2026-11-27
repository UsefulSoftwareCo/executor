import type { DeclaredAuthMethod } from "apps/contracts";
type AuthMethod = typeof DeclaredAuthMethod.Type;

/** Reviewed defaults for existing catalog declarations; identity never follows a display name. */
const googleAuthorization = (method: AuthMethod) => {
  if (method.type !== "oauth2" || method.grant === "client_credentials") return false;
  return method.discover !== undefined
    ? [
        "https://accounts.google.com",
        "https://accounts.google.com/",
        "https://accounts.google.com/.well-known/openid-configuration",
      ].includes(method.discover)
    : [
        "https://accounts.google.com/o/oauth2/v2/auth",
        "https://accounts.google.com/o/oauth2/auth",
      ].includes(method.authorizationUrl) &&
        [
          "https://oauth2.googleapis.com/token",
          "https://accounts.google.com/o/oauth2/token",
        ].includes(method.tokenUrl) &&
        (method.issuer === undefined || method.issuer === "https://accounts.google.com");
};

export const oauthIdentityDefaults = (method: AuthMethod): AuthMethod =>
  method.type === "oauth2" &&
  method.grant !== "client_credentials" &&
  method.identity === undefined &&
  googleAuthorization(method)
    ? { ...method, identity: { issuer: "https://accounts.google.com", name: "Google" } }
    : method;

/**
 * Consent-only defaults keep stored declarations and their provider hashes unchanged.
 * UserInfo's stable subject and email label suffice for grouping; profile claims are optional.
 */
export const oauthIdentityConsent = (method: AuthMethod) =>
  method.type === "oauth2" &&
  method.grant !== "client_credentials" &&
  googleAuthorization(method) &&
  method.identity?.issuer === "https://accounts.google.com"
    ? {
        scopes: ["openid", "email"],
        authorizationParams: { include_granted_scopes: "true" },
      }
    : undefined;
