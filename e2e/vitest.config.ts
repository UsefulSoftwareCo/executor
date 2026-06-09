import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  // Cloud code imports `cloudflare:workers`; map it to cloud's node test stub.
  resolve: {
    alias: {
      "cloudflare:workers": resolve(import.meta.dirname, "../apps/cloud/test-stubs/cloudflare-workers.ts"),
    },
  },
  test: {
    testTimeout: 30_000,
    include: ["tests/**/*.test.ts"],
    // Reuse cloud's in-process PGlite socket server (starts a real Postgres-
    // compatible DB + runs migrations) so the cloud app runs fully stubbed.
    globalSetup: ["../apps/cloud/scripts/test-globalsetup.ts"],
    env: {
      // Cloud app, stubbed: WorkOS + Autumn never hit the network (in-memory
      // vault in the harness); PGlite for the DB.
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5434/postgres",
      EXECUTOR_DIRECT_DATABASE_URL: "true",
      WORKOS_API_KEY: "sk_e2e_stub",
      WORKOS_CLIENT_ID: "client_e2e_stub",
      WORKOS_COOKIE_PASSWORD: "e2e_cookie_password_0123456789abcdef0123456789abcdef",
      AUTUMN_SECRET_KEY: "am_e2e_stub",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      MCP_AUTHKIT_DOMAIN: "https://example.com",
      MCP_RESOURCE_ORIGIN: "http://test.local",
    },
  },
});
