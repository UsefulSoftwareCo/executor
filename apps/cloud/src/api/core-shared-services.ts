// ---------------------------------------------------------------------------
// Core shared services — the Effect layer that both the stateless HTTP
// request path and the long-lived MCP session DO build on top of.
// ---------------------------------------------------------------------------
//
// Pulled out of `./layers.ts` so importers that only need `WorkOSAuth` and
// `AutumnService` (notably the MCP session DO) don't have to drag in
// `auth/handlers.ts`, which imports `@tanstack/react-start/server`. That
// import uses a subpath specifier (`#tanstack-start-entry`) that vitest's
// workerd pool can't resolve, so any test that touches the DO through
// SELF.fetch would fail at module load.
// ---------------------------------------------------------------------------

import { Layer } from "effect";

import { WorkOSAuth } from "../auth/workos";
import { AutumnService } from "../services/autumn";

/**
 * Services that are independent of how the DB or tracer is provisioned —
 * both the stateless HTTP path (per-request DB via Hyperdrive) and the MCP
 * session DO (long-lived DB + isolate-local tracer SDK) merge this with
 * their own `DbLive` + `UserStoreLive` + telemetry layer.
 */
export const CoreSharedServices = Layer.mergeAll(WorkOSAuth.Default, AutumnService.Default);
