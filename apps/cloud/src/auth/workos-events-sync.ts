// ---------------------------------------------------------------------------
// The membership mirror's RECONCILER: replays the WorkOS Events API into
// `WorkOsMirror` so changes made outside Executor — a member removed in the
// WorkOS dashboard, a role edited there, a profile updated, an SSO
// just-in-time join — land in the mirror without anyone signing in.
//
// The Events API is the ONLY source this applies. It is ordered and
// replayable from an event id, so the mirror persists the id of the last
// event it applied (`workos_sync.cursor`) and resumes from there; a webhook
// delivery only pokes a run (`workos-webhook.ts`), it is never applied
// itself, because a webhook is unordered and at-least-once. Two runs may
// overlap (the every-minute cron and a webhook poke), so a page is applied
// and its cursor advanced in ONE transaction that compare-and-sets the
// cursor first (`WorkOsMirror.applyPage`): the run that lost the stream
// writes nothing. The `updatedAt` guard on upserts is not enough on its own
// — a lagging run replaying `membership.updated` after the leading run
// applied that membership's `deleted` would re-insert the revoked row.
// There is no first-run history replay: the one-off backfill
// (`scripts/backfill-workos-mirror.ts`) covers history, so a run with no
// cursor starts one hour back.
//
// A page is PLANNED before its transaction opens: every event becomes a
// mirror write (or is set aside as ignored), and that planning is where the
// only WorkOS read happens — resolving an organization the mirror has never
// seen. A deterministic answer to that read ("WorkOS no longer has this
// organization") skips the event rather than failing the run: a failed run
// re-reads the same page from the same cursor next tick, so one such event
// would freeze the whole mirror, including revocations in every other org.
//
// `organization.deleted` is logged and never applied. Deleting local data is
// cloud's own flow (`db/org-deletion.ts`), sequenced with billing; an event
// must not purge tenant data. `organization.updated` renames an organization
// the mirror already holds — never inserts one, so a rename replayed after
// cloud purged the org cannot resurrect it with a fresh slug.
// ---------------------------------------------------------------------------

import { Clock, Effect, Match, Option } from "effect";
import type { Event as WorkOSEvent } from "@workos-inc/node/worker";

import { resolveOrganization } from "./organization";
import { WorkOSClient } from "./workos";
import {
  WorkOsMirror,
  WorkOsMirrorWrite,
  mirrorMembershipFromWorkOs,
  mirrorUserFromWorkOs,
  type WorkOsMembershipPayload,
  type WorkOsMirrorWriteOutcome,
} from "./workos-mirror";

/**
 * The event types the mirror follows. Invitations are not mirrored (they
 * stay a live WorkOS read), and `organization.created` is not needed: an org
 * is mirrored lazily the first time a membership or a session names it.
 */
export const MIRRORED_EVENT_NAMES = [
  "user.created",
  "user.updated",
  "user.deleted",
  "organization_membership.created",
  "organization_membership.updated",
  "organization_membership.deleted",
  "organization.updated",
  "organization.deleted",
] as const;

export type WorkOsMirroredEventName = (typeof MIRRORED_EVENT_NAMES)[number];

/** The SDK events the reconciler applies, narrowed to the followed types. */
export type WorkOsMirroredEvent = Extract<WorkOSEvent, { readonly event: WorkOsMirroredEventName }>;

const mirroredEventNames: ReadonlySet<string> = new Set(MIRRORED_EVENT_NAMES);

/** Whether an event from the stream is one the mirror follows. */
export const isMirroredEvent = (event: WorkOSEvent): event is WorkOsMirroredEvent =>
  mirroredEventNames.has(event.event);

/**
 * What one event did to the mirror:
 * - `applied`: a row was written or deleted;
 * - `stale`: the `updatedAt` guard refused an older payload (a replay or a
 *   late event behind a fresher write);
 * - `absent`: the row the event targets is not in the mirror — a delete of
 *   an already-gone row, or a rename of an organization never mirrored;
 * - `ignored`: the event is logged and deliberately not applied.
 */
export type WorkOsEventOutcome = WorkOsMirrorWriteOutcome | "ignored";

// A membership event carries only the organization's id, so an org the
// mirror has never seen (created and populated in the WorkOS dashboard
// before anyone signed in) is mirrored first — `resolveOrganization` reads
// it from WorkOS — so the membership's foreign key holds. An org WorkOS no
// longer has (deleted there, or through Executor, after this event was
// emitted) yields no write: its own `organization.deleted` follows in the
// stream, and there is nothing to hold a membership of.
const planMembershipUpsert = (membership: WorkOsMembershipPayload, eventId: string) =>
  Effect.gen(function* () {
    // Only a 404 says the organization is gone. A 401/403 is a credentials
    // or permissions problem with THIS deployment, and 429/5xx/no status is
    // a blip: all of those must fail the run so the event is retried once
    // fixed, not be skipped and lost.
    const organization = yield* resolveOrganization(membership.organizationId).pipe(
      Effect.catchTag("WorkOSError", (error) =>
        error.status === 404
          ? Effect.logWarning(
              "workos_events: membership for an organization WorkOS no longer has; skipped",
              { organizationId: membership.organizationId, eventId },
            ).pipe(Effect.as(null))
          : Effect.fail(error),
      ),
    );
    if (organization === null) return Option.none();
    return Option.some(
      WorkOsMirrorWrite.UpsertMembership({ membership: mirrorMembershipFromWorkOs(membership) }),
    );
  });

/**
 * Translate one event into the mirror write it calls for, or `None` when the
 * event is deliberately not applied (logged). This is the only step that may
 * read WorkOS; it runs before the page's transaction opens. Fails on a
 * user-store failure or a WorkOS failure that a retry could clear — the run
 * stops before the page is applied, so the event is retried next run.
 */
export const planEvent = Effect.fn("workos_events.plan")(function* (event: WorkOsMirroredEvent) {
  yield* Effect.annotateCurrentSpan({
    "workos.event": event.event,
    "workos.event_id": event.id,
  });
  return yield* Match.value(event).pipe(
    Match.discriminatorsExhaustive("event")({
      "user.created": ({ data }) =>
        Effect.succeed(
          Option.some(WorkOsMirrorWrite.UpsertUser({ user: mirrorUserFromWorkOs(data) })),
        ),
      "user.updated": ({ data }) =>
        Effect.succeed(
          Option.some(WorkOsMirrorWrite.UpsertUser({ user: mirrorUserFromWorkOs(data) })),
        ),
      "user.deleted": ({ data }) =>
        Effect.succeed(Option.some(WorkOsMirrorWrite.DeleteUser({ accountId: data.id }))),
      "organization_membership.created": ({ data }) => planMembershipUpsert(data, event.id),
      "organization_membership.updated": ({ data }) => planMembershipUpsert(data, event.id),
      "organization_membership.deleted": ({ data }) =>
        Effect.succeed(Option.some(WorkOsMirrorWrite.DeleteMembership({ membershipId: data.id }))),
      "organization.updated": ({ data }) =>
        Effect.succeed(
          Option.some(
            WorkOsMirrorWrite.RenameOrganization({ organizationId: data.id, name: data.name }),
          ),
        ),
      "organization.deleted": ({ data }) =>
        Effect.logWarning(
          "workos_events: organization.deleted received; local data is kept — deletion is cloud's own flow (db/org-deletion.ts)",
          { organizationId: data.id, eventId: event.id },
        ).pipe(Effect.as(Option.none<WorkOsMirrorWrite>())),
    }),
  );
});

// One page is one WorkOS read and one cursor advance. 100 is the API's
// maximum; the page budget bounds a single run (a backlog after an outage
// drains over successive runs, each committing what it applied) so a cron
// invocation stays well inside the Worker's wall-clock limits.
const PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 20;
// With no cursor yet, read from one hour back. The backfill covers history;
// the hour absorbs the gap between the backfill and the first run.
const FIRST_RUN_LOOKBACK_MS = 60 * 60 * 1000;

export interface WorkOsEventsSyncReport {
  readonly pages: number;
  readonly events: number;
  readonly applied: number;
  readonly stale: number;
  readonly absent: number;
  readonly ignored: number;
  /**
   * Why the run ended: the stream was read to its end (`drained`), another
   * run moved the cursor first (`cursor_contended`), or the page budget for
   * one run was spent with more to read (`page_budget`).
   */
  readonly stopped: "drained" | "cursor_contended" | "page_budget";
  /** The cursor this run left behind (the last event id it committed). */
  readonly cursor: string | null;
}

/**
 * One reconciler run: read the cursor, page the Events API from it (oldest
 * first), plan every event, and apply each page with its cursor advance in
 * one transaction. Stops as soon as that transaction finds the cursor moved
 * — another run owns the stream, and nothing from the page was written —
 * and fails (before the page is applied) on the first WorkOS, mirror, or
 * user-store failure, so nothing is skipped: the next run resumes from the
 * last committed page.
 */
export const syncWorkOsEvents = Effect.fn("workos_events.sync")(function* () {
  const workos = yield* WorkOSClient;
  const mirror = yield* WorkOsMirror;
  const now = yield* Clock.currentTimeMillis;
  const rangeStart = new Date(now - FIRST_RUN_LOOKBACK_MS).toISOString();

  let cursor = yield* mirror.getCursor();
  const counts = {
    pages: 0,
    events: 0,
    applied: 0,
    stale: 0,
    absent: 0,
    ignored: 0,
  };
  let stopped: WorkOsEventsSyncReport["stopped"] = "page_budget";

  while (counts.pages < MAX_PAGES_PER_RUN) {
    const page = yield* workos.listEvents({
      events: MIRRORED_EVENT_NAMES,
      limit: PAGE_SIZE,
      order: "asc",
      ...(cursor === null ? { rangeStart } : { after: cursor }),
    });
    counts.pages += 1;
    if (page.data.length === 0) {
      stopped = "drained";
      break;
    }

    // Plan first (the WorkOS reads), then apply under the cursor lock.
    let lastEventId = cursor;
    let ignored = 0;
    const planned: { readonly event: WorkOsMirroredEvent; readonly write: WorkOsMirrorWrite }[] =
      [];
    for (const event of page.data) {
      counts.events += 1;
      lastEventId = event.id;
      if (!isMirroredEvent(event)) {
        // The request named the followed types; anything else is a WorkOS
        // change of contract worth seeing, not a reason to stop the stream.
        yield* Effect.logWarning("workos_events: unrequested event type skipped", {
          event: event.event,
          eventId: event.id,
        });
        continue;
      }
      const write = yield* planEvent(event);
      if (Option.isNone(write)) {
        ignored += 1;
        continue;
      }
      planned.push({ event, write: write.value });
    }

    // `lastEventId` is an event id here: the page was non-empty.
    if (lastEventId === null) break;
    const outcomes = yield* mirror.applyPage(
      cursor,
      lastEventId,
      planned.map((p) => p.write),
    );
    if (Option.isNone(outcomes)) {
      yield* Effect.logWarning("workos_events: cursor moved by another run; stopping", {
        expected: cursor,
      });
      stopped = "cursor_contended";
      break;
    }
    counts.ignored += ignored;
    for (const [index, outcome] of outcomes.value.entries()) {
      counts[outcome] += 1;
      if (outcome === "absent") {
        // Normal for a replayed delete; for a rename it means the org was
        // never mirrored or was purged by cloud — either way nothing to do.
        yield* Effect.logInfo("workos_events: event targets a row the mirror does not hold", {
          event: planned[index]?.event.event,
          eventId: planned[index]?.event.id,
        });
      }
    }
    cursor = lastEventId;
    if (!page.listMetadata.after) {
      stopped = "drained";
      break;
    }
  }

  const report: WorkOsEventsSyncReport = { ...counts, stopped, cursor };
  yield* Effect.logInfo("workos_events: sync run finished", report);
  return report;
});
