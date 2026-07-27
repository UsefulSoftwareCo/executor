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
//     older than the interval. Steady state is one indexed lookup.
//   - NON-FATAL. A sighting is bookkeeping. Losing one must never fail the
//     request that produced it — but it is logged, never silently swallowed.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { withQueryContext, type Condition, type ConditionBuilder } from "@executor-js/fumadb/query";
import type { AnyColumn } from "@executor-js/fumadb/schema";

import { makeFumaClient, type FumaDb } from "./fuma-runtime";
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
      return;
    }

    const lastSeenAt = existing["last_seen_at"];
    // bigint on drivers that return one (matches `tools_synced_at`'s read).
    const lastSeenMs = lastSeenAt == null ? null : Number(lastSeenAt);
    if (lastSeenMs !== null && now - lastSeenMs < throttleMs) return;

    yield* fuma.use("subject.updateMany", (query) =>
      asLooseSubjectDb(query).updateMany("subject", {
        where,
        set: { last_seen_at: now },
      }),
    );
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("executor subject touch failed", {
        tenant: input.tenant,
        externalId: input.externalId,
        cause,
      }),
    ),
    Effect.withSpan("executor.subject.touch"),
  );
