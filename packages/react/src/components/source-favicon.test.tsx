import { describe, expect, it } from "@effect/vitest";

import { sourceFaviconUrl, sourceLocalIconUrl, sourcePresetIconUrl } from "./source-favicon";

describe("SourceFavicon", () => {
  it("uses the favicon service that handles provider-specific icon locations", () => {
    expect(sourceFaviconUrl("https://api.github.com/graphql", 20)).toBe(
      "https://www.google.com/s2/favicons?domain=github.com&sz=40",
    );
  });

  it("does not request favicons for local URLs", () => {
    expect(sourceFaviconUrl("http://localhost:3000/private", 20)).toBeNull();
    expect(sourceFaviconUrl("http://127.0.0.1:3000/private", 20)).toBeNull();
  });

  it("sends only the registrable domain to the favicon service", () => {
    expect(sourceFaviconUrl("https://api.github.com/private", 20)).toBe(
      "https://www.google.com/s2/favicons?domain=github.com&sz=40",
    );
  });

  it("uses the Executor favicon for the built-in executor source", () => {
    expect(sourceLocalIconUrl("executor")).toBe("/favicon-32.png");
    expect(sourceLocalIconUrl("openapi")).toBeNull();
  });

  it("finds preset icons from a source URL", () => {
    expect(
      sourcePresetIconUrl(
        {
          id: "google_sheets",
          kind: "googleDiscovery",
          name: "Google Sheets API",
          url: "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
        },
        [
          {
            key: "googleDiscovery",
            label: "Google Discovery",
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
      sourcePresetIconUrl(
        {
          id: "google_search_console_api",
          kind: "googleDiscovery",
          name: "Google Search Console API",
        },
        [
          {
            key: "googleDiscovery",
            label: "Google Discovery",
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
      sourcePresetIconUrl(
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
});
