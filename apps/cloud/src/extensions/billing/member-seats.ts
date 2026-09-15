// ---------------------------------------------------------------------------
// Seat-count reporting — the membership mirror → Autumn reconciliation for
// seat billing
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { MemberDirectory } from "@executor-js/api/server";

import { WorkOsMirror } from "../../auth/workos-mirror";
import { AutumnService } from "./service";

/**
 * Report the organization's billable seat count to Autumn: active members
 * only — a pending invite occupies a seat for the plan gate but is not
 * billed until the person joins.
 *
 * Seats change through paths the app never sees a mutation for (invitation
 * acceptance in AuthKit, SSO JIT provisioning, join by domain, WorkOS
 * dashboard edits), so this reconciles from a full recount rather than
 * tracking deltas. The count comes from the local membership mirror through
 * the shared `MemberDirectory`: every in-app membership mutation writes
 * through to the mirror BEFORE calling this, and out-of-band changes land via
 * login and the Events reconciler, so the recount reads the change on the
 * next sign-in exactly as it did against WorkOS — without a WorkOS read.
 *
 * The Autumn call runs off the calling request's critical path, mirroring
 * how execution tracking is forked: billing must never stall or fail a
 * user-facing request. Errors are logged, never surfaced.
 *
 * The count is a PARTIAL one until the mirror has been backfilled from WorkOS
 * (`scripts/backfill-workos-mirror.ts`): before that, the mirror holds only
 * the members who signed in or were changed since the mirror shipped. Because
 * the Autumn write is an authoritative SET, pushing a partial count would
 * under-bill every organization until the backfill ran, so the recount is
 * skipped — with a warning — while the mirror's backfill marker is absent.
 * The gate (`reserveMemberSlot`) keeps working from the same mirror; it only
 * ever under-counts in that window and heals with the backfill.
 *
 * The COUNT is read inline, not in the fork: `MemberDirectory` is per-request
 * (it holds the request's postgres socket, which Cloudflare Workers' I/O
 * isolation ties to the request), so a forked fiber reading it could outlive
 * the socket. One indexed local query is cheap enough to pay inline; only the
 * Autumn call — over the boot-scoped `AutumnService` — is forked, so the
 * forked fiber captures nothing request-scoped.
 */
export const forkReportMemberSeats = (
  organizationId: string,
): Effect.Effect<void, never, MemberDirectory | WorkOsMirror | AutumnService> =>
  Effect.gen(function* () {
    const directory = yield* MemberDirectory;
    const mirror = yield* WorkOsMirror;
    const autumn = yield* AutumnService;
    const backfilledAt = yield* mirror.backfillCompletedAt();
    if (backfilledAt === null) {
      yield* Effect.logWarning(
        "reportMemberSeats: skipped — the membership mirror has not been backfilled from WorkOS (run db:backfill-workos-mirror:prod)",
        { organizationId },
      );
      return;
    }
    const seats = yield* directory
      .members(organizationId, { statuses: ["active"] })
      .pipe(Effect.map((members) => members.length));
    yield* Effect.sync(() => {
      Effect.runFork(autumn.setMemberSeats(organizationId, seats));
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("reportMemberSeats: seat recount failed", { organizationId, error }),
    ),
    Effect.withSpan("billing.reportMemberSeats"),
  );
