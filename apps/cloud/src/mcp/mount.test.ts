import { describe, expect, it } from "@effect/vitest";

import { mcpResourceFromRequest, protectedResourceMetadataUrlFor, resourceUrlFor } from "./auth";
import { classifyMcpPath, prepareMcpOrgScope } from "./mount";

describe("cloud MCP scoped route normalization", () => {
  it("classifies scoped MCP and protected-resource metadata paths", () => {
    expect(classifyMcpPath("/mcp")).toEqual({
      kind: "mcp",
      organizationId: null,
      resource: { kind: "default" },
    });
    expect(classifyMcpPath("/mcp/toolkits/deploy")).toEqual({
      kind: "mcp",
      organizationId: null,
      resource: { kind: "toolkit", slug: "deploy" },
    });
    expect(classifyMcpPath("/acme/mcp/toolkits/deploy")).toEqual({
      kind: "mcp",
      organizationId: "acme",
      resource: { kind: "toolkit", slug: "deploy" },
    });
    expect(classifyMcpPath("/acme/mcp/integrations/github,linear")).toEqual({
      kind: "mcp",
      organizationId: "acme",
      resource: { kind: "integrations", slugs: ["github", "linear"] },
    });
    expect(classifyMcpPath("/mcp/tools/github.repos.list")).toEqual({
      kind: "mcp",
      organizationId: null,
      resource: { kind: "tool", toolId: "github.repos.list" },
    });
    expect(classifyMcpPath("/.well-known/oauth-protected-resource/mcp/toolkits/deploy")).toEqual({
      kind: "oauth-protected-resource",
      organizationId: null,
      resource: { kind: "toolkit", slug: "deploy" },
    });
    expect(
      classifyMcpPath("/.well-known/oauth-protected-resource/acme/mcp/toolkits/deploy"),
    ).toEqual({
      kind: "oauth-protected-resource",
      organizationId: "acme",
      resource: { kind: "toolkit", slug: "deploy" },
    });
    expect(classifyMcpPath("/mcp/unknown/x")).toBeNull();
    expect(classifyMcpPath("/mcp/toolkits")).toBeNull();
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
    expect(mcpResourceFromRequest(rewritten)).toEqual({ kind: "toolkit", slug: "deploy" });
  });

  it("rewrites an org-scoped integrations endpoint to the bare scoped path", () => {
    const rewritten = prepareMcpOrgScope(
      new Request("https://executor.sh/acme/mcp/integrations/github,linear"),
    );
    expect(new URL(rewritten.url).pathname).toBe("/mcp/integrations/github,linear");
    expect(rewritten.headers.get("x-executor-mcp-organization")).toBe("acme");
    expect(mcpResourceFromRequest(rewritten)).toEqual({
      kind: "integrations",
      slugs: ["github", "linear"],
    });
  });

  it("builds scoped resource and metadata URLs", () => {
    const toolkit = { kind: "toolkit", slug: "deploy" } as const;
    expect(resourceUrlFor(null, toolkit)).toBe("https://executor.sh/mcp/toolkits/deploy");
    expect(resourceUrlFor("acme", toolkit)).toBe("https://executor.sh/acme/mcp/toolkits/deploy");
    expect(protectedResourceMetadataUrlFor(null, toolkit)).toBe(
      "https://executor.sh/.well-known/oauth-protected-resource/mcp/toolkits/deploy",
    );
    expect(protectedResourceMetadataUrlFor("acme", toolkit)).toBe(
      "https://executor.sh/.well-known/oauth-protected-resource/acme/mcp/toolkits/deploy",
    );
    expect(resourceUrlFor("acme", { kind: "tool", toolId: "github.repos.list" })).toBe(
      "https://executor.sh/acme/mcp/tools/github.repos.list",
    );
  });
});
