import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import appPlugin from "./vite";

// Standalone Vite config for iterating on the SPA in isolation, without
// the apps/local API middleware or Electron sidecar. API/MCP calls fail
// here unless a separate server is running.
const LOCAL_CONFIG = fileURLToPath(new URL("../../apps/local/executor.config.ts", import.meta.url));
const LOCAL_JSONC = fileURLToPath(new URL("../../apps/local/executor.jsonc", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [appPlugin({ executorConfigPath: LOCAL_CONFIG, executorJsoncPath: LOCAL_JSONC })],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify("0.0.0-dev"),
    "import.meta.env.VITE_GITHUB_URL": JSON.stringify("https://github.com/RhysSullivan/executor"),
    "import.meta.env.VITE_EXECUTOR_DEV_CLI_CWD": JSON.stringify(REPO_ROOT),
  },
});
