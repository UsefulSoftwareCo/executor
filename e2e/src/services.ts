// The scenario environment as Effect services. A scenario declares what it
// needs by yielding these tags; the requirements surface in its R channel,
// where the compiler checks them against the `needs` list (the same tags as
// runtime values — what drives skip records for targets that lack one).
// Target/RunDir/Cli are always provided; the rest depend on the target's
// capabilities and the host environment.
import { Context, type Effect } from "effect";

import type { Target as TargetShape } from "./target";
import type { ApiSurface } from "./surfaces/api";
import type { BrowserSurface } from "./surfaces/browser";
import type { CliSurface } from "./surfaces/cli";
import type { McpSurface } from "./surfaces/mcp";
import type { TelemetrySurface } from "./surfaces/telemetry";
import type { completeOAuthConsent, makeOpenCodeHome, warmUp } from "./clients/opencode";

/** The target under test (always provided). */
export class Target extends Context.Service<Target, TargetShape>()("e2e/target") {}

/** This run's artifact directory (always provided). */
export class RunDir extends Context.Service<RunDir, string>()("e2e/run-dir") {}

/** Real-PTY terminal sessions with cast recording (always provided — host machinery, not a target trait). */
export class Cli extends Context.Service<Cli, CliSurface>()("e2e/cli") {}

/** Typed HttpApiClient over the wire (target capability "api"). */
export class Api extends Context.Service<Api, ApiSurface>()("e2e/api") {}

/** Playwright browser sessions with video/trace (target capability "browser"). */
export class Browser extends Context.Service<Browser, BrowserSurface>()("e2e/browser") {}

/** MCP client sessions + headless OAuth flows (target capability "mcp-oauth"). */
export class Mcp extends Context.Service<Mcp, McpSurface>()("e2e/mcp-oauth") {}

/** Marker: billing limits are enforced on this target. */
export class Billing extends Context.Service<Billing, true>()("e2e/billing") {}

/** Query the suite's OTLP trace store for spans the target actually exported
 *  (present when the suite booted motel — E2E_MOTEL_URL). */
export class Telemetry extends Context.Service<Telemetry, TelemetrySurface>()("e2e/telemetry") {}

/** The real OpenCode binary, hermetically driveable (present when installed on this host). */
export interface OpenCodeClient {
  readonly makeHome: typeof makeOpenCodeHome;
  readonly warmUp: typeof warmUp;
  readonly completeOAuthConsent: typeof completeOAuthConsent;
}
export class OpenCode extends Context.Service<OpenCode, OpenCodeClient>()("e2e/opencode") {}

/** Compress (or restore, with null) the authorization server's access-token TTL. */
export class TtlControl extends Context.Service<
  TtlControl,
  (seconds: number | null) => Effect.Effect<void>
>()("e2e/ttl-control") {}

/**
 * Restart the instance, keeping its data. What lets durability scenarios
 * assert that writes survive a process restart — the property a dev server
 * with a fresh data dir can never test by accident.
 */
export class Restart extends Context.Service<Restart, () => Effect.Effect<void>>()("e2e/restart") {}
