// ---------------------------------------------------------------------------
// Subject sightings — the ONLY writer of the `subject` table.
//
// `subject` is the join between a host's identity system and the `subject`
// partition key smeared across the owned tables (see `core-schema.ts`). A
// principal earns a row the first time it is seen, so "which users exist under
// this tenant" stops being answerable only through their connection rows.
//
// Two seams call this, and both hand over their raw (unbound) FumaDB handle so
// the binding rule lives here rather than at each call site:
//   - `makeScopedExecutor` (@executor-js/api/server) — every HTTP request and
//     MCP session on every host passes through it. THE hot path.
//   - `connections.create` (executor.ts) — so a subject exists even for a
//     direct SDK/CLI caller that never went through the request seam.
//
// Two properties the callers depend on:
//   - THROTTLED. A sighting on the request path must not cost a write per
//     request, so `last_seen_at` is only rewritten once the persisted value is
//     older than the interval. A process-local memory of who was already filed
//     inside the window keeps the steady state at ZERO queries: the throttle
//     alone still spent an indexed read per request just to learn the write was
//     unnecessary, and on the request seam that read is the whole cost.
//   - NON-FATAL. A sighting is bookkeeping. Losing one must never fail the
//     request that produced it — but it is logged, never silently swallowed.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { withQueryContext, type Condition, type ConditionBuilder } from "@executor-js/fumadb/query";
import type { AnyColumn } from "@executor-js/fumadb/schema";

import { makeFumaClient, type FumaDb, type StorageFailure } from "./fuma-runtime";
import type { ExecutorOwnerPolicyContext } from "./owner-policy";

type AnyCb = ConditionBuilder<Record<string, AnyColumn>>;

// The query surface `touchSubject` needs, loosely typed. `fuma.use` hands back a
// `FumaQuery<AnySchema>` whose table-name generics can't be resolved against an
// erased schema; executor.ts narrows the same way (`asLooseStorageDb`).
type LooseSubjectDb = {
  readonly create: (tableName: string, row: Record<string, unknown>) => Promise<unknown>;
  readonly findFirst: (
    tableName: string,
    options: unknown,
  ) => Promise<Record<string, unknown> | null>;
  readonly updateMany: (tableName: string, options: unknown) => Promise<void>;
};

const asLooseSubjectDb = (db: unknown): LooseSubjectDb => db as LooseSubjectDb;

/**
 * How stale `last_seen_at` must be before a sighting rewrites it. Deliberately
 * coarse: the column answers "is this principal still around", not "when
 * exactly was their last call", and the request path pays for every write.
 */
export const DEFAULT_SUBJECT_LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000;

/**
 * Principals this process has already filed a sighting for, and when. The
 * throttle above bounds how often `last_seen_at` is REWRITTEN, but on its own
 * it still pays an indexed read per request to discover that the write can be
 * skipped — and the request seam runs on every HTTP request and MCP session.
 * Remembering the last sighting per `(tenant, external_id)` makes the steady
 * state cost zero queries instead of one.
 *
 * Process-local and advisory by construction:
 *   - A cold process re-reads once per principal, which is exactly the
 *     first-sight path that has to touch the row anyway.
 *   - A stale entry can only delay a `last_seen_at` bump by under the throttle
 *     window, which the column's coarse contract already tolerates.
 *   - It is never consulted to decide that a row EXISTS: an entry is recorded
 *     only after the row was created or confirmed present.
 *
 * Bounded so a long-lived host with heavy principal churn cannot grow it
 * without limit; eviction only costs the evicted principal one extra read.
 */
const MAX_TRACKED_SUBJECTS = 10_000;

const lastTouchedAt = new Map<string, number>();

const touchCacheKey = (tenant: string, externalId: string) => `${tenant}\u0000${externalId}`;

const rememberTouch = (key: string, at: number): void => {
  // Re-insert so the key moves to the end of the Map's insertion order, making
  // the oldest-touched entry the natural eviction target.
  lastTouchedAt.delete(key);
  lastTouchedAt.set(key, at);
  if (lastTouchedAt.size > MAX_TRACKED_SUBJECTS) {
    const oldest = lastTouchedAt.keys().next();
    if (!oldest.done) lastTouchedAt.delete(oldest.value);
  }
};

/** Test seam: drop the process-local sighting memory. */
export const resetSubjectTouchCache = (): void => {
  lastTouchedAt.clear();
};

export interface TouchSubjectInput {
  /** The tenant the sighting is filed under. Written explicitly — the tenant
   *  policy REJECTS a create whose `tenant` differs from the bound context. */
  readonly tenant: string;
  /** The host-auth principal id, or `null` for a pure-org executor (nothing to
   *  record). Opaque: it also carries host sentinels like `"local"`. */
  readonly externalId: string | null;
  /** Override the `last_seen_at` rewrite interval. Tests use it to pin both
   *  sides of the throttle; production callers take the default. */
  readonly lastSeenThrottleMs?: number;
}

export const VERIFIED_HUMAN_SUBJECT_STATUS = "verified-human";
/**
 * A revoked human is deliberately represented by a durable tombstone. A
 * later browser sighting can prove that the subject exists, but it must not
 * silently re-enable delegation after an operator offboards the account.
 */
export const REVOKED_HUMAN_SUBJECT_STATUS = "delegation-revoked";

/**
 * Small persistent seam for hosts that keep their authoritative membership
 * directory outside the SDK. Hosts may wrap this with their membership read;
 * an absent or non-verified row always returns false.
 */
export interface VerifiedHumanSubjectRegistry {
  readonly isVerifiedHuman: (input: {
    readonly tenant: string;
    readonly subject: string;
  }) => Effect.Effect<boolean, StorageFailure>;
  readonly markVerifiedHuman: (input: {
    readonly tenant: string;
    readonly subject: string;
  }) => Effect.Effect<void, StorageFailure>;
  readonly revokeVerifiedHuman: (input: {
    readonly tenant: string;
    readonly subject: string;
  }) => Effect.Effect<void, StorageFailure>;
}

/** Build the SDK's persistent registry seam. The caller remains responsible
 * for proving the human before calling markVerifiedHuman. */
export const makeVerifiedHumanSubjectRegistry = (db: FumaDb<any>): VerifiedHumanSubjectRegistry => {
  const lookup = (input: { readonly tenant: string; readonly subject: string }) =>
    makeFumaClient(
      withQueryContext(db, {
        tenant: input.tenant,
        subject: null,
      } satisfies ExecutorOwnerPolicyContext),
    );
  const where =
    (input: { readonly tenant: string; readonly subject: string }) =>
    (builder: AnyCb): Condition | boolean =>
      builder.and(builder("tenant", "=", input.tenant), builder("external_id", "=", input.subject));
  const writableWhere =
    (input: { readonly tenant: string; readonly subject: string }) =>
    (builder: AnyCb): Condition | boolean =>
      builder.and(
        where(input)(builder),
        // SQL NULL does not satisfy `!=`, so explicitly include the ordinary
        // sighting state as well as any non-revoked lifecycle value.
        builder.or(builder.isNull("status"), builder("status", "!=", REVOKED_HUMAN_SUBJECT_STATUS)),
      );
  const isVerifiedHuman = (input: { readonly tenant: string; readonly subject: string }) =>
    lookup(input)
      .use("subject.verifiedHuman.get", (query) =>
        asLooseSubjectDb(query).findFirst("subject", { where: where(input) }),
      )
      .pipe(Effect.map((row) => row?.["status"] === VERIFIED_HUMAN_SUBJECT_STATUS));
  const markVerifiedHuman = (input: { readonly tenant: string; readonly subject: string }) =>
    Effect.gen(function* () {
      const fuma = lookup(input);
      const existing = yield* fuma.use("subject.verifiedHuman.get", (query) =>
        asLooseSubjectDb(query).findFirst("subject", { where: where(input) }),
      );
      if (existing?.["status"] === REVOKED_HUMAN_SUBJECT_STATUS) return;

      if (existing) {
        // The lifecycle predicate makes this a no-op if a revoke wins a race
        // between the read and this update. The reread also makes that race
        // explicit for drivers whose updateMany does not return a row count.
        yield* fuma.use("subject.verifiedHuman.set", (query) =>
          asLooseSubjectDb(query).updateMany("subject", {
            where: writableWhere(input),
            set: { status: VERIFIED_HUMAN_SUBJECT_STATUS },
          }),
        );
        const after = yield* fuma.use("subject.verifiedHuman.get", (query) =>
          asLooseSubjectDb(query).findFirst("subject", { where: where(input) }),
        );
        if (after?.["status"] === REVOKED_HUMAN_SUBJECT_STATUS) return;
        return;
      }

      // Account flows can reach the verified browser boundary before the
      // request sighting seam has created a subject row. Upsert here so that
      // direct account management does not remain permanently unverified.
      yield* fuma
        .use("subject.verifiedHuman.create", (query) =>
          asLooseSubjectDb(query).create("subject", {
            tenant: input.tenant,
            external_id: input.subject,
            created_at: new Date(),
            last_seen_at: null,
            status: VERIFIED_HUMAN_SUBJECT_STATUS,
          }),
        )
        .pipe(
          // A concurrent revoke may create the tombstone first. In that case
          // the guarded update below observes the tombstone and leaves it in
          // place; a concurrent sighting may likewise win the insert race.
          Effect.catchTag("UniqueViolationError", () =>
            fuma.use("subject.verifiedHuman.set", (query) =>
              asLooseSubjectDb(query).updateMany("subject", {
                where: writableWhere(input),
                set: { status: VERIFIED_HUMAN_SUBJECT_STATUS },
              }),
            ),
          ),
        );
    });

  const revokeVerifiedHuman = (input: { readonly tenant: string; readonly subject: string }) =>
    Effect.gen(function* () {
      const fuma = lookup(input);
      const existing = yield* fuma.use("subject.verifiedHuman.get", (query) =>
        asLooseSubjectDb(query).findFirst("subject", { where: where(input) }),
      );
      if (existing?.["status"] === REVOKED_HUMAN_SUBJECT_STATUS) return;

      if (existing) {
        yield* fuma.use("subject.verifiedHuman.revoke", (query) =>
          asLooseSubjectDb(query).updateMany("subject", {
            where: where(input),
            set: { status: REVOKED_HUMAN_SUBJECT_STATUS },
          }),
        );
        return;
      }

      yield* fuma
        .use("subject.verifiedHuman.createRevocation", (query) =>
          asLooseSubjectDb(query).create("subject", {
            tenant: input.tenant,
            external_id: input.subject,
            created_at: new Date(),
            last_seen_at: null,
            status: REVOKED_HUMAN_SUBJECT_STATUS,
          }),
        )
        .pipe(
          Effect.catchTag("UniqueViolationError", () =>
            fuma.use("subject.verifiedHuman.revoke", (query) =>
              asLooseSubjectDb(query).updateMany("subject", {
                where: where(input),
                set: { status: REVOKED_HUMAN_SUBJECT_STATUS },
              }),
            ),
          ),
        );
    });
  return {
    isVerifiedHuman,
    markVerifiedHuman,
    revokeVerifiedHuman,
  };
};

/**
 * Record that `externalId` was seen under `tenant`: create the row on first
 * sight, bump `last_seen_at` on later ones (subject to the throttle). Never
 * fails — a storage error is logged and the caller continues.
 */
export const touchSubject = (db: FumaDb<any>, input: TouchSubjectInput): Effect.Effect<void> =>
  Effect.gen(function* () {
    const externalId = input.externalId;
    // A pure-org executor has no principal to record.
    if (externalId == null) return;

    const throttleMs = input.lastSeenThrottleMs ?? DEFAULT_SUBJECT_LAST_SEEN_THROTTLE_MS;
    const cacheKey = touchCacheKey(input.tenant, externalId);
    const seenAt = lastTouchedAt.get(cacheKey);
    // Already filed a sighting for this principal inside the window: the row
    // exists and its `last_seen_at` is fresh enough, so there is nothing a
    // query could change. THE hot path — skip the read entirely.
    if (seenAt !== undefined && Date.now() - seenAt < throttleMs) return;

    // Bind the tenant policy context. `subject` is inert for this table (it is
    // tenant-scoped, not owner-scoped) but the context shape is shared, and at
    // both call sites the bound subject IS this external id.
    const fuma = makeFumaClient(
      withQueryContext(db, {
        tenant: input.tenant,
        subject: externalId,
      } satisfies ExecutorOwnerPolicyContext),
    );
    // No `tenant` clause: the tenant policy adds it to every read/update.
    const where = (b: AnyCb): Condition | boolean => b("external_id", "=", externalId);
    const now = Date.now();

    const existing = yield* fuma.use("subject.findFirst", (query) =>
      asLooseSubjectDb(query).findFirst("subject", { where }),
    );

    if (!existing) {
      yield* fuma
        .use("subject.create", (query) =>
          asLooseSubjectDb(query).create("subject", {
            tenant: input.tenant,
            external_id: externalId,
            created_at: new Date(now),
            last_seen_at: now,
            status: null,
          }),
        )
        .pipe(
          // A concurrent first sighting of the same principal wins the unique
          // index. That IS the row this call wanted, so the loser succeeds.
          Effect.catchTag("UniqueViolationError", () => Effect.void),
        );
      rememberTouch(cacheKey, now);
      return;
    }

    const lastSeenAt = existing["last_seen_at"];
    // bigint on drivers that return one (matches `tools_synced_at`'s read).
    const lastSeenMs = lastSeenAt == null ? null : Number(lastSeenAt);
    if (lastSeenMs !== null && now - lastSeenMs < throttleMs) {
      // The persisted value is fresh, so the next sighting inside the window
      // can skip this read too. Anchored to the PERSISTED timestamp, not to
      // now, so the memory expires no later than the row does.
      rememberTouch(cacheKey, lastSeenMs);
      return;
    }

    yield* fuma.use("subject.updateMany", (query) =>
      asLooseSubjectDb(query).updateMany("subject", {
        where,
        set: { last_seen_at: now },
      }),
    );
    rememberTouch(cacheKey, now);
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("executor subject touch failed", {
        tenant: input.tenant,
        externalId: input.externalId,
        failureType: typeof cause,
      }),
    ),
    Effect.withSpan("executor.subject.touch"),
  );
