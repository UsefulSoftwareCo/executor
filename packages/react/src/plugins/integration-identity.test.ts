import { describe, expect, it } from "@effect/vitest";

import {
  domainLabelFromUrl,
  humanizeStdioToken,
  integrationDisplayNameFromStdio,
  integrationDisplayNameFromUrl,
  pascalCaseDomainLabel,
  stdioPackageToken,
} from "./integration-identity";

describe("integration identity URL display names", () => {
  it("uses the apex domain label without the public suffix", () => {
    expect(domainLabelFromUrl("https://api.example.co.uk/graphql")).toBe("example");
  });

  it("normalizes domain labels to PascalCase", () => {
    expect(pascalCaseDomainLabel("my-api")).toBe("MyApi");
  });

  it("appends the integration kind to the PascalCase domain label", () => {
    expect(integrationDisplayNameFromUrl("https://mcp.linear.app/sse", "MCP")).toBe("Linear MCP");
    expect(integrationDisplayNameFromUrl("https://api.shopify.com/graphql", "GraphQL")).toBe(
      "Shopify GraphQL",
    );
  });
});

describe("integration identity stdio display names", () => {
  it("picks the package spec past the runner and its flags", () => {
    expect(stdioPackageToken("npx", ["-y", "@modelcontextprotocol/server-github"])).toBe(
      "@modelcontextprotocol/server-github",
    );
    expect(stdioPackageToken("pnpm", ["dlx", "mcp-server-time"])).toBe("mcp-server-time");
    expect(stdioPackageToken("uvx", ["mcp-server-time"])).toBe("mcp-server-time");
  });

  it("uses the command itself only when it is not a generic runner", () => {
    expect(stdioPackageToken("npx", [])).toBeNull();
    expect(stdioPackageToken("my-mcp-server", [])).toBe("my-mcp-server");
  });

  it("strips npm scope, MCP affixes, versions, and paths when humanizing", () => {
    expect(humanizeStdioToken("@modelcontextprotocol/server-github")).toBe("Github");
    expect(humanizeStdioToken("mcp-server-sequential-thinking")).toBe("Sequential Thinking");
    expect(humanizeStdioToken("@scope/notion-mcp@1.2.3")).toBe("Notion");
    expect(humanizeStdioToken("./build/index.js")).toBe("Index");
  });

  it("derives a humanized name with the kind suffix, ignoring trailing path args", () => {
    expect(
      integrationDisplayNameFromStdio("npx", ["-y", "@modelcontextprotocol/server-github"], "MCP"),
    ).toBe("Github MCP");
    expect(
      integrationDisplayNameFromStdio(
        "npx",
        ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/work"],
        "MCP",
      ),
    ).toBe("Filesystem MCP");
    expect(integrationDisplayNameFromStdio("uvx", ["mcp-server-time"], "MCP")).toBe("Time MCP");
  });

  it("returns null for a bare runner so callers can fall back to the command", () => {
    expect(integrationDisplayNameFromStdio("npx", [], "MCP")).toBeNull();
  });
});
