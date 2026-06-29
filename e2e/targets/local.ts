// The local app as a target. Unlike cloud/self-host, local has no shared
// instance: it is single-user, so each scenario launches its OWN `executor web`
// via the CLI (the Cli surface, recorded as a terminal cast) on its own
// throwaway data dir and an OS-assigned port (`--port 0`). That makes local
// scenarios independent (parallel-safe) and is the CLI+browser flow itself —
// see local/auth.test.ts. So this target carries no baseUrl/token of its own;
// scenarios read the printed `?_token=` URL at runtime and drive the browser
// against it with absolute URLs.
import { Effect } from "effect";

import type { Identity, Target } from "../src/target";

export const localTarget = (): Target => ({
  name: "local",
  // Placeholders: scenarios navigate to absolute URLs (the CLI prints the real
  // port), so the browser context's baseURL is never used to resolve a path.
  baseUrl: "http://127.0.0.1",
  mcpUrl: "http://127.0.0.1/mcp",
  // "browser" provides the Browser surface; Cli is always available. No
  // "mcp-oauth" (bearer-gated, not OAuth consent) and no "billing".
  capabilities: new Set(["browser"]),
  // Single-user: a trivial identity with no cookies. The browser authenticates
  // via the ?_token bootstrap the scenario performs, not via injected identity.
  newIdentity: () => Effect.sync((): Identity => ({ label: "local" })),
});
