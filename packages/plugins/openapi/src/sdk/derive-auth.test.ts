import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { detectedAuthenticationTemplates, resolvedOAuthScopes } from "./derive-auth";
import { OAuth2Preset } from "./preview";

describe("resolvedOAuthScopes", () => {
  it("does not synthesize OIDC scopes for a plain OAuth provider", () => {
    expect(resolvedOAuthScopes(["current_user:read", "files:read"], "auto")).toEqual([
      "current_user:read",
      "files:read",
    ]);
  });

  it("preserves advertised OIDC scopes in auto mode", () => {
    expect(resolvedOAuthScopes(["read", "openid", "profile"], "auto")).toEqual([
      "read",
      "openid",
      "profile",
    ]);
  });

  it("merges explicitly configured identity scopes", () => {
    expect(resolvedOAuthScopes(["read", "email"], ["openid", "email"])).toEqual([
      "read",
      "email",
      "openid",
    ]);
  });
});

const oauth2Preset = (
  securitySchemeName: string,
  flow: "authorizationCode" | "clientCredentials",
) =>
  OAuth2Preset.make({
    label: `OAuth2 ${flow === "authorizationCode" ? "Authorization Code" : "Client Credentials"} · ${securitySchemeName}`,
    securitySchemeName,
    flow,
    authorizationUrl:
      flow === "authorizationCode" ? Option.some("https://example.com/auth") : Option.none(),
    tokenUrl: "https://example.com/token",
    resource: Option.none(),
    refreshUrl: Option.none(),
    scopes: { read: "Read access" },
    identityScopes: "auto",
  });

describe("detectedAuthenticationTemplates", () => {
  it("stores no label for a lone oauth2 method", () => {
    const templates = detectedAuthenticationTemplates(
      [],
      [oauth2Preset("oauth_app", "authorizationCode")],
      "https://example.com",
    );
    expect(templates).toHaveLength(1);
    expect(templates[0]).not.toHaveProperty("label");
  });

  it("labels each oauth2 method from its preset when several are detected", () => {
    const templates = detectedAuthenticationTemplates(
      [],
      [
        oauth2Preset("oauth_app", "authorizationCode"),
        oauth2Preset("oauth_app", "clientCredentials"),
      ],
      "https://example.com",
    );
    expect(
      templates.map((template) => (template.kind === "oauth2" ? template.label : null)),
    ).toEqual(["OAuth2 Authorization Code · oauth_app", "OAuth2 Client Credentials · oauth_app"]);
  });
});
