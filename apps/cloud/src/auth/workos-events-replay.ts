// ---------------------------------------------------------------------------
// The membership mirror's RECONCILER, as a pure function over its ports:
// replays the WorkOS Events API into the mirror store so changes made
// outside Executor — a member removed in the WorkOS dashboard, a role edited
// there, a profile updated, an SSO just-in-time join — land in the mirror
// without anyone signing in.
//
// Kept free of `cloudflare:workers` (no `DbService`, no `env`, no
// `WorkOSClient`), like `workos-mirror-store.ts` and
// `workos-mirror-backfill.ts`, so the SAME replay runs in three places: the
// Worker's every-minute cron and the signed webhook poke
// (`workos-events-sync.ts` binds the ports to the request-scoped services),
// and the deploy gate (`scripts/ensure-workos-mirror-ready.ts`, through
// `scripts/drain-workos-events.ts`) that must bring the mirror up to date
// BEFORE the build that authorizes from it goes live — and cannot wait on a
// cron that may not be deployed yet. The ports are the WorkOS reads a replay
// makes (`WorkOsEventsSource`), the organization and account rows it
// consults (`WorkOsEventsStore`), and the mirror store it writes.
//
// The Events API is the ONLY source this applies. It is ordered and
// replayable from an event id, so the mirror persists the id of the last
// event it applied (`workos_sync.cursor`) and resumes from there; a webhook
// delivery only pokes a run (`workos-webhook.ts`), it is never applied
// itself, because a webhook is unordered and at-least-once. Two runs may
// overlap (the every-minute cron, a webhook poke, the deploy gate), so a
// page is applied and its cursor advanced in ONE transaction that
// compare-and-sets the cursor first (`WorkOsMirrorShape.applyPage`): the run
// that lost the stream writes nothing. The `updatedAt` guard on upserts is
// not enough on its own — a lagging run replaying `membership.updated` after
// the leading run applied that membership's `deleted` would re-insert the
// revoked row. There is no first-run history replay: the one-off backfill
// (`scripts/backfill-workos-mirror.ts`) covers history, and its first run
// records the instant it began reading WorkOS as the REPLAY BOUNDARY
// (`workos_sync.range_start`) before it lists anything. A run with no cursor
// reads the stream from that boundary — never from a wall-clock guess, which
// would silently drop every revocation older than the guess — and with no
// boundary either it does nothing but warn: the backfill has not run, and
// there is no honest place to start. The boundary never moves: a backfill
// retry or re-run refreshes memberships only, so the organization renames
// and user deletions after the first boundary are this stream's alone to
// apply.
//
// A deletion event tombstones its row as of the event's own `createdAt`,
// not the payload's `updatedAt` (which predates the delete): the tombstone
// must be newer than every payload a feeder could have fetched before the
// delete, so none of them can reinstate the row.
//
// A page is PLANNED before its transaction opens: every event becomes a
// mirror write, and that planning is where the only WorkOS reads happen —
// resolving an organization the mirror has never seen, and reading the
// profile of a member the mirror has never seen. A membership event carries
// no profile, and the `user.created` that would have carried it may predate
// the replay boundary: a user who existed before the mirror shipped and
// joins an organization the backfill has already scanned gets a bare
// account row from the membership write, and nothing in the stream would
// ever fill it — the member would be unsearchable by name or email until an
// unrelated profile update or sign-in. So a membership created or updated
// for an account the mirror holds no profile for (no row, or the bare row a
// membership write mints) is planned WITH the profile (`UpsertMember`), one
// `getUser` per such member, never per event. A deterministic answer to
// either read ("WorkOS no longer has this organization / user") does not
// fail the run — a failed run re-reads the same page from the same cursor
// next tick, so one such event would freeze the whole mirror, including
// revocations in every other org — but it is not dropped either: a gone
// organization MARKS the organization deleted (below), the same write its
// own `organization.deleted` further down the stream makes; a gone user is
// mirrored without a profile, and their own `user.deleted` follows.
//
// `organization.deleted` MARKS the organization deleted
// (`organizations.deleted_at`, the same mark cloud's own deletion flow sets
// and its purge keeps as a tombstone): the mirror is the membership read
// path, so an org deleted in the WorkOS dashboard must stop authorizing its
// members' sessions here, and this event is the only way that reaches the
// mirror. The mark is written HERE, in the first build that consumes the
// event, so no `organization.deleted` is ever drained from the stream
// without effect — an event consumed before the mark existed could never be
// replayed. For the same reason an organization the mirror has never seen
// gets a TOMBSTONE row minted: with no row, a login that fetched its
// memberships before the deletion and stalled would mint the organization
// live afterwards, and nothing left in the stream would ever revoke it. It
// never PURGES: deleting tenant data and secrets is cloud's own flow
// (`db/org-deletion.ts`), sequenced with billing and confirmed by an admin,
// and an event must not do it. An org already marked (by cloud's own flow,
// or a replay) is `absent` and nothing changes. `organization.updated` renames an
// organization the mirror already holds — never inserts one, so a rename
// replayed after cloud purged the org cannot resurrect it with a fresh slug
// — under the same name guard every feeder applies, so a rename event and
// a sign-in's name order each other by their stamps however they arrive.
// ---------------------------------------------------------------------------

import { Clock, Effect, Match, Option } from "effect";
import type { Event as WorkOSEvent } from "@workos-inc/node/worker";

import type { Account, Organization, OrganizationPayload } from "./user-store";
import type { WorkOSListEventsOptions } from "./workos";
import {
  WorkOsMirrorWrite,
  mirrorMembershipFromWorkOs,
  mirrorUserFromWorkOs,
  type WorkOsMembershipPayload,
  type WorkOsMirrorShape,
  type WorkOsMirrorUser,
  type WorkOsMirrorWriteOutcome,
  type WorkOsUserPayload,
} from "./workos-mirror-store";

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
 * - `applied`: a row was written, marked, or tombstoned;
 * - `stale`: the `updatedAt` guard refused an older payload (a replay or a
 *   late event behind a fresher write);
 * - `absent`: a delete found its row already tombstoned or superseded by a
 *   newer membership (a replayed delete), a rename found no live
 *   organization row — the mirror has never seen it, or it is marked
 *   deleted — or a deletion mark found the organization already marked.
 */
export type WorkOsEventOutcome = WorkOsMirrorWriteOutcome;

/** One page of the Events API stream, as the source hands it to the replay. */
export interface WorkOsEventsPage {
  readonly data: readonly WorkOSEvent[];
  /** The id to resume after, or `null` at the end of the stream. */
  readonly after: string | null;
}

/** The WorkOS organization fields the replay reads to mint an org row. */
export interface WorkOsOrganizationPayload {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
}

/**
 * The WorkOS reads one replay makes, over whatever client the caller wires:
 * the Events API page, and — only for a membership event whose organization
 * or member the mirror has never seen — the organization or user resource.
 * The two lookups answer `None` when WorkOS no longer has the resource (a
 * 404): that is a deterministic answer the replay acts on, not a failure.
 * Every other failure (401/403, 429, 5xx, no answer) is `E` and fails the
 * run, so the event is retried once the cause is fixed rather than skipped.
 */
export interface WorkOsEventsSource<E> {
  readonly listEvents: (options: WorkOSListEventsOptions) => Effect.Effect<WorkOsEventsPage, E>;
  readonly getOrganization: (
    organizationId: string,
  ) => Effect.Effect<Option.Option<WorkOsOrganizationPayload>, E>;
  readonly getUser: (userId: string) => Effect.Effect<Option.Option<WorkOsUserPayload>, E>;
}

/**
 * The organization and account rows a replay consults while planning a
 * page: the org row a membership's foreign key needs (minted from WorkOS
 * through `upsertOrganization` when the mirror has never seen it — the one
 * slug mint point) and the account row that says whether the member's
 * profile is already held.
 */
export interface WorkOsEventsStore<E> {
  readonly getOrganization: (organizationId: string) => Effect.Effect<Organization | null, E>;
  readonly upsertOrganization: (
    organization: OrganizationPayload,
  ) => Effect.Effect<Organization, E>;
  readonly getAccount: (accountId: string) => Effect.Effect<Account | null, E>;
}

/** Everything one replay reads and writes. */
export interface WorkOsEventsReplayDeps<E> {
  readonly source: WorkOsEventsSource<E>;
  readonly store: WorkOsEventsStore<E>;
  readonly mirror: WorkOsMirrorShape;
}

/** A membership event's payload: the SDK's `OrganizationMembership`, which names its organization. */
interface WorkOsMembershipEventPayload extends WorkOsMembershipPayload {
  readonly organizationName: string;
}

// The organization row a membership event needs: the mirror's, or — for an
// org the mirror has never seen (created and populated in the WorkOS
// dashboard before anyone signed in) — minted from the WorkOS organization
// so the membership's foreign key holds. `None` when WorkOS no longer has
// the organization.
const resolveOrganization = <E>(
  deps: WorkOsEventsReplayDeps<E>,
  organizationId: string,
): Effect.Effect<Option.Option<Organization>, E> =>
  Effect.gen(function* () {
    const existing = yield* deps.store.getOrganization(organizationId);
    if (existing) return Option.some(existing);
    const fresh = yield* deps.source.getOrganization(organizationId);
    if (Option.isNone(fresh)) return Option.none();
    const minted = yield* deps.store.upsertOrganization({
      id: fresh.value.id,
      name: fresh.value.name,
      updatedAt: new Date(fresh.value.updatedAt),
    });
    return Option.some(minted);
  });

// A membership event carries only the organization's id, so an org the
// mirror has never seen is mirrored first (`resolveOrganization`) so the
// membership's foreign key holds. That goes for a DELETE too: it leaves a
// tombstone behind even when the mirror has never seen the membership (so
// the backfill's older payload cannot insert it live), and the tombstone row
// needs the org as much as a live one. An org WorkOS no longer has (deleted
// there, or through Executor, after this event was emitted) is MARKED
// deleted instead — minting its tombstone row when the mirror has never
// seen it — so a login still holding a membership of it cannot mint it
// live: its own `organization.deleted` follows in the stream and finds the
// mark already there, and the membership itself is not written, there is
// nothing live to hold it.
const planMembershipWrite = <E>(
  deps: WorkOsEventsReplayDeps<E>,
  membership: WorkOsMembershipEventPayload,
  event: { readonly id: string; readonly createdAt: string },
  write: () => Effect.Effect<WorkOsMirrorWrite, E>,
): Effect.Effect<WorkOsMirrorWrite, E> =>
  Effect.gen(function* () {
    const organization = yield* resolveOrganization(deps, membership.organizationId);
    if (Option.isNone(organization)) {
      yield* Effect.logWarning(
        "workos_events: membership for an organization WorkOS no longer has; marking the org deleted instead",
        { organizationId: membership.organizationId, eventId: event.id },
      );
      return WorkOsMirrorWrite.MarkOrganizationDeleted({
        organizationId: membership.organizationId,
        name: membership.organizationName,
        deletedAt: new Date(event.createdAt),
      });
    }
    return yield* write();
  });

// Whether the mirror holds a profile for the account: none at all, or only
// the bare row a membership write mints (`ensureAccount`: no email, no
// stamp), calls for a WorkOS read. A deletion tombstone (no email, stamped
// by `deleteUser`) does not: WorkOS never reuses a user id, and the
// membership write refuses the account anyway.
const holdsNoProfile = (account: Account | null): boolean =>
  account === null || (account.email === null && account.workosUpdatedAt === null);

/**
 * The user ids whose profile an earlier event of the SAME page has already
 * planned a write for (`user.created` / `user.updated`, or a profile read
 * for a membership). A page is planned in full before it is applied, so the
 * mirror does not yet hold what the page's own earlier events carry; this
 * is what keeps a `user.created` followed by that user's membership in one
 * page from reading the profile WorkOS just streamed.
 */
export type PlannedProfiles = Set<string>;

// The member's profile from WorkOS, when neither the mirror nor an earlier
// event of the page holds one (see the header); `null` when one does, or
// when WorkOS no longer has the user (the user's own `user.deleted` follows
// in the stream, or has been applied).
const planMemberProfile = <E>(
  deps: WorkOsEventsReplayDeps<E>,
  userId: string,
  event: { readonly id: string },
  profiled: PlannedProfiles,
): Effect.Effect<WorkOsMirrorUser | null, E> =>
  Effect.gen(function* () {
    if (profiled.has(userId)) return null;
    const account = yield* deps.store.getAccount(userId);
    if (!holdsNoProfile(account)) return null;
    const user = yield* deps.source.getUser(userId);
    if (Option.isNone(user)) {
      yield* Effect.logWarning(
        "workos_events: membership for a user WorkOS no longer has; mirrored without a profile",
        { eventId: event.id },
      );
      return null;
    }
    profiled.add(userId);
    return mirrorUserFromWorkOs(user.value);
  });

const planMembershipUpsert = <E>(
  deps: WorkOsEventsReplayDeps<E>,
  membership: WorkOsMembershipEventPayload,
  event: { readonly id: string; readonly createdAt: string },
  profiled: PlannedProfiles,
) =>
  planMembershipWrite(deps, membership, event, () =>
    Effect.map(planMemberProfile(deps, membership.userId, event, profiled), (user) =>
      user === null
        ? WorkOsMirrorWrite.UpsertMembership({
            membership: mirrorMembershipFromWorkOs(membership),
          })
        : WorkOsMirrorWrite.UpsertMember({
            user,
            membership: mirrorMembershipFromWorkOs(membership),
          }),
    ),
  );

/**
 * Translate one event into the mirror write it calls for. Every followed
 * event yields a write: none is drained from the stream without effect.
 * This is the only step that may read WorkOS (an organization the mirror
 * has never seen, a member it holds no profile for); it runs before the
 * page's transaction opens. Fails on a store failure or a WorkOS failure
 * that a retry could clear — the run stops before the page is applied, so
 * the event is retried next run. `profiled` is the page's running set of
 * users whose profile is already planned (see {@link PlannedProfiles}); one
 * set per page.
 */
export const planWorkOsEvent = <E>(
  deps: WorkOsEventsReplayDeps<E>,
  event: WorkOsMirroredEvent,
  profiled: PlannedProfiles = new Set(),
): Effect.Effect<WorkOsMirrorWrite, E> => {
  const userWrite = (data: WorkOsUserPayload) =>
    Effect.sync(() => {
      profiled.add(data.id);
      return WorkOsMirrorWrite.UpsertUser({ user: mirrorUserFromWorkOs(data) });
    });
  return Match.value(event).pipe(
    Match.discriminatorsExhaustive("event")({
      "user.created": ({ data }) => userWrite(data),
      "user.updated": ({ data }) => userWrite(data),
      "user.deleted": ({ data }) =>
        Effect.succeed(
          WorkOsMirrorWrite.DeleteUser({
            accountId: data.id,
            deletedAt: new Date(event.createdAt),
          }),
        ),
      "organization_membership.created": ({ data }) =>
        planMembershipUpsert(deps, data, event, profiled),
      "organization_membership.updated": ({ data }) =>
        planMembershipUpsert(deps, data, event, profiled),
      "organization_membership.deleted": ({ data }) =>
        planMembershipWrite(deps, data, event, () =>
          Effect.succeed(
            WorkOsMirrorWrite.DeleteMembership({
              membership: {
                id: data.id,
                accountId: data.userId,
                organizationId: data.organizationId,
              },
              deletedAt: new Date(event.createdAt),
            }),
          ),
        ),
      "organization.updated": ({ data }) =>
        Effect.succeed(
          WorkOsMirrorWrite.RenameOrganization({
            organizationId: data.id,
            name: data.name,
            updatedAt: new Date(data.updatedAt),
          }),
        ),
      "organization.deleted": ({ data }) =>
        Effect.logWarning(
          "workos_events: organization.deleted received; marking the org deleted locally — tenant data is kept (purging is cloud's own flow, db/org-deletion.ts)",
          { organizationId: data.id, eventId: event.id },
        ).pipe(
          Effect.as(
            WorkOsMirrorWrite.MarkOrganizationDeleted({
              organizationId: data.id,
              name: data.name,
              deletedAt: new Date(event.createdAt),
            }),
          ),
        ),
    }),
  );
};

// One page is one WorkOS read and one cursor advance. 100 is the API's
// maximum; the page budget bounds a single run (a backlog after an outage
// drains over successive runs, each committing what it applied) so a cron
// invocation stays well inside the Worker's wall-clock limits.
const PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 20;

export interface WorkOsEventsSyncReport {
  readonly pages: number;
  readonly events: number;
  readonly applied: number;
  readonly stale: number;
  readonly absent: number;
  /**
   * Why the run ended: the stream was read to its end (`drained`), another
   * run moved the cursor first (`cursor_contended`), the page budget for one
   * run was spent with more to read (`page_budget`), or there is neither a
   * cursor nor a replay boundary to start from — the backfill has not run —
   * so nothing was read (`awaiting_backfill`).
   */
  readonly stopped: "drained" | "cursor_contended" | "page_budget" | "awaiting_backfill";
  /** The cursor this run left behind (the last event id it committed). */
  readonly cursor: string | null;
}

/**
 * One reconciler run: read the cursor (or, before the first page was ever
 * committed, the backfill's replay boundary), page the Events API from it
 * (oldest first), plan every event, and apply each page with its cursor
 * advance in one transaction. Stops as soon as that transaction finds the
 * cursor moved — another run owns the stream, and nothing from the page was
 * written — and fails (before the page is applied) on the first source,
 * store, or mirror failure, so nothing is skipped: the next run resumes
 * from the last committed page. With neither cursor nor boundary it reads
 * nothing and reports `awaiting_backfill`. A run that reads the stream to
 * its end records the drain (`markDrained`) as of its own start.
 */
export const replayWorkOsEvents = <E>(deps: WorkOsEventsReplayDeps<E>) =>
  Effect.gen(function* () {
    const { source, mirror } = deps;

    // Taken before the first read, so the drained mark below cannot
    // post-date an event this run never saw.
    const startedAt = new Date(yield* Clock.currentTimeMillis);
    let cursor = yield* mirror.getCursor();
    const counts = {
      pages: 0,
      events: 0,
      applied: 0,
      stale: 0,
      absent: 0,
    };
    let stopped: WorkOsEventsSyncReport["stopped"] = "page_budget";

    // Where the next page starts: after the last committed event id, or —
    // for the very first read, which has no id to resume from — at the
    // backfill's replay boundary, the only instant known to be covered.
    let resume: { readonly after: string } | { readonly rangeStart: string };
    if (cursor === null) {
      const boundary = yield* mirror.replayBoundary();
      if (boundary === null) {
        yield* Effect.logWarning(
          "workos_events: no cursor and no replay boundary — the mirror backfill has not run (db:backfill-workos-mirror:prod); nothing read",
        );
        const report: WorkOsEventsSyncReport = {
          ...counts,
          stopped: "awaiting_backfill",
          cursor,
        };
        return report;
      }
      resume = { rangeStart: boundary.toISOString() };
    } else {
      resume = { after: cursor };
    }

    while (counts.pages < MAX_PAGES_PER_RUN) {
      const page = yield* source.listEvents({
        events: MIRRORED_EVENT_NAMES,
        limit: PAGE_SIZE,
        order: "asc",
        ...resume,
      });
      counts.pages += 1;
      if (page.data.length === 0) {
        stopped = "drained";
        break;
      }

      // Plan first (the WorkOS reads), then apply under the cursor lock.
      let lastEventId = cursor;
      const profiled: PlannedProfiles = new Set();
      const planned: {
        readonly event: WorkOsMirroredEvent;
        readonly write: WorkOsMirrorWrite;
      }[] = [];
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
        planned.push({ event, write: yield* planWorkOsEvent(deps, event, profiled) });
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
      for (const [index, outcome] of outcomes.value.entries()) {
        counts[outcome] += 1;
        if (outcome === "absent") {
          // Normal for a replayed delete; for a rename it means the org was
          // never mirrored or is marked deleted, and for a deletion mark
          // that it is already marked — either way nothing to do.
          yield* Effect.logInfo("workos_events: event targets a row the mirror does not hold", {
            event: planned[index]?.event.event,
            eventId: planned[index]?.event.id,
          });
        }
      }
      cursor = lastEventId;
      resume = { after: cursor };
      if (page.after === null) {
        stopped = "drained";
        break;
      }
    }

    if (stopped === "drained") {
      // The stream was read to its end: everything WorkOS had emitted by
      // the time this run began is now in the mirror. Recorded as of the
      // run's START, not its end — an event emitted while the run was
      // reading may still be ahead of the last page it saw — so the mark
      // never claims more than was covered. This is what the authorization
      // path reads to tell a caught-up mirror from one whose reconciler has
      // stalled.
      yield* mirror.markDrained(startedAt);
    }

    const report: WorkOsEventsSyncReport = { ...counts, stopped, cursor };
    yield* Effect.logInfo("workos_events: sync run finished", report);
    return report;
  }).pipe(Effect.withSpan("workos_events.replay"));
