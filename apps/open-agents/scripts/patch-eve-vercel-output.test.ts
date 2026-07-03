import { describe, expect, test } from "bun:test";
import { normalizeVercelOutputRoutes, normalizeVercelRouteSource } from "./patch-eve-vercel-output";

describe("normalizeVercelRouteSource", () => {
  test("removes named capture groups from Eve dynamic Vercel routes", () => {
    expect(normalizeVercelRouteSource("/eve/v1/session/(?<sessionId>[^/]+)/stream")).toBe(
      "/eve/v1/session/([^/]+)/stream",
    );
    expect(
      normalizeVercelRouteSource(
        "/eve/v1/connections/(?<name>[^/]+)/callback/(?<token>[^/]+)",
      ),
    ).toBe("/eve/v1/connections/([^/]+)/callback/([^/]+)");
  });
});

describe("normalizeVercelOutputRoutes", () => {
  test("normalizes only route source patterns", () => {
    const result = normalizeVercelOutputRoutes({
      routes: [
        { src: "/eve/v1/session" },
        { src: "/eve/v1/session/(?<sessionId>[^/]+)", dest: "/eve/__server" },
        { handle: "filesystem" },
      ],
    });

    expect(result.normalizedRouteCount).toBe(1);
    expect(result.config.routes).toEqual([
      { src: "/eve/v1/session" },
      { src: "/eve/v1/session/([^/]+)", dest: "/eve/__server" },
      { handle: "filesystem" },
    ]);
  });
});
