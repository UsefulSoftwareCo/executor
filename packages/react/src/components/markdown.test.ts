import { describe, expect, it } from "@effect/vitest";

import { sanitizeMarkdownUrl } from "./markdown";

describe("sanitizeMarkdownUrl", () => {
  it("allows regular web links", () => {
    expect(sanitizeMarkdownUrl("https://example.test/path?q=1")).toBe(
      "https://example.test/path?q=1",
    );
  });

  it("removes unsupported link targets", () => {
    expect(sanitizeMarkdownUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeMarkdownUrl("data:text/html,hello")).toBeNull();
    expect(sanitizeMarkdownUrl("//example.test/path")).toBeNull();
    expect(sanitizeMarkdownUrl("/local/path")).toBeNull();
  });
});
