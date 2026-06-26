import { describe, expect, it } from "@effect/vitest";

import {
  integrationFaviconSrc,
  integrationFaviconUrl,
  integrationInferredUrl,
  integrationLocalIconUrl,
  integrationPresetIconUrl,
} from "./integration-favicon";

describe("IntegrationFavicon", () => {
  it("uses the favicon service that handles provider-specific icon locations", () => {
    expect(integrationFaviconUrl("https://api.github.com/graphql", 20)).toBe(
      "https://www.google.com/s2/favicons?domain=github.com&sz=40",
    );
  });

  it("does not request favicons for local URLs", () => {
    expect(integrationFaviconUrl("http://localhost:3000/private", 20)).toBeNull();
    expect(integrationFaviconUrl("http://127.0.0.1:3000/private", 20)).toBeNull();
  });

  it("sends only the registrable domain to the favicon service", () => {
    expect(integrationFaviconUrl("https://api.github.com/private", 20)).toBe(
      "https://www.google.com/s2/favicons?domain=github.com&sz=40",
    );
  });

  it("uses the Executor favicon for the built-in executor source", () => {
    expect(integrationLocalIconUrl("executor")).toBe("/favicon-32.png");
    expect(integrationLocalIconUrl("openapi")).toBeNull();
  });

  it("resolves the Executor sidebar icon only when the source id is threaded (cloud/self-host repro)", () => {
    // Reconstruct the props the multiplayer shell derives for the built-in
    // executor source (EXECUTOR_SOURCE: kind "built-in", name "Executor", no
    // displayUrl). The sidebar's IntegrationList builds icon/url exactly this way.
    const slug = "executor";
    const name = "Executor";
    const icon = integrationPresetIconUrl({ id: slug, kind: "built-in", name, url: undefined }, []);
    const url = integrationInferredUrl({ id: slug, name }) ?? undefined;

    // The built-in source matches no preset and has no inferable host, so the
    // sourceId branch is the only thing that can resolve its icon.
    expect(icon).toBeNull();
    expect(url).toBeUndefined();

    // Bug: cloud/self-host dropped sourceId, so the cascade fell through to null
    // and rendered the neutral BoxIcon placeholder.
    expect(integrationFaviconSrc({ icon, url, size: 16 })).toBeNull();

    // Fix: threading sourceId resolves the bundled Executor favicon.
    expect(integrationFaviconSrc({ icon, sourceId: slug, url, size: 16 })).toBe("/favicon-32.png");
  });

  it("finds preset icons from a source URL", () => {
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

  it("finds preset icons from display names with suffixes", () => {
    expect(
      integrationPresetIconUrl(
        {
          id: "google_search_console_api",
          kind: "googleDiscovery",
          name: "Google Search Console API",
        },
        [
          {
            key: "google",
            label: "Google",
            add: () => null,
            edit: () => null,
            presets: [
              {
                id: "google-search-console",
                name: "Google Search Console",
                summary: "Search performance.",
                icon: "https://example.com/google.svg",
              },
            ],
          },
        ],
      ),
    ).toBe("https://example.com/google.svg");
  });

  it("finds preset icons from a source id when the URL is missing", () => {
    expect(
      integrationPresetIconUrl(
        {
          id: "sentry",
          kind: "mcp",
          name: "Sentry MCP",
        },
        [
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
        ],
      ),
    ).toBe("https://example.com/sentry.png");
  });

  it("matches migrated MCP slugs with host/suffix noise", () => {
    const presets = [
      {
        key: "mcp",
        label: "MCP",
        add: () => null,
        edit: () => null,
        presets: [
          {
            id: "posthog",
            name: "PostHog",
            summary: "Analytics.",
            icon: "https://example.com/posthog.png",
          },
          {
            id: "linear",
            name: "Linear",
            summary: "Issues.",
            icon: "https://example.com/linear.png",
          },
          {
            id: "planetscale",
            name: "PlanetScale",
            summary: "Databases.",
            icon: "https://example.com/pscale.png",
          },
        ],
      },
    ];

    expect(
      integrationPresetIconUrl(
        { id: "mcp_posthog_com", kind: "mcp", name: "mcp.posthog.com" },
        presets,
      ),
    ).toBe("https://example.com/posthog.png");
    expect(
      integrationPresetIconUrl(
        { id: "mcp_linear_app", kind: "mcp", name: "mcp.linear.app" },
        presets,
      ),
    ).toBe("https://example.com/linear.png");
    expect(
      integrationPresetIconUrl({ id: "pscale_mcp", kind: "mcp", name: "Pscale MCP" }, presets),
    ).toBe("https://example.com/pscale.png");
  });

  it("matches migrated OpenAPI slugs with API/REST suffixes", () => {
    expect(
      integrationPresetIconUrl({ id: "stripe_api", kind: "openapi", name: "Stripe API" }, [
        {
          key: "openapi",
          label: "OpenAPI",
          add: () => null,
          edit: () => null,
          presets: [
            {
              id: "stripe",
              name: "Stripe",
              summary: "Payments.",
              icon: "https://example.com/stripe.png",
            },
          ],
        },
      ]),
    ).toBe("https://example.com/stripe.png");
  });

  it("does not split generic words into brand matches", () => {
    expect(
      integrationPresetIconUrl(
        {
          id: "spotify_web_api",
          kind: "openapi",
          name: "Spotify Web API",
          url: "https://api.spotify.com/v1",
        },
        [
          {
            key: "openapi",
            label: "OpenAPI",
            add: () => null,
            edit: () => null,
            presets: [
              {
                id: "exa-websets",
                name: "Exa Websets",
                summary: "Web data.",
                icon: "https://example.com/exa.png",
              },
              {
                id: "spotify",
                name: "Spotify",
                summary: "Music.",
                icon: "https://example.com/spotify.png",
              },
            ],
          },
        ],
      ),
    ).toBe("https://example.com/spotify.png");
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
