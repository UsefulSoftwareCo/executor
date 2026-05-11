import { describe, expect, it } from "@effect/vitest";

import { sourceFaviconUrl } from "./source-favicon";

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
});
