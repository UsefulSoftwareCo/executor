import { describe, expect, it } from "@effect/vitest";

import { isScopedMcpPath, resolveMcpOrgPath } from "./org-path";

const organization = { id: "iI9idP7BZcWpg9wW8cit3xE4r4dFSnHj", slug: "real-team" };

describe("resolveMcpOrgPath", () => {
  it("strips only the live organization id or slug before /mcp", () => {
    expect(resolveMcpOrgPath(`/${organization.id}/mcp`, organization)).toEqual({
      kind: "rewrite",
      pathname: "/mcp",
    });
    expect(resolveMcpOrgPath(`/${organization.slug}/mcp`, organization)).toEqual({
      kind: "rewrite",
      pathname: "/mcp",
    });
    expect(resolveMcpOrgPath(`/${organization.slug}/mcp/toolkits/deploy`, organization)).toEqual({
      kind: "rewrite",
      pathname: "/mcp/toolkits/deploy",
    });
  });

  it("strips a valid scope from the protected-resource discovery path", () => {
    expect(
      resolveMcpOrgPath(
        `/.well-known/oauth-protected-resource/${organization.id}/mcp`,
        organization,
      ),
    ).toEqual({ kind: "rewrite", pathname: "/.well-known/oauth-protected-resource" });
    expect(
      resolveMcpOrgPath(
        `/.well-known/oauth-protected-resource/${organization.slug}/mcp/toolkits/deploy`,
        organization,
      ),
    ).toEqual({
      kind: "rewrite",
      pathname: "/.well-known/oauth-protected-resource/mcp/toolkits/deploy",
    });
  });

  it("rejects foreign organization prefixes", () => {
    expect(resolveMcpOrgPath("/not-this-team/mcp", organization)).toEqual({ kind: "reject" });
    expect(
      resolveMcpOrgPath("/.well-known/oauth-protected-resource/not-this-team/mcp", organization),
    ).toEqual({ kind: "reject" });
  });

  it("leaves bare, OAuth, and unrelated paths untouched", () => {
    for (const path of [
      "/mcp",
      "/mcp/toolkits/deploy",
      "/.well-known/oauth-authorization-server",
      "/api/auth/mcp/authorize",
      "/api/auth/mcp/register",
      "/integrations",
      "/",
      "/a/b/mcp",
    ]) {
      expect(resolveMcpOrgPath(path, organization)).toEqual({ kind: "none" });
    }
  });
});

describe("isScopedMcpPath", () => {
  it("identifies paths the dev proxy must forward for live validation", () => {
    expect(isScopedMcpPath(`/${organization.id}/mcp`)).toBe(true);
    expect(isScopedMcpPath("/not-this-team/mcp")).toBe(true);
    expect(isScopedMcpPath("/mcp")).toBe(false);
    expect(isScopedMcpPath("/mcp-consent")).toBe(false);
  });
});
