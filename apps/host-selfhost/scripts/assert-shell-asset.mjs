// Build-blocking check that the SPA build emitted the stable-named MCP-Apps
// shell document. The self-host server serves `ui://executor/shell.html` by
// reading this file from the SPA dist (`loadMcpAppsShellHtml`'s image-layout
// candidate) — the runtime image carries no `packages/` tree for the package
// dist candidates to hit — so a build without it ships an image whose
// artifact resource reads all fail. Fail the build here instead. Same shape
// as apps/cloud's assertion in scripts/build.mjs.
import { existsSync, readFileSync } from "node:fs";

const shellAsset = new URL("../dist/assets/executor-mcp-apps-shell-stable.html", import.meta.url);
if (!existsSync(shellAsset)) {
  console.error(`[build] missing MCP-Apps shell asset at ${shellAsset.pathname}`);
  process.exit(1);
}
if (!readFileSync(shellAsset, "utf8").includes('name="executor-mcp-apps-shell"')) {
  console.error(`[build] ${shellAsset.pathname} is not the MCP-Apps shell document`);
  process.exit(1);
}
