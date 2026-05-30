// ---------------------------------------------------------------------------
// Cloud MCP — the three provider seams behind the shared host-mcp envelope,
// named to match the app composition root's `mcp: { auth, sessions, reporter }`:
//
//   - auth     -> cloudMcpAuth     (WorkOS JWT + API-key + org-liveness + the
//                                   two OAuth discovery docs)
//   - sessions -> cloudMcpSessions (the Durable-Object session dispatch)
//   - reporter -> cloudMcpReporter (forwards request-orchestration defects to
//                                   Sentry + the dev console)
//
// These three are what `app.ts`'s `ExecutorApp.make` slots into its `mcp`
// providers; the unified app handler serves /mcp from the app layer (like
// self-host), so start.ts no longer hand-mounts MCP. The MCP-path predicate +
// test-worker envelope builder live in `./mount` (`classifyMcpPath` /
// `makeMcpWebHandler`), imported directly there. The MCP session Durable Object
// class itself stays a platform-side export (server.ts) and imports its
// siblings directly, NOT this barrel, to keep the DO bundle react-start-free.
// ---------------------------------------------------------------------------

// `cloudMcpAuth` is the packaged seam (the WorkOS JWT/api-key auth provider with
// its `McpAuth`/`McpOrganizationAuth` seams provided internally), shaped as the
// `Layer<McpAuthProvider, never, IdentityProvider>` `ExecutorApp.make` expects.
export { cloudMcpAuth } from "./auth-provider";
export { cloudMcpSessionStoreLayer as cloudMcpSessions } from "./session-store";
export { cloudMcpReporter } from "./reporter";
