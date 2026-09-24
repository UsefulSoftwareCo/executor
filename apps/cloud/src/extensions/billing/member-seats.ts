// ---------------------------------------------------------------------------
// Seat-count reporting — the membership mirror → Autumn reconciliation for
// seat billing
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { waitUntil } from "cloudflare:workers";

import { MemberDirectory } from "@executor-js/api/server";

import { ensureOrganizationBackfilled } from "../../auth/mirror-feeders";
import type { WorkOSClient } from "../../auth/workos";
import type { WorkOsMirror } from "../../auth/workos-mirror";
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
 * The Autumn call runs off the calling request's critical path: Cloudflare
 * owns its promise through `waitUntil`, so the recount can finish after the
 * response, and billing never stalls or fails a user-facing request. Errors
 * are logged, never surfaced.
 *
 * The count is a PARTIAL one until THIS organization's membership list has
 * been scanned from WorkOS in full (the one-off backfill, or the on-demand
 * scan below): before that, the mirror holds only the members who signed in
 * or were changed since the mirror shipped. Because the Autumn write is an
 * authoritative SET, pushing a partial count would under-bill the
 * organization, so the recount first makes sure the organization is
 * backfilled (`ensureOrganizationBackfilled`: a scan runs now when its
 * per-organization mark is missing) and only then counts. The plan gate
 * (`reserveMemberSlot`) goes through the same step, so it never admits an
 * invite past the plan limit on a partial mirror.
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
): Effect.Effect<void, never, MemberDirectory | WorkOsMirror | WorkOSClient | AutumnService> =>
  Effect.gen(function* () {
    const directory = yield* MemberDirectory;
    const autumn = yield* AutumnService;
    yield* ensureOrganizationBackfilled(organizationId);
    const seats = yield* directory
      .members(organizationId, { statuses: ["active"] })
      .pipe(Effect.map((members) => members.length));
    yield* Effect.sync(() => {
      waitUntil(Effect.runPromise(autumn.setMemberSeats(organizationId, seats)));
    });
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("reportMemberSeats: seat recount failed", {
        organizationId,
      }),
    ),
    Effect.withSpan("billing.reportMemberSeats"),
  );
