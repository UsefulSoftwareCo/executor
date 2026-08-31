import { describe, expect, it } from "@effect/vitest";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Option from "effect/Option";
import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderKey,
  type Connection,
  type OAuthClientSummary,
} from "@executor-js/sdk/shared";

import {
  missingScopes,
  oauthReconnectPayload,
  reconnectClientsView,
  reconnectMode,
  reconnectRoute,
  reconnectStoredClient,
  reconsentRequiredScopes,
  retryReconnectClientsOnMenuOpen,
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

const clientSummary = (overrides: Partial<OAuthClientSummary> = {}): OAuthClientSummary => ({
  owner: "user",
  slug: OAuthClientSlug.make("github-app"),
  grant: "authorization_code",
  authorizationUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  resource: null,
  clientId: "client-123",
  origin: { kind: "manual", integration: null },
  ...overrides,
});

describe("reconnectStoredClient (resolve a connection's stored app)", () => {
  it("finds the stored row by slug and the app's stored owner", () => {
    const stored = clientSummary();
    expect(reconnectStoredClient([clientSummary({ owner: "org" }), stored], connection())).toBe(
      stored,
    );
  });

  it("matches against oauthClientOwner when the app is shared (org app, user connection)", () => {
    const shared = clientSummary({ owner: "org" });
    expect(reconnectStoredClient([shared], connection({ oauthClientOwner: "org" }))).toBe(shared);
    // Without the stored app owner, the connection's own owner is the key.
    expect(reconnectStoredClient([shared], connection())).toBeUndefined();
  });

  it("matches a first-party app on slug alone (config-declared, deployment-scoped)", () => {
    const firstParty = clientSummary({
      owner: "org",
      slug: OAuthClientSlug.make("first-party:github"),
      origin: { kind: "first_party" },
    });
    expect(
      reconnectStoredClient(
        [firstParty],
        connection({ oauthClient: OAuthClientSlug.make("first-party:github") }),
      ),
    ).toBe(firstParty);
  });

  it("is undefined for a non-OAuth connection and for a binding whose row is gone", () => {
    expect(
      reconnectStoredClient([clientSummary()], connection({ oauthClient: null })),
    ).toBeUndefined();
    expect(reconnectStoredClient([], connection())).toBeUndefined();
  });
});

describe("reconnectRoute (where an OAuth Reconnect goes)", () => {
  const dcrBinding = clientSummary({
    origin: { kind: "dynamic_client_registration", integration: null },
  });

  // The summaries have not loaded → the stored binding is UNKNOWN, and no
  // route may be chosen. The old routing chose "direct" here, permanently
  // dead-ending an origin-drifted DCR client exactly as #1542 described.
  it("waits (never chooses direct) while the client summaries are loading", () => {
    expect(reconnectRoute(undefined, connection(), true)).toEqual({ kind: "unknown" });
    expect(reconnectRoute(undefined, connection(), false)).toEqual({ kind: "unknown" });
  });

  // The BINDING's origin routes, not the method's capability flags: the
  // automatic flow can probe the token URL even when the method declares no
  // discovery/DCR support.
  it("routes a DCR-origin binding to the automatic path regardless of method capability", () => {
    expect(reconnectRoute([dcrBinding], connection(), false)).toEqual({
      kind: "automatic",
      stored: dcrBinding,
    });
    expect(reconnectRoute([dcrBinding], connection(), true)).toEqual({
      kind: "automatic",
      stored: dcrBinding,
    });
  });

  // A manual (static/BYO) or first-party binding must keep the direct
  // stored-client path — re-registering would silently rebind the connection.
  it("keeps a manual (static/BYO) binding on the direct path even on a capable method", () => {
    expect(reconnectRoute([clientSummary()], connection(), true)).toEqual({ kind: "direct" });
  });

  it("keeps a first-party binding on the direct path", () => {
    expect(
      reconnectRoute([clientSummary({ origin: { kind: "first_party" } })], connection(), true),
    ).toEqual({ kind: "direct" });
  });

  // A binding whose row is GONE has nothing to start directly against, so
  // re-registration is its only recovery — when the method supports the
  // automatic flow at all.
  it("re-registers a gone binding when the method supports the automatic flow", () => {
    expect(reconnectRoute([], connection(), true)).toEqual({
      kind: "automatic",
      stored: undefined,
    });
    expect(reconnectRoute([], connection(), false)).toEqual({ kind: "direct" });
  });
});

describe("reconnectClientsView (Reconnect availability from the summaries query)", () => {
  const dcrBinding = clientSummary({
    origin: { kind: "dynamic_client_registration", integration: null },
  });
  const loaded = AsyncResult.success<readonly OAuthClientSummary[], string>([dcrBinding]);

  it("is ready with the loaded summaries on success", () => {
    expect(reconnectClientsView(loaded)).toEqual({ kind: "ready", clients: [dcrBinding] });
  });

  // Stale data NEVER routes: a binding changed since the retained snapshot can
  // misroute (repeat the origin-drift dead end, or treat a client absent from
  // the snapshot as vanished and rebind it). A failed refresh is failed even
  // with previousSuccess — disabled, surfaced, and retried on menu open like
  // any other failure.
  it("is failed when a refresh fails, even with previous successful data", () => {
    const failedRefresh = AsyncResult.fail("listClients failed", {
      previousSuccess: Option.some(loaded),
    });
    const view = reconnectClientsView(failedRefresh);
    expect(view).toEqual({ kind: "failed" });
    // The failed view recovers like any other: opening the menu retries.
    let calls = 0;
    retryReconnectClientsOnMenuOpen(true, view, () => calls++);
    expect(calls).toBe(1);
  });

  it("is loading while the first load is in flight", () => {
    expect(reconnectClientsView(AsyncResult.initial())).toEqual({ kind: "loading" });
    expect(reconnectClientsView(AsyncResult.initial(true))).toEqual({ kind: "loading" });
  });

  it("is failed for a first-load failure (never produced data)", () => {
    expect(reconnectClientsView(AsyncResult.fail("listClients failed"))).toEqual({
      kind: "failed",
    });
  });

  it("reads a failure that is retrying as loading, not failed", () => {
    expect(reconnectClientsView(AsyncResult.fail("listClients failed", { waiting: true }))).toEqual(
      { kind: "loading" },
    );
    // A retry in flight is loading even when previous data is retained.
    expect(
      reconnectClientsView(
        AsyncResult.fail("listClients failed", {
          waiting: true,
          previousSuccess: Option.some(loaded),
        }),
      ),
    ).toEqual({ kind: "loading" });
  });
});

describe("retryReconnectClientsOnMenuOpen (recovery for a failed summaries query)", () => {
  const counter = () => {
    let calls = 0;
    return { retry: () => calls++, calls: () => calls };
  };

  it("refetches when the menu OPENS on a failed view", () => {
    const spy = counter();
    retryReconnectClientsOnMenuOpen(true, { kind: "failed" }, spy.retry);
    expect(spy.calls()).toBe(1);
  });

  it("does not refetch on close, while loading, or with data", () => {
    const spy = counter();
    retryReconnectClientsOnMenuOpen(false, { kind: "failed" }, spy.retry);
    retryReconnectClientsOnMenuOpen(true, { kind: "loading" }, spy.retry);
    retryReconnectClientsOnMenuOpen(true, { kind: "ready", clients: [] }, spy.retry);
    expect(spy.calls()).toBe(0);
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
    // An OpenAPI integration (e.g. PostHog) declares the full per-operation scope
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
