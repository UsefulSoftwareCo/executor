import { describe, expect, it } from "@effect/vitest";

import { isProbableMcpEndpoint } from "./probe-url";

describe("isProbableMcpEndpoint", () => {
  it("rejects the prefixes a URL passes through while it is typed", () => {
    for (const typed of [
      "",
      "  ",
      "h",
      "ht",
      "htt",
      "http",
      "http:",
      "http:/",
      "http://",
      "http://a",
      "http://example",
      "https://mcp",
      "https://mcp.",
      "https://.com",
    ]) {
      expect(isProbableMcpEndpoint(typed), typed).toBe(false);
    }
  });

  it("accepts a finished http(s) endpoint", () => {
    for (const finished of [
      "https://mcp.example.com",
      "https://mcp.example.com/mcp",
      "http://example.com:4789/mcp?codemode=false",
      "https://example.co.uk/sse",
      "  https://mcp.example.com/mcp  ",
      "HTTPS://MCP.EXAMPLE.COM/mcp",
    ]) {
      expect(isProbableMcpEndpoint(finished), finished).toBe(true);
    }
  });

  it("accepts local development hosts, which have no dot to wait for", () => {
    for (const local of [
      "http://localhost",
      "http://localhost:4789/mcp",
      "http://app.localhost:4789/mcp",
      "http://127.0.0.1:4789/mcp",
      "http://[::1]:4789/mcp",
    ]) {
      expect(isProbableMcpEndpoint(local), local).toBe(true);
    }
  });

  it("rejects schemes the MCP remote transport cannot dial", () => {
    for (const wrongScheme of [
      "ftp://mcp.example.com",
      "ws://mcp.example.com",
      "file:///tmp/mcp",
      "mailto:someone@example.com",
      "npx @example/mcp-server",
    ]) {
      expect(isProbableMcpEndpoint(wrongScheme), wrongScheme).toBe(false);
    }
  });
});
