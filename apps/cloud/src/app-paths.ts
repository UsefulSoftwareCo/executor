import { classifyMcpPath } from "./mcp/mount";

// ---------------------------------------------------------------------------
// Single source of truth for "does the unified app handler own this path?" —
// the decision `start.ts` makes per request (app handler vs TanStack Start).
//
// The app handler (`ExecutorApp.make`'s `toWebHandler`) serves everything under
// `/api/*` — the typed API plus the cloud `extensions.routes` (the Autumn billing
// proxy at `/api/billing/*` and Swagger at `/api/docs` both live under `/api`) —
// plus the `/mcp` serving envelope and its `/.well-known/*` OAuth discovery docs.
// The dispatcher forwards those UNMODIFIED; anything else falls through to the
// Start router. Keeping every served route under `/api` (no separate top-level
// namespace) is what keeps this gate a simple two-prefix check.
// ---------------------------------------------------------------------------

export const isApiPath = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");

export const isAppOwnedPath = (pathname: string) =>
  isApiPath(pathname) || classifyMcpPath(pathname) !== null;
