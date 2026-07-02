// ---------------------------------------------------------------------------
// Cloud MCP — the auth seam behind the shared host-mcp envelope, slotted into
// the app composition root's `mcp: { auth }`:
//
//   - auth -> cloudMcpAuth (WorkOS JWT + API-key + org-liveness + the two OAuth
//                           discovery docs)
//
// `server.ts` intercepts `/mcp` transport for the hibernatable Agent bridge, so
// the app envelope mounts only cloud's OAuth discovery docs (no `sessions` or
// `reporter` seam). The MCP-path predicate lives in `./mount` (`classifyMcpPath`
// / `prepareMcpOrgScope`), imported directly there. The MCP session Durable
// Object class itself stays a platform-side export (server.ts) and imports its
// siblings directly, NOT this barrel, to keep the DO bundle react-start-free.
// ---------------------------------------------------------------------------

// `cloudMcpAuth` is the packaged seam (the WorkOS JWT/api-key auth provider with
// its `McpAuth`/`McpOrganizationAuth` seams provided internally), shaped as the
// `Layer<McpAuthProvider, never, IdentityProvider>` `ExecutorApp.make` expects.
export { cloudMcpAuth } from "./auth-provider";
