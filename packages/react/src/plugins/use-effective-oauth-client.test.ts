import { describe, expect, it } from "@effect/vitest";
import { OAuthClientSlug, type Owner } from "@executor-js/sdk/shared";

import {
  selectClientsForEndpoints,
  uniqueClientSlug,
  type OAuthClientOption,
} from "./use-effective-oauth-client";

const app = (
  slug: string,
  opts: {
    readonly owner?: Owner;
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
  },
): OAuthClientOption => ({
  owner: opts.owner ?? "user",
  slug: OAuthClientSlug.make(slug),
  grant: "authorization_code",
  authorizationUrl: opts.authorizationUrl,
  tokenUrl: opts.tokenUrl,
  clientId: "client-id",
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
