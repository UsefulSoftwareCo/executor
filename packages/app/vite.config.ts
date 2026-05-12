import { defineConfig } from "vite";
import appPlugin from "./vite";

// Standalone Vite config for iterating on the SPA in isolation, without
// the apps/local API middleware or Electron sidecar. API/MCP calls fail
// here unless a separate server is running.
export default defineConfig({
  plugins: [appPlugin],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify("0.0.0-dev"),
    "import.meta.env.VITE_GITHUB_URL": JSON.stringify(
      "https://github.com/RhysSullivan/executor",
    ),
  },
});
