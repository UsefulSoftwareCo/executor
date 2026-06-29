import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routes/routeTree.gen";

// ---------------------------------------------------------------------------
// The canonical console router TYPE. Nothing imports this module — it exists
// so this package's own typecheck registers the console route tree (generated
// from src/routes by `bun run routes:gen`), which makes every `Link to=` /
// `navigate({ to })` in the shared pages and shell typecheck against the
// console route contract instead of being loose strings. A shared component
// linking to a route that isn't part of the shared console set fails HERE, in
// the package that owns the contract, not at runtime in some app.
//
// Apps are unaffected: each app's own router.tsx registers its real router
// (shared console routes + app-specific extras) for its own typecheck graph.
// ---------------------------------------------------------------------------

export const consoleRouter = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    readonly router: typeof consoleRouter;
  }
}
