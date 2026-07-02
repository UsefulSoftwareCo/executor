import { describe, expect, it } from "@effect/vitest";
import { IntegrationSlug, OAuthClientSlug, type Owner } from "@executor-js/sdk/shared";
import type { OAuthClientOrigin } from "@executor-js/sdk/shared";

import {
  dcrClientSlug,
  selectClientsForEndpoints,
  selectDcrClientsForIntegration,
  uniqueClientSlug,
  type OAuthClientOption,
} from "./use-effective-oauth-client";

const app = (
  slug: string,
  opts: {
    readonly owner?: Owner;
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
    readonly origin?: OAuthClientOrigin;
  },
): OAuthClientOption => ({
  owner: opts.owner ?? "user",
  slug: OAuthClientSlug.make(slug),
  grant: "authorization_code",
  authorizationUrl: opts.authorizationUrl,
  tokenUrl: opts.tokenUrl,
  clientId: "client-id",
  origin: opts.origin ?? { kind: "manual" },
});

const google = app("google-app", {
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
});
const spotify = app("spotify-app", {
  authorizationUrl: "https://accounts.spotify.com/authorize",
  tokenUrl: "https://accounts.spotify.com/api/token",
});

describe("selectClientsForEndpoints", () => {
  it("excludes unrelated providers and reports no match (drives the register CTA)", () => {
    // Integration declares Google's split authorize/token roots; only the
    // Spotify app is registered → nothing matches.
    const result = selectClientsForEndpoints([spotify], {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
    });
    expect(result.endpointMatched).toBe(false);
    expect(result.matched).toEqual([]);
    expect(result.unmatched.map((a: OAuthClientOption) => String(a.slug))).toEqual(["spotify-app"]);
  });

  it("matches an app sharing a declared endpoint's registrable root domain", () => {
    // The app's token host `oauth2.googleapis.com` → root `googleapis.com`, which
    // is in the integration's union (it declares the same token URL).
    const result = selectClientsForEndpoints([google, spotify], {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
    });
    expect(result.endpointMatched).toBe(true);
    expect(result.matched.map((a: OAuthClientOption) => String(a.slug))).toEqual(["google-app"]);
    expect(result.unmatched.map((a: OAuthClientOption) => String(a.slug))).toEqual(["spotify-app"]);
  });

  it("matches on the authorize root even when the token endpoint differs", () => {
    // An app declaring only the authorize host on `google.com` matches an
    // integration that declares an authorize URL on the same root.
    const authorizeOnly = app("google-authorize", {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://accounts.google.com/token",
    });
    const result = selectClientsForEndpoints([authorizeOnly], {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    });
    expect(result.endpointMatched).toBe(true);
    expect(result.matched.map((a: OAuthClientOption) => String(a.slug))).toEqual([
      "google-authorize",
    ]);
  });

  it("does not match by authorize root alone when the integration declares a token endpoint", () => {
    const authorizeOnly = app("google-authorize", {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://accounts.google.com/token",
    });
    const result = selectClientsForEndpoints([authorizeOnly], {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
    });
    expect(result.endpointMatched).toBe(false);
    expect(result.matched).toEqual([]);
    expect(result.unmatched.map((a: OAuthClientOption) => String(a.slug))).toEqual([
      "google-authorize",
    ]);
  });

  it("treats every app as usable when no endpoint is declared", () => {
    const result = selectClientsForEndpoints([google, spotify], {});
    expect(result.endpointMatched).toBe(true);
    expect(result.matched).toHaveLength(2);
    expect(result.unmatched).toEqual([]);
  });

  it("with requireEndpointMatch and no endpoints, matches NOTHING (drives the register CTA)", () => {
    // A server-targeting integration (MCP, endpoints discovered at connect) must
    // not auto-select an unrelated provider's app just because nothing was
    // declared to filter on.
    const result = selectClientsForEndpoints([google, spotify], { requireEndpointMatch: true });
    expect(result.endpointMatched).toBe(false);
    expect(result.matched).toEqual([]);
    expect(result.unmatched.map((a: OAuthClientOption) => String(a.slug))).toEqual([
      "google-app",
      "spotify-app",
    ]);
  });

  it("matches local-dev MCP by exact host when tldts cannot resolve a root domain", () => {
    const local = app("local-mcp", {
      authorizationUrl: "http://localhost:8787/authorize",
      tokenUrl: "http://localhost:8787/token",
    });
    const result = selectClientsForEndpoints([local], {
      authorizationUrl: "http://localhost:8787/authorize",
      tokenUrl: "http://localhost:8787/token",
    });
    expect(result.endpointMatched).toBe(true);
    expect(result.matched.map((a: OAuthClientOption) => String(a.slug))).toEqual(["local-mcp"]);
  });

  it("sorts user-owned apps before workspace-owned ones", () => {
    const orgApp = app("org-google", {
      owner: "org",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
    });
    const result = selectClientsForEndpoints([orgApp, google], {
      tokenUrl: "https://oauth2.googleapis.com/token",
    });
    expect(result.matched.map((a: OAuthClientOption) => a.owner)).toEqual(["user", "org"]);
  });

  it("excludes DCR clients from the picker entirely (they are plumbing, not apps)", () => {
    // A DCR client minted against the integration's exact endpoint STILL must not
    // appear in the picker — it is reused automatically, never user-picked.
    const dcr = app("dcr-oauth2-googleapis-com", {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      origin: { kind: "dynamic_client_registration", integration: null },
    });
    const result = selectClientsForEndpoints([dcr, google], {
      tokenUrl: "https://oauth2.googleapis.com/token",
    });
    // Only the manual google-app survives into any tier; the DCR client is gone.
    expect(result.matched.map((a: OAuthClientOption) => String(a.slug))).toEqual(["google-app"]);
    expect(result.nearMatches).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  it("origin-integration (recorded intent) is a tier-1 match, beating a root-domain near-miss", () => {
    const integration = IntegrationSlug.make("cloudflare_api");
    // Registered from the Cloudflare API dialog: exact intent, even though its
    // OAuth host (dash.cloudflare.com) is not the declared api.cloudflare.com.
    const stamped = app("my-cloudflare-app", {
      authorizationUrl: "https://dash.cloudflare.com/oauth2/auth",
      tokenUrl: "https://dash.cloudflare.com/oauth2/token",
      origin: { kind: "manual", integration },
    });
    // Same root domain but different host and no intent stamp: a near-miss.
    const nearMiss = app("cloudflare-mcp-app", {
      authorizationUrl: "https://mcp.cloudflare.com/authorize",
      tokenUrl: "https://mcp.cloudflare.com/token",
    });
    const result = selectClientsForEndpoints([nearMiss, stamped], {
      tokenUrl: "https://api.cloudflare.com/client/v4/token",
      authorizationUrl: "https://api.cloudflare.com/client/v4/authorize",
      integration,
    });
    expect(result.endpointMatched).toBe(true);
    // Intent wins tier 1; the root-domain near-miss lands in tier 2, never mixed in.
    expect(result.matched.map((a: OAuthClientOption) => String(a.slug))).toEqual([
      "my-cloudflare-app",
    ]);
    expect(result.nearMatches.map((a: OAuthClientOption) => String(a.slug))).toEqual([
      "cloudflare-mcp-app",
    ]);
    expect(result.unmatched).toEqual([]);
  });

  it("a root-domain-only match lands in tier 2 (nearMatches), not tier 1", () => {
    // The declared endpoint is api.cloudflare.com; the app is on mcp.cloudflare.com.
    // Same registrable root (cloudflare.com), different host, no intent stamp: this
    // is exactly the bug case — it must NOT be presented as a real match.
    const nearMiss = app("cloudflare-mcp-app", {
      authorizationUrl: "https://mcp.cloudflare.com/authorize",
      tokenUrl: "https://mcp.cloudflare.com/token",
    });
    const result = selectClientsForEndpoints([nearMiss], {
      tokenUrl: "https://api.cloudflare.com/client/v4/token",
      authorizationUrl: "https://api.cloudflare.com/client/v4/authorize",
      integration: IntegrationSlug.make("cloudflare_api"),
    });
    expect(result.endpointMatched).toBe(false);
    expect(result.matched).toEqual([]);
    expect(result.nearMatches.map((a: OAuthClientOption) => String(a.slug))).toEqual([
      "cloudflare-mcp-app",
    ]);
    expect(result.unmatched).toEqual([]);
  });

  it("exact endpoint host is a tier-1 match even without an intent stamp", () => {
    const exact = app("cloudflare-api-app", {
      authorizationUrl: "https://api.cloudflare.com/client/v4/authorize",
      tokenUrl: "https://api.cloudflare.com/client/v4/token",
    });
    const result = selectClientsForEndpoints([exact], {
      tokenUrl: "https://api.cloudflare.com/client/v4/token",
      integration: IntegrationSlug.make("cloudflare_api"),
    });
    expect(result.endpointMatched).toBe(true);
    expect(result.matched.map((a: OAuthClientOption) => String(a.slug))).toEqual([
      "cloudflare-api-app",
    ]);
    expect(result.nearMatches).toEqual([]);
  });

  it("recorded intent matches even when the integration declares no endpoints (requireEndpointMatch)", () => {
    const integration = IntegrationSlug.make("linear_mcp");
    const stamped = app("linear-mcp-app", {
      authorizationUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      origin: { kind: "manual", integration },
    });
    const unrelated = app("spotify-app-2", {
      authorizationUrl: "https://accounts.spotify.com/authorize",
      tokenUrl: "https://accounts.spotify.com/api/token",
    });
    const result = selectClientsForEndpoints([unrelated, stamped], {
      requireEndpointMatch: true,
      integration,
    });
    expect(result.endpointMatched).toBe(true);
    expect(result.matched.map((a: OAuthClientOption) => String(a.slug))).toEqual([
      "linear-mcp-app",
    ]);
    expect(result.unmatched.map((a: OAuthClientOption) => String(a.slug))).toEqual([
      "spotify-app-2",
    ]);
  });
});

describe("selectDcrClientsForIntegration", () => {
  const integration = IntegrationSlug.make("linear_mcp");
  const dcrStamped = app("dcr-auth-linear-app", {
    authorizationUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    origin: { kind: "dynamic_client_registration", integration },
  });
  const dcrOtherProvider = app("dcr-mcp-cloudflare-com", {
    authorizationUrl: "https://mcp.cloudflare.com/authorize",
    tokenUrl: "https://mcp.cloudflare.com/token",
    origin: { kind: "dynamic_client_registration", integration: null },
  });
  const manualLinear = app("linear-manual", {
    authorizationUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    origin: { kind: "manual", integration },
  });

  it("returns only the DCR clients stamped with this integration", () => {
    const result = selectDcrClientsForIntegration([dcrStamped, dcrOtherProvider, manualLinear], {
      integration,
    });
    expect(result.map((a: OAuthClientOption) => String(a.slug))).toEqual(["dcr-auth-linear-app"]);
  });

  it("surfaces legacy unstamped DCR clients by root domain of the declared endpoint", () => {
    const legacyUnstamped = app("dcr-api-linear-app", {
      authorizationUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      origin: { kind: "dynamic_client_registration", integration: null },
    });
    const result = selectDcrClientsForIntegration([legacyUnstamped, dcrOtherProvider], {
      integration,
      tokenUrl: "https://api.linear.app/oauth/token",
    });
    expect(result.map((a: OAuthClientOption) => String(a.slug))).toEqual(["dcr-api-linear-app"]);
  });

  it("never returns manual apps", () => {
    const result = selectDcrClientsForIntegration([manualLinear], {
      integration,
      tokenUrl: "https://api.linear.app/oauth/token",
    });
    expect(result).toEqual([]);
  });
});

describe("uniqueClientSlug", () => {
  it("derives a slug from the name and dedupes against existing slugs", () => {
    expect(String(uniqueClientSlug("Linear MCP", []))).toBe("linear-mcp");
    expect(String(uniqueClientSlug("Linear MCP", ["linear-mcp"]))).toBe("linear-mcp-2");
    expect(String(uniqueClientSlug("Linear MCP", ["linear-mcp", "linear-mcp-2"]))).toBe(
      "linear-mcp-3",
    );
  });
});

describe("dcrClientSlug", () => {
  it("derives a deterministic DCR slug from the authorization server host", () => {
    expect(String(dcrClientSlug("https://mcp.cloudflare.com/register"))).toBe(
      "dcr-mcp-cloudflare-com",
    );
    expect(String(dcrClientSlug("http://127.0.0.1:8787/register"))).toBe("dcr-127-0-0-1-8787");
  });
});
