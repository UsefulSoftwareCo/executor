import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["./scripts/test-globalsetup.ts"],
    testTimeout: 60_000,
    onUnhandledError(error) {
      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: Vitest passes unknown host errors to this hook
      if (error && (error as Error).message === "Stream was cancelled.") {
        return false;
      }
    },
  },
});
