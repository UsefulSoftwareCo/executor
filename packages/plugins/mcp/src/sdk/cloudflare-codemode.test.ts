import { describe, expect, it } from "@effect/vitest";

import { cloudflareNeedsCodemodeOptOut } from "./cloudflare-codemode";
import { mcpPresets } from "./presets";

describe("cloudflareNeedsCodemodeOptOut", () => {
  it("flags the Cloudflare MCP endpoint without the opt-out", () => {
    expect(cloudflareNeedsCodemodeOptOut("https://mcp.cloudflare.com/mcp")).toBe(true);
  });

  it("flags codemode set to anything but false", () => {
    expect(cloudflareNeedsCodemodeOptOut("https://mcp.cloudflare.com/mcp?codemode=true")).toBe(
      true,
    );
  });

  it("accepts the opt-out regardless of other params or whitespace", () => {
    expect(cloudflareNeedsCodemodeOptOut("https://mcp.cloudflare.com/mcp?codemode=false")).toBe(
      false,
    );
    expect(
      cloudflareNeedsCodemodeOptOut("https://mcp.cloudflare.com/mcp?foo=bar&codemode=false"),
    ).toBe(false);
    expect(cloudflareNeedsCodemodeOptOut("  https://mcp.cloudflare.com/mcp?codemode=false  ")).toBe(
      false,
    );
  });

  it("ignores non-Cloudflare and unparseable endpoints", () => {
    expect(cloudflareNeedsCodemodeOptOut("https://mcp.linear.app/mcp")).toBe(false);
    expect(cloudflareNeedsCodemodeOptOut("https://bindings.mcp.cloudflare.com/sse")).toBe(false);
    expect(cloudflareNeedsCodemodeOptOut("mcp.cloudflare.com/mcp")).toBe(false);
    expect(cloudflareNeedsCodemodeOptOut("")).toBe(false);
  });

  it("the shipped Cloudflare preset carries the opt-out", () => {
    const cloudflare = mcpPresets.find((preset) => preset.id === "cloudflare");
    expect(cloudflare?.transport).toBeUndefined();
    if (cloudflare === undefined || cloudflare.transport !== undefined) return;
    expect(cloudflareNeedsCodemodeOptOut(cloudflare.endpoint)).toBe(false);
  });
});
