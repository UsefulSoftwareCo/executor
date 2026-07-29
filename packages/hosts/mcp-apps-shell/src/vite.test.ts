import { describe, expect, it } from "@effect/vitest";

import { mcpAppsShellAsset } from "./vite";

describe("mcpAppsShellAsset", () => {
  it("resolves the dev asset URL without building the shell during server startup", async () => {
    const plugin = mcpAppsShellAsset();
    plugin.configResolved({ command: "serve" });

    const resolved = plugin.resolveId("virtual:executor-mcp-apps-shell-html");
    expect(resolved).toBeDefined();
    expect(await plugin.load(resolved ?? "")).toBe(
      'export const shellHtmlUrl = "/assets/executor-mcp-apps-shell-dev.html";\n' +
        "export default shellHtmlUrl;\n",
    );
  });
});
