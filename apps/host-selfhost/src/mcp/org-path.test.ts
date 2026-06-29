import { describe, expect, it } from "@effect/vitest";

import { stripMcpOrgSegment } from "./org-path";

describe("stripMcpOrgSegment", () => {
  it("strips a single org segment before /mcp", () => {
    expect(stripMcpOrgSegment("/iI9idP7BZcWpg9wW8cit3xE4r4dFSnHj/mcp")).toBe("/mcp");
    expect(stripMcpOrgSegment("/org_123/mcp")).toBe("/mcp");
    expect(stripMcpOrgSegment("/org_123/mcp/toolkits/deploy")).toBe("/mcp/toolkits/deploy");
  });

  it("strips the org segment from the protected-resource discovery path", () => {
    expect(stripMcpOrgSegment("/.well-known/oauth-protected-resource/abc123/mcp")).toBe(
      "/.well-known/oauth-protected-resource",
    );
    expect(
      stripMcpOrgSegment("/.well-known/oauth-protected-resource/abc123/mcp/toolkits/deploy"),
    ).toBe("/.well-known/oauth-protected-resource/mcp/toolkits/deploy");
  });

  it("leaves the bare paths untouched", () => {
    expect(stripMcpOrgSegment("/mcp")).toBeNull();
    expect(stripMcpOrgSegment("/mcp/toolkits/deploy")).toBeNull();
    expect(stripMcpOrgSegment("/.well-known/oauth-authorization-server")).toBeNull();
  });

  it("never claims OAuth endpoints or unrelated paths", () => {
    expect(stripMcpOrgSegment("/api/auth/mcp/authorize")).toBeNull();
    expect(stripMcpOrgSegment("/api/auth/mcp/register")).toBeNull();
    expect(stripMcpOrgSegment("/integrations")).toBeNull();
    expect(stripMcpOrgSegment("/")).toBeNull();
    expect(stripMcpOrgSegment("/a/b/mcp")).toBeNull(); // deeper than one segment
  });
});
