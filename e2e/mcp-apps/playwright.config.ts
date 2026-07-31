import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "sunpeak/test/config";

// sunpeak runs `sunpeak inspect` (a real MCP-Apps host that mounts ui://
// resources in a sandboxed iframe) as the Playwright web server, connects it to
// the MCP server below, and gives tests a frame-scoped handle to the rendered
// app. We point it at executor over stdio (`executor mcp`) so the whole thing is
// self-contained: no daemon to manage, no HTTP token.
//
// Run the daemon FROM SOURCE (bun apps/cli/bin/executor.ts) so the shell
// resource is served from packages/hosts/mcp-apps-shell/dist/mcp-app.html
// (`pretest` builds it). The compiled binary also ships the shell, but source
// is the cheapest path for a test.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

export default defineConfig({
  testDir: "tests",
  server: {
    command: "bun",
    // `--artifacts` because artifacts are opt-in per MCP connection: a bare
    // `executor mcp` serves no artifact tools and no ui:// shell resource, so
    // there would be nothing for sunpeak to mount.
    args: [resolve(repo, "apps/cli/bin/executor.ts"), "mcp", "--artifacts"],
    env: {
      EXECUTOR_DATA_DIR: resolve(here, ".exdata"),
    },
    cwd: repo,
  },
});
