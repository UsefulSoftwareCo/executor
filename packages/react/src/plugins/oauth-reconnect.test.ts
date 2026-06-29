import { describe, expect, it } from "@effect/vitest";
import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderKey,
  type Connection,
} from "@executor-js/sdk/shared";

import {
  missingScopes,
  oauthReconnectPayload,
  reconnectMode,
  reconsentRequiredScopes,
} from "./oauth-reconnect";

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  owner: "user",
  name: ConnectionName.make("personal-github"),
  integration: IntegrationSlug.make("github"),
  template: AuthTemplateSlug.make("oauth"),
  provider: ProviderKey.make("default"),
  address: ConnectionAddress.make("tools.github.user.personal-github"),
  identityLabel: "Personal GitHub",
  expiresAt: 123,
  oauthClient: OAuthClientSlug.make("github-app"),
  ...overrides,
});

describe("reconnectMode (OAuth vs non-OAuth branch)", () => {
  // The single field `oauthClient` decides the path: OAuth connections must
  // re-consent (a refresh cannot widen scopes / fails with no refresh token).
  it("returns 'oauth' when the connection carries an oauthClient slug", () => {
    expect(reconnectMode(connection())).toBe("oauth");
  });

  it("returns 'refresh' when oauthClient is null (static credential)", () => {
    expect(reconnectMode(connection({ oauthClient: null }))).toBe("refresh");
  });

  it("returns 'refresh' when oauthClient is absent", () => {
    const { oauthClient: _drop, ...rest } = connection();
    expect(reconnectMode(rest as Connection)).toBe("refresh");
  });
});

describe("oauthReconnectPayload (re-mint the SAME connection)", () => {
  // The payload re-runs oauth.start with the SAME owner/integration/name so the
  // backend mint upserts the existing row (widened union + fresh refresh token).
  it("builds the start payload from an OAuth connection's own fields", () => {
    const payload = oauthReconnectPayload(connection());
    expect(payload).not.toBeNull();
    expect(payload!.client).toBe(OAuthClientSlug.make("github-app"));
    expect(payload!.owner).toBe("user");
    expect(payload!.name).toBe(ConnectionName.make("personal-github"));
    expect(payload!.integration).toBe(IntegrationSlug.make("github"));
    expect(payload!.template).toBe(AuthTemplateSlug.make("oauth"));
    expect(payload!.identityLabel).toBe("Personal GitHub");
  });

  it("maps a null identityLabel to undefined (optional payload field)", () => {
    const payload = oauthReconnectPayload(connection({ identityLabel: null }));
    expect(payload!.identityLabel).toBeUndefined();
  });

  it("returns null for a non-OAuth connection (no oauthClient)", () => {
    expect(oauthReconnectPayload(connection({ oauthClient: null }))).toBeNull();
  });
});

describe("missingScopes (Part 2 informational subset warning)", () => {
  // The app's scopes are a STRICT subset of the integration's → list what's
  // missing, in the integration's declared order.
  it("lists scopes the integration declares that the app does not grant", () => {
    expect(missingScopes(["a", "b", "c"], ["a"])).toEqual(["b", "c"]);
  });

  it("is empty when the app covers everything the integration declares", () => {
    expect(missingScopes(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("is empty when the app is a SUPERSET of the integration's scopes", () => {
    expect(missingScopes(["a"], ["a", "b", "c"])).toEqual([]);
  });

  it("is empty when the integration declares no scopes", () => {
    expect(missingScopes(undefined, ["a"])).toEqual([]);
    expect(missingScopes([], ["a"])).toEqual([]);
  });

  it("treats undefined/empty client scopes as granting nothing", () => {
    expect(missingScopes(["a", "b"], undefined)).toEqual(["a", "b"]);
    expect(missingScopes(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("normalizes whitespace and dedupes before comparing (sets, not lists)", () => {
    expect(missingScopes([" a ", "a", "b", ""], ["a"])).toEqual(["b"]);
    expect(missingScopes(["a", "b"], [" a ", "a", ""])).toEqual(["b"]);
  });

  it("treats Google's expanded userinfo scopes as OIDC profile/email grants", () => {
    expect(
      missingScopes(
        ["profile", "email", "https://www.googleapis.com/auth/calendar"],
        [
          "https://www.googleapis.com/auth/userinfo.profile",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/calendar",
          "openid",
        ],
      ),
    ).toEqual([]);
  });
});

describe("reconsentRequiredScopes", () => {
  it("treats spec-derived oauth scopes as NOT required (opportunistic catalog)", () => {
    // An OpenAPI source (e.g. PostHog) declares the full per-operation scope
    // catalog. A narrower grant is healthy and must not nag for reconnect.
    expect(
      reconsentRequiredScopes({
        source: "spec",
        oauth: { scopes: ["insight:read", "insight:write", "person:read"] },
      }),
    ).toBeUndefined();
  });

  it("keeps custom (user-configured) oauth scopes required", () => {
    expect(
      reconsentRequiredScopes({
        source: "custom",
        oauth: { scopes: ["read", "write"] },
      }),
    ).toEqual(["read", "write"]);
  });

  it("returns undefined when there is no oauth method", () => {
    expect(reconsentRequiredScopes(undefined)).toBeUndefined();
  });
});
