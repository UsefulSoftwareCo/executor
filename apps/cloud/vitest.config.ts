// All of cloud's unit tests in one plain node pool. Integration coverage
// lives in e2e/ (over the dev server, which runs the production
// wrangler.jsonc topology — real workerd, real Durable Objects).
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const tanstackStartEntryStub = resolve(__dirname, "./test-stubs/tanstack-start-entry.ts");

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": resolve(__dirname, "./test-stubs/cloudflare-workers.ts"),
      "#tanstack-start-entry": tanstackStartEntryStub,
      "#tanstack-router-entry": tanstackStartEntryStub,
      "#tanstack-start-plugin-adapters": tanstackStartEntryStub,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    globalSetup: ["./scripts/test-globalsetup.ts"],
    fileParallelism: false,
    env: {
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5434/postgres",
      WORKOS_API_KEY: "test_api_key",
      WORKOS_CLIENT_ID: "test_client_id",
      WORKOS_COOKIE_PASSWORD: "test_cookie_password_at_least_32_chars!",
      NODE_ENV: "test",
    },
  },
});
