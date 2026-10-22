import { describe, expect, it } from "@effect/vitest";

import { hasAllowedCookieOrigin } from "./client-channel";

describe("MCP client channel cookie origin guard", () => {
  const allowedOrigins = ["https://executor.example", "https://console.example"];

  it("requires an allowed Origin whenever Cookie is present", () => {
    expect(
      hasAllowedCookieOrigin(
        new Request("https://executor.example/api/mcp/client-channel", {
          headers: { cookie: "session=abc", origin: "https://attacker.example" },
        }),
        allowedOrigins,
      ),
    ).toBe(false);
    expect(
      hasAllowedCookieOrigin(
        new Request("https://executor.example/api/mcp/client-channel", {
          headers: { cookie: "session=abc" },
        }),
        allowedOrigins,
      ),
    ).toBe(false);
    expect(
      hasAllowedCookieOrigin(
        new Request("https://executor.example/api/mcp/client-channel", {
          headers: { cookie: "session=abc", origin: "https://console.example" },
        }),
        allowedOrigins,
      ),
    ).toBe(true);
  });

  it("allows bearer/API-key clients without Cookie and without Origin", () => {
    expect(
      hasAllowedCookieOrigin(
        new Request("https://executor.example/api/mcp/client-channel", {
          headers: { authorization: "Bearer token" },
        }),
        allowedOrigins,
      ),
    ).toBe(true);
  });
});
