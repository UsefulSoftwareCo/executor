import { describe, expect, it } from "@effect/vitest";

import { mcpResourceFromPath } from "./resource";

describe("mcpResourceFromPath", () => {
  it("classifies the default MCP path", () => {
    expect(mcpResourceFromPath("/mcp")).toEqual({ kind: "default" });
  });

  it("classifies a toolkit MCP path", () => {
    expect(mcpResourceFromPath("/mcp/toolkits/calendar-tools")).toEqual({
      kind: "toolkit",
      slug: "calendar-tools",
    });
  });

  it.each([
    "/",
    "/mcp/",
    "/mcp/toolkits",
    "/mcp/toolkits/",
    "/mcp//toolkits/calendar-tools",
    "/mcp/toolkits//calendar-tools",
    "/mcp/toolkits/calendar-tools/extra",
    "/api/toolkits/calendar-tools",
  ])("rejects the non-serving path %s", (pathname) => {
    expect(mcpResourceFromPath(pathname)).toBeNull();
  });
});
