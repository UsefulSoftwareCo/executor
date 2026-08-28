import { describe, expect, it } from "@effect/vitest";

import {
  integrationFaviconSrc,
  integrationFaviconUrl,
  integrationInferredUrl,
  integrationLocalIconUrl,
  integrationPresetIconUrl,
} from "./integration-favicon";

describe("IntegrationFavicon", () => {
  it("resolves favicons only through the integrations.sh logo proxy", () => {
    expect(integrationFaviconUrl("https://api.github.com/graphql", 20)).toBe(
      "https://integrations.sh/logo/github.com?sz=40",
    );
  });

  it("does not request favicons for local URLs", () => {
    expect(integrationFaviconUrl("http://localhost:3000/private", 20)).toBeNull();
    expect(integrationFaviconUrl("http://127.0.0.1:3000/private", 20)).toBeNull();
  });

  it("sends only the registrable domain to the logo proxy", () => {
    expect(integrationFaviconUrl("https://api.github.com/private", 20)).toBe(
      "https://integrations.sh/logo/github.com?sz=40",
    );
  });

  it("falls through to the placeholder when the proxy fails", () => {
    const url = "https://api.github.com/graphql";
    const primary = integrationFaviconSrc({ url, size: 20 });
    expect(primary).toBe("https://integrations.sh/logo/github.com?sz=40");
    expect(integrationFaviconSrc({ url, size: 20, failedSrcs: [primary ?? ""] })).toBeNull();
  });

  it("uses the Executor favicon for the built-in executor integration", () => {
    expect(integrationLocalIconUrl("executor")).toBe("/favicon-32.png");
    expect(integrationLocalIconUrl("openapi")).toBeNull();
  });

  it("resolves the Executor sidebar icon only when the integration id is threaded (cloud/self-host repro)", () => {
    // Reconstruct the props the multiplayer shell derives for the built-in
    // executor integration (EXECUTOR_INTEGRATION: kind "built-in", name "Executor", no
    // displayUrl). The sidebar's IntegrationList builds icon/url exactly this way.
    const slug = "executor";
    const name = "Executor";
    const icon = integrationPresetIconUrl({ id: slug, kind: "built-in", name, url: undefined }, []);
    const url = integrationInferredUrl({ id: slug, name }) ?? undefined;

    // The built-in integration matches no preset and has no inferable host, so the
    // integrationId branch is the only thing that can resolve its icon.
    expect(icon).toBeNull();
    expect(url).toBeUndefined();

    // Bug: cloud/self-host dropped integrationId, so the cascade fell through to null
    // and rendered the neutral BoxIcon placeholder.
    expect(integrationFaviconSrc({ icon, url, size: 16 })).toBeNull();

    // Fix: threading integrationId resolves the bundled Executor favicon.
    expect(integrationFaviconSrc({ icon, integrationId: slug, url, size: 16 })).toBe(
      "/favicon-32.png",
    );
  });

  it("finds preset icons from an integration URL", () => {
    expect(
      integrationPresetIconUrl(
        {
          id: "google_sheets",
          kind: "googleDiscovery",
          name: "Google Sheets API",
          url: "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
        },
        [
          {
            key: "google",
            label: "Google",
            add: () => null,
            edit: () => null,
            presets: [
              {
                id: "google-sheets",
                name: "Google Sheets",
                summary: "Spreadsheets.",
                url: "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
                icon: "https://example.com/sheets.svg",
              },
            ],
          },
        ],
      ),
    ).toBe("https://example.com/sheets.svg");
  });

  it("does not fuzzy-match preset icons from names or slugs", () => {
    // Name/slug token matching is gone: without an exact defaultSlug or URL
    // match, the preset matcher declines and the cascade resolves through the
    // integrations.sh favicon instead, which is derived from the integration's
    // own domain and therefore cannot render the wrong brand.
    const presets = [
      {
        key: "mcp",
        label: "MCP",
        add: () => null,
        edit: () => null,
        presets: [
          {
            id: "sentry",
            name: "Sentry",
            summary: "Errors.",
            icon: "https://example.com/sentry.png",
          },
        ],
      },
    ];

    expect(
      integrationPresetIconUrl({ id: "sentry", kind: "mcp", name: "Sentry MCP" }, presets),
    ).toBeNull();

    // Migrated host-shaped integrations resolve through the inferred URL:
    const inferred = integrationInferredUrl({ id: "mcp_posthog_com", name: "mcp.posthog.com" });
    expect(inferred).toBe("https://mcp.posthog.com");
    expect(integrationFaviconSrc({ url: inferred ?? undefined, size: 16 })).toBe(
      "https://integrations.sh/logo/posthog.com?sz=32",
    );
  });

  it("prefers exact catalog defaultSlug icons for OpenAPI provider services", () => {
    expect(
      integrationPresetIconUrl({ id: "google_gmail", kind: "openapi", name: "Gmail" }, [
        {
          key: "openapi",
          label: "OpenAPI",
          add: () => null,
          edit: () => null,
          presets: [
            {
              id: "google-gmail",
              name: "Gmail",
              summary: "Messages.",
              defaultSlug: "google_gmail",
              icon: "https://example.com/gmail.png",
            },
          ],
        },
      ]),
    ).toBe("https://example.com/gmail.png");
  });

  it("matches presets on exact URL equality, not names", () => {
    const presets = [
      {
        key: "openapi",
        label: "OpenAPI",
        add: () => null,
        edit: () => null,
        presets: [
          {
            id: "spotify",
            name: "Spotify",
            summary: "Music.",
            url: "https://api.spotify.com/v1",
            icon: "https://example.com/spotify.png",
          },
        ],
      },
    ];

    expect(
      integrationPresetIconUrl(
        {
          id: "spotify_web_api",
          kind: "openapi",
          name: "Spotify Web API",
          url: "https://api.spotify.com/v1",
        },
        presets,
      ),
    ).toBe("https://example.com/spotify.png");

    // Same name, different URL: no match — the URL-derived favicon takes over.
    expect(
      integrationPresetIconUrl(
        {
          id: "spotify_web_api",
          kind: "openapi",
          name: "Spotify Web API",
          url: "https://api.spotify.com/v2",
        },
        presets,
      ),
    ).toBeNull();
  });

  it("does not match a different brand sharing a word fragment (ClickHouse Cloud vs Cloudflare)", () => {
    expect(
      integrationPresetIconUrl({ id: "clickhouse", kind: "mcp", name: "ClickHouse Cloud" }, [
        {
          key: "mcp",
          label: "MCP",
          add: () => null,
          edit: () => null,
          presets: [
            {
              id: "cloudflare",
              name: "Cloudflare",
              summary: "Workers, KV, D1, R2, and DNS management via MCP.",
              icon: "https://integrations.sh/logo/cloudflare.com",
            },
          ],
        },
      ]),
    ).toBeNull();
  });

  it("infers favicon URLs from migrated host-shaped MCP names and slugs", () => {
    expect(integrationInferredUrl({ id: "mcp_posthog_com", name: "mcp.posthog.com" })).toBe(
      "https://mcp.posthog.com",
    );
    expect(integrationInferredUrl({ id: "ai_todoist_net", name: "ai.todoist.net" })).toBe(
      "https://ai.todoist.net",
    );
    expect(integrationInferredUrl({ id: "mcp_pscale_dev", name: "mcp.pscale.dev" })).toBe(
      "https://mcp.pscale.dev",
    );
    expect(integrationInferredUrl({ id: "stripe_api", name: "Stripe API" })).toBeNull();
  });
});
