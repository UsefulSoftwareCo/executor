// ---------------------------------------------------------------------------
// Mirror READINESS: whether the local membership mirror may be trusted as
// the membership authority for a request, or WorkOS must still be asked.
//
// The mirror is fed by login, write-through, and the Events API reconciler
// (`workos-mirror.ts`), and is complete only once the one-off backfill has
// written every organization and the reconciler has caught up to the
// present. Before that, two things go wrong if it is trusted anyway:
//   - a member who has not signed in since the mirror shipped has no row
//     yet, and every protected request of theirs is refused — the backfill
//     is what writes them;
//   - a member revoked in the WorkOS dashboard while the reconciler was not
//     running still holds an active row, and keeps their access until the
//     stream is replayed — the reconciler is what tombstones them.
// So readiness is BOTH: the backfill's completion mark
// (`workos_sync.backfill_completed_at`, written once by a run that covered
// every live organization) AND a recent drain of the events stream
// (`workos_sync.drained_at`, moved forward by every reconciler run that read
// the stream to its end). The lag budget bounds how far behind the reconciler
// may be: it runs every minute, so a mark older than the budget means it has
// stalled (WorkOS unreachable, the cron not deployed, a backlog draining over
// many runs) and the mirror may be missing revocations. While either half is
// missing the authorization path reads membership from WorkOS instead
// (`organization.ts`), exactly as it did before the cutover; nothing is
// denied or granted on the mirror's word.
//
// The rule and the row read live here, free of `cloudflare:workers`, so the
// deploy gate (`scripts/ensure-workos-mirror-ready.ts`) applies the SAME rule
// over a plain postgres.js connection under bun before the build that trusts
// the mirror goes live. The request-scoped service is `mirror-readiness.ts`.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { Data, Duration } from "effect";

import type { DrizzleDb } from "../db/db";
import { workosSync } from "../db/schema";
import { WORKOS_EVENTS_STREAM_ID } from "./workos-mirror-store";

/**
 * How far behind the present the reconciler's last drain may be before the
 * mirror stops being trusted. The reconciler runs every minute and a healthy
 * run drains in one tick; ten minutes absorbs a few missed ticks and a short
 * WorkOS blip without falling back, and bounds how long a dashboard-side
 * revocation could go unseen if it did.
 */
export const MIRROR_RECONCILER_LAG_BUDGET = Duration.minutes(10);

/**
 * What the readiness check found. `Ready` is the only state in which the
 * mirror authorizes; the other two name which half is missing so the fallback
 * can be logged with its cause.
 */
export type MirrorReadinessState = Data.TaggedEnum<{
  readonly Ready: {};
  /** No backfill run has covered every organization yet. */
  readonly BackfillPending: {};
  /** The backfill is done but the reconciler has not drained within the budget (`drainedAt` null = never). */
  readonly ReconcilerStale: { readonly drainedAt: Date | null };
}>;
export const MirrorReadinessState = Data.taggedEnum<MirrorReadinessState>();

/** The two `workos_sync` columns the rule reads, as the events row holds them (or no row at all). */
export interface MirrorReadinessRow {
  readonly backfillCompletedAt: Date | null;
  readonly drainedAt: Date | null;
}

/**
 * The readiness rule over the events row as of `now`: ready when the
 * backfill has completed AND the last drain is within
 * {@link MIRROR_RECONCILER_LAG_BUDGET} of `now`. A missing row is a mirror
 * that was never backfilled. Pure, so the deploy gate and the request path
 * cannot disagree.
 */
export const mirrorReadinessFrom = (
  row: MirrorReadinessRow | null,
  now: Date,
): MirrorReadinessState => {
  if (row === null || row.backfillCompletedAt === null)
    return MirrorReadinessState.BackfillPending();
  const drainedAt = row.drainedAt;
  if (
    drainedAt === null ||
    now.getTime() - drainedAt.getTime() > Duration.toMillis(MIRROR_RECONCILER_LAG_BUDGET)
  ) {
    return MirrorReadinessState.ReconcilerStale({ drainedAt });
  }
  return MirrorReadinessState.Ready();
};

/** Read the events row's readiness columns and apply {@link mirrorReadinessFrom} as of `now`. */
export const readMirrorReadiness = async (
  db: DrizzleDb,
  now: Date,
): Promise<MirrorReadinessState> => {
  const rows = await db
    .select({
      backfillCompletedAt: workosSync.backfillCompletedAt,
      drainedAt: workosSync.drainedAt,
    })
    .from(workosSync)
    .where(eq(workosSync.id, WORKOS_EVENTS_STREAM_ID));
  return mirrorReadinessFrom(rows[0] ?? null, now);
};

/** One line naming the state, for logs and the deploy gate; never carries member data. */
export const describeMirrorReadiness = (state: MirrorReadinessState): string =>
  MirrorReadinessState.$match(state, {
    Ready: () => "ready",
    BackfillPending: () => "backfill pending: no backfill run has covered every organization yet",
    ReconcilerStale: ({ drainedAt }) =>
      drainedAt === null
        ? "reconciler stale: the events reconciler has never drained the stream"
        : `reconciler stale: the events stream was last drained at ${drainedAt.toISOString()}, past the ${Duration.format(MIRROR_RECONCILER_LAG_BUDGET)} budget`,
  });
