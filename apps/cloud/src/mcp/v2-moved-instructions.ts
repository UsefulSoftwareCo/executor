// ---------------------------------------------------------------------------
// What a moved organization's MCP sessions tell the connected agent.
//
// An organization v2 has imported keeps working in v1, MCP included, so an
// agent connected here would never learn it moved. Its sessions carry MCP
// server `instructions` saying where the org's MCP server is now. Tools behave
// exactly as before.
//
// The move is read once per session build (an `initialize`, or a cold restore
// of an evicted session), in parallel with the execution stack, and again at
// most once per `V2_MOVED_RECHECK_MS` while a runtime stays in memory. Never
// per request. The read is bounded: a slow or failing WorkOS answers "not
// moved", so it can neither fail nor stall a session.
//
// Instructions only reach a client in the `initialize` result, so a session
// whose client was told something else (it initialized before the move) is
// ended, and its client starts a new session that carries them. See
// `mustReinitializeForV2Move`.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { v2AppOrigin, v2McpOrigin, type V2MovedEnv } from "../auth/v2-import";
import { liveV2MovedSource, v2Moved, type V2Moved } from "../auth/v2-moved";
import type { WorkOSClient } from "../auth/workos";

/** Longest the move read may add to a session build. */
export const V2_MOVED_READ_TIMEOUT_MS = 1_000;

/** How old a resident session's move read may get before a request re-reads
 *  it. Bounds how long a session that is in constant use can go on without
 *  learning its org moved. */
export const V2_MOVED_RECHECK_MS = 5 * 60 * 1000;

const movedDate = (movedAt: string): string =>
  new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(movedAt));

/** The instructions for a moved org, or `null` without a v2 MCP URL. */
export const v2MovedInstructionsText = (moved: V2Moved): string | null =>
  moved.v2McpUrl === undefined
    ? null
    : `This organization moved to Executor v2 on ${movedDate(moved.movedAt)}. ` +
      `Its MCP server is now ${moved.v2McpUrl}; ask the user to reconnect their agent there ` +
      `and choose the ${moved.v2Slug} organization when signing in. ` +
      "Changes made through this server won't reach v2.";

/** The session's instructions when its organization has moved to v2 and v1
 *  knows v2's MCP origin; otherwise `undefined`. Never fails. */
export const v2MovedMcpInstructions = (
  env: V2MovedEnv,
  organizationId: string,
): Effect.Effect<string | undefined, never, WorkOSClient> =>
  Effect.gen(function* () {
    const appOrigin = v2AppOrigin(env);
    const mcpOrigin = v2McpOrigin(env);
    if (appOrigin === null || mcpOrigin === null) return undefined;
    const moved = yield* v2Moved(yield* liveV2MovedSource, organizationId, appOrigin, mcpOrigin);
    return (moved === null ? null : v2MovedInstructionsText(moved)) ?? undefined;
  }).pipe(
    Effect.timeoutOrElse({
      duration: `${V2_MOVED_READ_TIMEOUT_MS} millis`,
      orElse: () => Effect.succeed(undefined),
    }),
    Effect.withSpan("mcp.session.v2_moved_instructions"),
  );

/**
 * Whether a session's client must re-initialize to learn of the move: the org
 * has moved (`current`), and the `initialize` its client got said something
 * else (`delivered`, `undefined` for no notice). A session that already carries
 * the current notice is left alone, so a reconnected client is never ended
 * again, and an unknown or failed read (`current` undefined) never ends one.
 */
export const mustReinitializeForV2Move = (
  delivered: string | undefined,
  current: string | undefined,
): boolean => current !== undefined && current !== delivered;
