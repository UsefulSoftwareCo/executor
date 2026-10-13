// ---------------------------------------------------------------------------
// Whether an organization's MCP traffic has moved to Executor v2.
//
// Read from `org_moved_to_v2`, which v2 writes and v1 only reads. Only a row in
// state `moved` that names the v2 organization forwards: no row, `moving`, or a
// `moved` row whose v2 organization does not exist yet all mean "serve from v1".
// A failed read is NOT "not moved": it fails, and the MCP auth path turns that
// into a retryable "unavailable" rather than serving a possibly moved org from
// v1.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService } from "../db/db";
import { orgMovedToV2 } from "../db/schema";

/** The v2 organization an org's MCP traffic is forwarded to. */
export interface MovedToV2 {
  readonly v2OrganizationId: string;
}

export class MovedToV2ReadError extends Data.TaggedError("MovedToV2ReadError")<{
  readonly cause: unknown;
}> {}

export const readMovedToV2 = (
  organizationId: string,
): Effect.Effect<MovedToV2 | null, MovedToV2ReadError, DbService> =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ state: orgMovedToV2.state, v2OrgId: orgMovedToV2.v2OrgId })
          .from(orgMovedToV2)
          .where(eq(orgMovedToV2.orgId, organizationId)),
      catch: (cause) => new MovedToV2ReadError({ cause }),
    });
    const row = rows[0];
    return row?.state === "moved" && row.v2OrgId ? { v2OrganizationId: row.v2OrgId } : null;
  }).pipe(Effect.withSpan("mcp.auth.read_moved_to_v2"));
