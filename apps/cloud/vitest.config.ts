import { resolve } from "node:path";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// `auth/handlers.ts` imports `setCookie`/`deleteCookie` from
// `@tanstack/react-start/server`. That barrel transitively pulls in
// `@tanstack/start-server-core`, which does `import("#tanstack-start-entry")`
// (+ `#tanstack-router-entry` / `#tanstack-start-plugin-adapters`). Those
// `imports`-field specifiers are declared on `@tanstack/start-client-core`,
// not on `start-server-core`, so Vite's resolver (used by the workerd pool)
// can't resolve them relative to the importing package and the module graph
// fails to load. Alias the three specifiers to a no-op stub so the workerd
// pool can load any module that transitively imports react-start. Cloud only
// uses the cookie helpers, never the SSR handler path the stub shims out.
const tanstackStartEntryStub = resolve(__dirname, "./test-stubs/tanstack-start-entry.ts");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
    }),
  ],
  resolve: {
    alias: {
      "#tanstack-start-entry": tanstackStartEntryStub,
      "#tanstack-router-entry": tanstackStartEntryStub,
      "#tanstack-start-plugin-adapters": tanstackStartEntryStub,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.node.test.ts", "**/node_modules/**"],
    globalSetup: ["./scripts/test-globalsetup.ts"],
    // postgres.js's Cloudflare polyfill leaves a couple of `.then()` chains
    // on `writer.ready` uncaught when the socket tears down before the
    // writer settles (DbService scope close). The rejection is benign —
    // the socket is closing anyway — so filter it out rather than fail
    // the run with noise.
    onUnhandledError(error) {
      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: Vitest unhandled-error hook receives unknown host errors
      if (error && (error as Error).message === "Stream was cancelled.") {
        return false;
      }
    },
  },
});
