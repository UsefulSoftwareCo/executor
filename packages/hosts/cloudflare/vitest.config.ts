import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:email": resolve(__dirname, "./src/test-stubs/cloudflare-email.ts"),
      "cloudflare:workers": resolve(__dirname, "./src/test-stubs/cloudflare-workers.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    setupFiles: ["./src/test-setup.ts"],
    server: {
      deps: {
        inline: ["agents", "partyserver"],
      },
    },
  },
});
