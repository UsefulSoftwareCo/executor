// The self-host account surface: the per-request `AccountProvider` middleware
// backed by Better Auth. `ExecutorApp.make` mounts the shared, provider-neutral
// `AccountHandlers` behind it under /api (Better-Auth-only — the test stub path
// doesn't serve it). `selfHostAccountMiddleware` builds the middleware Layer from
// a Better Auth handle.
export { selfHostAccountMiddleware } from "./account-api";
export { betterAuthAccountProvider } from "./better-auth-account-provider";
