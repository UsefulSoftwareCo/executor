// ---------------------------------------------------------------------------
// Seat-count reporting — the WorkOS → Autumn reconciliation for seat billing
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { waitUntil } from "cloudflare:workers";

import { WorkOSClient } from "../../auth/workos";
import { AutumnService } from "./service";

/**
 * Report the organization's billable seat count to Autumn: active members
 * only — a pending invite occupies a seat for the plan gate but is not
 * billed until the person joins.
 *
 * Seats change through paths the app never sees a mutation for (invitation
 * acceptance in AuthKit, SSO JIT provisioning, join by domain, WorkOS
 * dashboard edits), so this reconciles from a full recount rather than
 * tracking deltas. It runs after in-app membership mutations AND on every
 * login callback, so drift from out-of-band changes heals on the next
 * sign-in. Fire-and-forget-safe: errors are logged, never surfaced.
 */
export const reportMemberSeats = (
  organizationId: string,
): Effect.Effect<void, never, WorkOSClient | AutumnService> =>
  Effect.gen(function* () {
    const workos = yield* WorkOSClient;
    const autumn = yield* AutumnService;
    const memberships = yield* workos.listOrgMembers(organizationId);
    const seats = memberships.data.filter((m) => m.status === "active").length;
    yield* autumn.setMemberSeats(organizationId, seats);
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("reportMemberSeats: seat recount failed", { organizationId, error }),
    ),
    Effect.withSpan("billing.reportMemberSeats"),
  );

/**
 * Fork `reportMemberSeats` off the calling request, mirroring how execution
 * tracking is forked: billing must never stall or fail a user-facing
 * request. Cloudflare owns the promise through waitUntil, so the recount can
 * finish after the response. Only boot-scoped WorkOS and Autumn services are
 * captured.
 */
export const forkReportMemberSeats = (
  organizationId: string,
): Effect.Effect<void, never, WorkOSClient | AutumnService> =>
  Effect.gen(function* () {
    const ctx = yield* Effect.context<WorkOSClient | AutumnService>();
    yield* Effect.sync(() => {
      waitUntil(Effect.runPromiseWith(ctx)(reportMemberSeats(organizationId)));
    });
  });
