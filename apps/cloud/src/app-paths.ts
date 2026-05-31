import { classifyMcpPath } from "./mcp/mount";

// ---------------------------------------------------------------------------
// Single source of truth for "does the unified app handler own this path?" —
// the decision `start.ts` makes per request (app handler vs TanStack Start).
//
// The app handler (`ExecutorApp.make`'s `toWebHandler`) serves three surfaces at
// their real paths, so the dispatcher must forward all of them UNMODIFIED:
//   - `/api` + `/api/*`            — the `/api`-prefixed typed API
//   - `/extensions/*`             — Swagger UI (`/extensions/docs`) + the Autumn
//                                   billing proxy (`/extensions/billing/route/*`)
//   - `/mcp` + `/.well-known/*`   — the MCP serving envelope + OAuth discovery
//
// Anything else falls through to the Start router. Missing `/extensions/*` here
// 404s the entire authenticated billing UI (the React app posts to
// `/extensions/billing/route/*` via `<AutumnProvider>`), which is why it has a
// dedicated test.
// ---------------------------------------------------------------------------

export const isApiPath = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");

export const isExtensionPath = (pathname: string) => pathname.startsWith("/extensions/");

export const isAppOwnedPath = (pathname: string) =>
  isApiPath(pathname) || isExtensionPath(pathname) || classifyMcpPath(pathname) !== null;
