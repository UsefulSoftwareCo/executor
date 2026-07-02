import { describe, expect, it } from "@effect/vitest";

import { protectedResourceMetadataUrlFor, resourceUrlFor, toolkitSlugFromRequest } from "./auth";
import { classifyMcpPath, prepareMcpOrgScope } from "./mount";

describe("cloud MCP toolkit route normalization", () => {
  it("classifies toolkit MCP and protected-resource metadata paths", () => {
    expect(classifyMcpPath("/mcp/toolkits/deploy")).toEqual({
      kind: "mcp",
      organizationId: null,
      toolkitSlug: "deploy",
    });
    expect(classifyMcpPath("/acme/mcp/toolkits/deploy")).toEqual({
      kind: "mcp",
      organizationId: "acme",
      toolkitSlug: "deploy",
    });
    expect(classifyMcpPath("/.well-known/oauth-protected-resource/mcp/toolkits/deploy")).toEqual({
      kind: "oauth-protected-resource",
      organizationId: null,
      toolkitSlug: "deploy",
    });
    expect(
      classifyMcpPath("/.well-known/oauth-protected-resource/acme/mcp/toolkits/deploy"),
    ).toEqual({
      kind: "oauth-protected-resource",
      organizationId: "acme",
      toolkitSlug: "deploy",
    });
  });

  it("rewrites org-scoped toolkit metadata to the mounted toolkit metadata route", () => {
    const request = new Request(
      "https://executor.sh/.well-known/oauth-protected-resource/acme/mcp/toolkits/deploy?x=1",
      { headers: { "x-executor-mcp-organization": "spoofed" } },
    );

    const rewritten = prepareMcpOrgScope(request);
    const url = new URL(rewritten.url);

    expect(url.pathname).toBe("/.well-known/oauth-protected-resource/mcp/toolkits/deploy");
    expect(url.search).toBe("?x=1");
    expect(rewritten.headers.get("x-executor-mcp-organization")).toBe("acme");
    expect(toolkitSlugFromRequest(rewritten)).toBe("deploy");
  });

  it("builds toolkit-specific resource and metadata URLs", () => {
    expect(resourceUrlFor(null, "deploy")).toBe("https://executor.sh/mcp/toolkits/deploy");
    expect(resourceUrlFor("acme", "deploy")).toBe("https://executor.sh/acme/mcp/toolkits/deploy");
    expect(protectedResourceMetadataUrlFor(null, "deploy")).toBe(
      "https://executor.sh/.well-known/oauth-protected-resource/mcp/toolkits/deploy",
    );
    expect(protectedResourceMetadataUrlFor("acme", "deploy")).toBe(
      "https://executor.sh/.well-known/oauth-protected-resource/acme/mcp/toolkits/deploy",
    );
  });
});
