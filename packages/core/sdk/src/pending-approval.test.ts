import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import { makeFumaBlobStore, makeInMemoryBlobStore } from "./blob";
import { collectTables } from "./executor";
import { makeFumaClient } from "./fuma-runtime";
import {
  makePendingApprovalStore,
  PENDING_APPROVAL_TTL_MS,
  type PendingApproval,
} from "./pending-approval";
import { CredentialId, DelegationId, DelegationScopeVersion, Subject, Tenant } from "./ids";
import { createSqliteTestFumaDb } from "./sqlite-test-db";
import type { DelegationBinding } from "./delegation";

const delegationBinding: DelegationBinding = {
  tenant: Tenant.make("tenant-a"),
  grantId: DelegationId.make("grant_1"),
  credentialId: CredentialId.make("credential_1"),
  credentialRef: "service-token-1",
  actorSubject: Subject.make("machine-1"),
  effectiveSubject: Subject.make("human-1"),
  scopeVersion: DelegationScopeVersion.make("scope_1"),
};

const approval = (overrides?: Partial<PendingApproval>): PendingApproval => ({
  executionId: "exec_1",
  artifactId: "art_1",
  code: 'return await tools.github.user.main.issues.create({"title":"x"})',
  address: "github.user.main.issues.create",
  expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
  ...overrides,
});

describe("makePendingApprovalStore", () => {
  it.effect("round-trips a recorded approval", () =>
    Effect.gen(function* () {
      const store = makePendingApprovalStore(makeInMemoryBlobStore(), "u:t:s");
      const recorded = approval();
      yield* store.put(recorded);

      expect(yield* store.consume("exec_1")).toStrictEqual(recorded);
    }),
  );

  it.effect("round-trips the exact delegated binding when present", () =>
    Effect.gen(function* () {
      const store = makePendingApprovalStore(makeInMemoryBlobStore(), "u:t:s");
      const recorded = approval({ delegationBinding });
      yield* store.put(recorded);

      expect(yield* store.consume("exec_1")).toStrictEqual(recorded);
    }),
  );

  it.effect("does not consume a same-partition record for another grant", () =>
    Effect.gen(function* () {
      const store = makePendingApprovalStore(makeInMemoryBlobStore(), "u:t:s");
      yield* store.put(approval({ delegationBinding }));

      const otherGrant: DelegationBinding = {
        ...delegationBinding,
        grantId: DelegationId.make("grant_other"),
      };
      expect(
        yield* store.consume(
          "exec_1",
          (candidate) =>
            candidate.delegationBinding !== undefined &&
            candidate.delegationBinding.grantId === otherGrant.grantId,
        ),
      ).toBeNull();

      expect(
        yield* store.consume(
          "exec_1",
          (candidate) =>
            candidate.delegationBinding !== undefined &&
            candidate.delegationBinding.grantId === delegationBinding.grantId,
        ),
      ).not.toBeNull();
    }),
  );

  // The whole point of the record: the engine that paused is gone, so the
  // approval has to be readable by a caller that never saw the pause.
  it.effect("is readable through a second store over the same partition", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      yield* makePendingApprovalStore(blobs, "u:t:s").put(approval());

      const resumingRequest = makePendingApprovalStore(blobs, "u:t:s");
      expect((yield* resumingRequest.consume("exec_1"))?.address).toBe(
        "github.user.main.issues.create",
      );
    }),
  );

  // One approval authorizes one invocation. A replayed resume must not be able
  // to run the call a second time.
  it.effect("consumes the record, so a second resume finds nothing", () =>
    Effect.gen(function* () {
      const store = makePendingApprovalStore(makeInMemoryBlobStore(), "u:t:s");
      yield* store.put(approval());

      expect(yield* store.consume("exec_1")).not.toBeNull();
      expect(yield* store.consume("exec_1")).toBeNull();
    }),
  );

  it.effect("keeps sensitive approval payloads out of the replay tombstone", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      const store = makePendingApprovalStore(blobs, "u:t:s");
      yield* store.put(approval({ code: 'return await tools.secret({ token: "private" })' }));

      expect(yield* store.consume("exec_1")).not.toBeNull();
      const marker = yield* blobs.get("u:t:s/@pending-approval/@claim", "exec_1");
      expect(marker).toBe("claimed");
      expect(marker).not.toContain("private");
    }),
  );

  it.effect("allows only one concurrent resume to claim a record", () =>
    Effect.gen(function* () {
      const base = makeInMemoryBlobStore();
      let reads = 0;
      let release!: () => void;
      const bothReadersStarted = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gated = {
        ...base,
        get: (namespace: string, key: string) =>
          base.get(namespace, key).pipe(
            Effect.flatMap((value) =>
              Effect.promise(async () => {
                reads += 1;
                if (reads === 2) release();
                await bothReadersStarted;
                return value;
              }),
            ),
          ),
      };
      const store = makePendingApprovalStore(gated, "u:t:s");
      yield* store.put(approval());

      const results = yield* Effect.all([store.consume("exec_1"), store.consume("exec_1")], {
        concurrency: "unbounded",
      });
      expect(results.filter(Predicate.isNotNull)).toHaveLength(1);
    }),
  );

  it.effect("uses the database uniqueness claim across concurrent resumes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
      (db) =>
        Effect.gen(function* () {
          const blobs = makeFumaBlobStore(makeFumaClient(db.db));
          const store = makePendingApprovalStore(blobs, "u:t:s");
          yield* store.put(approval());

          const results = yield* Effect.all([store.consume("exec_1"), store.consume("exec_1")], {
            concurrency: "unbounded",
          });
          expect(results.filter(Predicate.isNotNull)).toHaveLength(1);
        }),
      (db) => Effect.promise(() => db.close()),
    ),
  );

  // Ownership is the partition, not a separate check that could drift from it.
  it.effect("is invisible to a different owner partition", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      yield* makePendingApprovalStore(blobs, "u:t:alice").put(approval());

      const mallory = makePendingApprovalStore(blobs, "u:t:mallory");
      expect(yield* mallory.consume("exec_1")).toBeNull();
    }),
  );

  it.effect("treats an expired record as absent", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      const now = 1_000_000;
      const store = makePendingApprovalStore(blobs, "u:t:s", () => now);
      yield* store.put(approval({ expiresAt: now - 1 }));

      expect(yield* store.consume("exec_1")).toBeNull();
    }),
  );

  it.effect("keeps a record that is still inside its window", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      const now = 1_000_000;
      const store = makePendingApprovalStore(blobs, "u:t:s", () => now);
      yield* store.put(approval({ expiresAt: now + 1 }));

      expect(yield* store.consume("exec_1")).not.toBeNull();
    }),
  );

  it.effect("keeps the full human-scale approval window without waiting on wall clock", () =>
    Effect.gen(function* () {
      const recordedAt = 1_000_000;
      let now = recordedAt + PENDING_APPROVAL_TTL_MS - 1;
      const blobs = makeInMemoryBlobStore();
      const store = makePendingApprovalStore(blobs, "u:t:s", () => now);
      const expiresAt = recordedAt + PENDING_APPROVAL_TTL_MS;
      yield* store.put(approval({ expiresAt }));

      expect(yield* store.consume("exec_1")).not.toBeNull();

      yield* store.put(approval({ expiresAt }));
      now += 1;
      expect(yield* store.consume("exec_1")).toBeNull();
    }),
  );

  // A record we reject is a record nobody should be able to retry against.
  it.effect("drops an expired record rather than leaving it to be retried", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      let now = 1_000_000;
      const store = makePendingApprovalStore(blobs, "u:t:s", () => now);
      yield* store.put(approval({ expiresAt: now + 10 }));

      now += 100;
      expect(yield* store.consume("exec_1")).toBeNull();

      now = 1_000_000;
      expect(yield* store.consume("exec_1")).toBeNull();
    }),
  );

  it.effect("reads an unparseable record as absent", () =>
    Effect.gen(function* () {
      const blobs = makeInMemoryBlobStore();
      yield* blobs.put("u:t:s/@pending-approval", "exec_1", "not json");

      const store = makePendingApprovalStore(blobs, "u:t:s");
      expect(yield* store.consume("exec_1")).toBeNull();
    }),
  );

  it.effect("discard drops a record without returning it", () =>
    Effect.gen(function* () {
      const store = makePendingApprovalStore(makeInMemoryBlobStore(), "u:t:s");
      yield* store.put(approval());

      yield* store.discard("exec_1");
      expect(yield* store.consume("exec_1")).toBeNull();
    }),
  );
});
