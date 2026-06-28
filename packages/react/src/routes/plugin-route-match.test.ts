import { describe, expect, it } from "@effect/vitest";

import { matchPluginPage, matchPluginPagePath } from "./plugins.$pluginId.$";

describe("plugin page route matching", () => {
  it("matches plugin roots", () => {
    expect(matchPluginPagePath("/", "/")).toEqual({});
    expect(matchPluginPagePath("/", "")).toEqual({});
  });

  it("matches static plugin subpages", () => {
    expect(matchPluginPagePath("/settings", "/settings")).toEqual({});
    expect(matchPluginPagePath("/settings", "/other")).toBeNull();
  });

  it("captures $params from plugin subpages", () => {
    expect(matchPluginPagePath("/$toolkitSlug", "/deploy-tools")).toEqual({
      toolkitSlug: "deploy-tools",
    });
  });

  it("does not let parameter pages swallow deeper paths", () => {
    expect(matchPluginPagePath("/$toolkitSlug", "/deploy-tools/rules")).toBeNull();
  });

  it("prefers static plugin pages over parameter pages", () => {
    const match = matchPluginPage([{ path: "/$id" }, { path: "/settings" }], "/settings");

    expect(match).toEqual({
      page: { path: "/settings" },
      params: {},
    });
  });
});
