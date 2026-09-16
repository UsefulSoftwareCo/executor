// ---------------------------------------------------------------------------
// Mirror READINESS: whether the local membership mirror has ever been fit to
// authorize from, per the ORIGINAL cutover rule. The request path
// (`organization.ts`) no longer consults this — it authorizes from the
// mirror unconditionally, because the one-off backfill is complete and
// permanent and a pre-mirror organization is covered by the on-demand scan
// (`ensureOrganizationBackfilled`). What remains is the deploy gate
// (`scripts/ensure-workos-mirror-ready.ts`), which still refuses to ship a
// build that trusts the mirror while it is unready, and the reconciler's own
// staleness alert (`workos-events-runner.ts`), which reads `drainedAt` after
// each run and raises a Sentry error when the drain has fallen behind the lag
// budget below — a stalled reconciler is now an operational page, not a
// per-request fallback.
//
// Readiness is BOTH: the backfill's completion mark
// (`workos_sync.backfill_completed_at`, written once by a run that covered
// every live organization) AND a recent drain of the events stream
// (`workos_sync.drained_at`, moved forward by every reconciler run that read
// the stream to its end). The lag budget bounds how far behind the reconciler
// may be: it runs every minute, so a mark older than the budget means it has
// stalled (WorkOS unreachable, the cron not deployed, a backlog draining over
// many runs) and the mirror may be missing revocations.
//
// The rule and the row read live here, free of `cloudflare:workers`, so the
// deploy gate applies the SAME rule over a plain postgres.js connection under
// bun before a build goes live, and the reconciler's alert applies the SAME
// `drainedAt` age check the gate does.
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
