// Build-blocking check that the SPA build emitted the stable-named MCP-Apps
// shell document. The MCP session DO serves `ui://executor/shell.html` by
// fetching this asset through the ASSETS binding — a deployed Worker has no
// filesystem — so a build without it ships a Worker whose artifact resource
// reads all fail. Fail the build here instead. Same shape as apps/cloud's
// assertion in scripts/build.mjs.
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
