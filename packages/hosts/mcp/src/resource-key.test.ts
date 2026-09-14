// ---------------------------------------------------------------------------
// The shared MCP resource grammar: one parser and one path builder every host
// routes through, plus the session key that keeps a reused `mcp-session-id`
// from crossing between resources.
//
// `mcpResourceKey` must never throw on a missing resource. Sessions persisted
// before scoped resources added the `resource` field deserialize with
// `resource: undefined`; owner validation keys the stored session's resource
// against the request's, so an unguarded `resource.kind` read there threw on
// every reconnect to a legacy session. A missing resource is a default `/mcp`
// session, so it must key to "default".
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";

import {
  defaultMcpResource,
  mcpResourceFromPathname,
  mcpResourceKey,
  mcpResourcePath,
} from "./index";

describe("mcpResourceKey", () => {
  it('keys the default resource to "default"', () => {
    expect(mcpResourceKey(defaultMcpResource)).toBe("default");
    expect(mcpResourceKey({ kind: "default" })).toBe("default");
  });

  it("keys each scoped resource distinctly", () => {
    expect(mcpResourceKey({ kind: "toolkit", slug: "github" })).toBe("toolkit:github");
    expect(mcpResourceKey({ kind: "integrations", slugs: ["github", "linear"] })).toBe(
      "integrations:github,linear",
    );
    expect(mcpResourceKey({ kind: "tool", toolId: "github.repos.list" })).toBe(
      "tool:github.repos.list",
    );
  });

  it("treats a missing resource (legacy session meta) as the default key", () => {
    expect(mcpResourceKey(undefined)).toBe("default");
    expect(mcpResourceKey(null)).toBe("default");
  });

  it("matches a legacy (missing) resource against an explicit default resource", () => {
    // The exact comparison owner validation performs: a reconnect carries the
    // default resource, the stored legacy meta carries none, and they match.
    expect(mcpResourceKey(undefined)).toBe(mcpResourceKey(defaultMcpResource));
  });
});

describe("mcpResourceFromPathname", () => {
  it("parses the default endpoint, with or without a trailing slash", () => {
    expect(mcpResourceFromPathname("/mcp")).toEqual({ kind: "default" });
    expect(mcpResourceFromPathname("/mcp/")).toEqual({ kind: "default" });
  });

  it("parses each scoped sub-resource", () => {
    expect(mcpResourceFromPathname("/mcp/toolkits/deploy")).toEqual({
      kind: "toolkit",
      slug: "deploy",
    });
    expect(mcpResourceFromPathname("/mcp/integrations/github,linear")).toEqual({
      kind: "integrations",
      slugs: ["github", "linear"],
    });
    expect(mcpResourceFromPathname("/mcp/tools/github.org.main.repos.list")).toEqual({
      kind: "tool",
      toolId: "github.org.main.repos.list",
    });
  });

  it("decodes a percent-encoded value", () => {
    expect(mcpResourceFromPathname("/mcp/tools/github.org.main.repos%2Elist")).toEqual({
      kind: "tool",
      toolId: "github.org.main.repos.list",
    });
  });

  it("rejects anything outside the grammar", () => {
    expect(mcpResourceFromPathname("/")).toBeNull();
    expect(mcpResourceFromPathname("/mcp-consent")).toBeNull();
    expect(mcpResourceFromPathname("/mcp/toolkits")).toBeNull();
    expect(mcpResourceFromPathname("/mcp/toolkits/a/b")).toBeNull();
    expect(mcpResourceFromPathname("/mcp/unknown/x")).toBeNull();
    expect(mcpResourceFromPathname("/mcp/integrations/,")).toBeNull();
    expect(mcpResourceFromPathname("/mcp/tools/%E0%A4%A")).toBeNull();
    expect(mcpResourceFromPathname("/api/auth/mcp/authorize")).toBeNull();
  });
});

describe("mcpResourcePath", () => {
  it("is the inverse of the parser", () => {
    for (const path of [
      "/mcp",
      "/mcp/toolkits/deploy",
      "/mcp/integrations/github,linear",
      "/mcp/tools/github.org.main.repos.list",
    ]) {
      expect(mcpResourcePath(mcpResourceFromPathname(path)!)).toBe(path);
    }
  });

  it("encodes values that are not path-safe", () => {
    expect(mcpResourcePath({ kind: "toolkit", slug: "a b" })).toBe("/mcp/toolkits/a%20b");
  });
});
