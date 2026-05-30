// Isolated leaf: the one neutral boot-scoped service (WorkOSClient) the MCP
// session DO and the miniflare test-worker both build on. This is the neutral
// DB/tracer core — it names NO billing service, so the DO (which never bills)
// does not transitively require one. Billing (`AutumnService`) is provided ONLY
// where it runs: the metered executor plane, the account seat-gate, the
// createOrganization free-limit gate, and the org domain-verification gate.
//
// Kept out of `./layers.ts` ON PURPOSE — this is the one file split the
// readability cleanup deliberately keeps. `./layers.ts` imports
// `auth/handlers.ts`, which imports `@tanstack/react-start/server`. The cloud
// production bundle resolves that chain through the TanStack Start Vite plugin,
// and the workerd vitest pool resolves the `#tanstack-*` subpath specifiers via
// `vitest.config.ts`'s `resolve.alias`. But the MCP DO test-worker is bundled
// by wrangler/esbuild (`mcp-miniflare.e2e.node.test.ts`'s `unstable_dev`),
// which has no alias hook AND can't supply Start's `tanstack-start-*:v` virtual
// modules — so it fails to bundle any module that transitively imports
// react-start. Importing `CoreSharedServices` from here keeps the DO bundle
// react-start-free.

import { WorkOSClient } from "../auth/workos";

/**
 * The neutral boot-scoped service, independent of how the DB or tracer is
 * provisioned — both the stateless HTTP path (per-request DB via Hyperdrive)
 * and the MCP session DO (long-lived DB + isolate-local tracer SDK) merge this
 * with their own `DbLive` + `UserStoreLive` + telemetry layer.
 */
export const CoreSharedServices = WorkOSClient.Default;
