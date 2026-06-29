// Test-only stub for TanStack Start's `#tanstack-*` subpath-imports specifiers.
//
// `@tanstack/start-server-core` (reached transitively from
// `@tanstack/react-start/server`, which `auth/handlers.ts` uses for
// `setCookie`/`deleteCookie`) does `import("#tanstack-start-entry")` /
// `"#tanstack-router-entry"` / `"#tanstack-start-plugin-adapters"`. Those
// `imports`-field specifiers are declared on `@tanstack/start-client-core`,
// not on `start-server-core`, so Vite's resolver — used by the workerd vitest
// pool — can't find them relative to the importing package and errors at module
// load (`Missing "#tanstack-router-entry" specifier in "@tanstack/start-server-core"`).
//
// In real builds the app's bundler injects the user's generated entry here; in
// the SSR/handler code-path cloud never exercises (cloud only calls the cookie
// helpers), so the union of the fake-entry export surfaces is enough to let the
// module graph load. The vitest configs alias all three `#tanstack-*`
// specifiers to this single stub.
export const startInstance = undefined;
export function getRouter() {}
export const pluginSerializationAdapters: readonly unknown[] = [];
export const hasPluginAdapters = false;
