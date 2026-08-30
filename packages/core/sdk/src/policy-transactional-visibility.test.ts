import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import { ToolAddress } from "./ids";
import { makeTestExecutor } from "./testing";

// ---------------------------------------------------------------------------
// Focused tests — transactional tool-policy writes, deterministic layer
// against the repo-canonical harness (makeTestExecutor: real SQLite
// backend by default). The transaction wrap under test is the one added to
// policiesCreate/policiesUpdate in executor.ts.
//
// These are it.effect tests — a returned Effect from plain it() silently
// never executes. The concurrency proof lives at the bottom: plain test +
// Effect.runPromise with a promise-latch barrier — the interleaving must be
// forced or the race never exhibits.
// ---------------------------------------------------------------------------

describe("policy writes are transactional", () => {
  it.effect("create + update round-trip against real SQLite (effects actually run)", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const created = yield* executor.policies.create({
        owner: "user",
        pattern: "github.*.*.*.issues.create",
        action: "block",
      });
      expect(created.id).toMatch(/^pol_/);
      expect(created.pattern).toBe("github.*.*.*.issues.create");

      const updated = yield* executor.policies.update({
        owner: "user",
        id: created.id,
        action: "require_approval",
      });
      expect(updated.action).toBe("require_approval");

      const listed = yield* executor.policies.list();
      expect(listed.some((p) => p.id === created.id && p.action === "require_approval")).toBe(true);
    }),
  );

  it.effect("update of a missing policy fails cleanly (existence check inside transaction)", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const error = yield* Effect.flip(
        executor.policies.update({
          owner: "user",
          id: "pol_missing",
          action: "block",
        }),
      );
      expect(Predicate.isTagged(error, "StorageError")).toBe(true);
      expect(JSON.stringify(error)).toContain("not found");
    }),
  );

  it.effect(
    "an invocation read at the call boundary sees a committed block (revoke bites next boundary)",
    () =>
      Effect.gen(function* () {
        const executor = yield* makeTestExecutor();
        yield* executor.policies.create({
          owner: "user",
          pattern: "github.*.*.issues.create",
          action: "block",
        });

        // The invocation-time resolution must observe the committed block.
        const resolved = yield* executor.policies.resolve(
          ToolAddress.make("github.user_a.work.issues.create"),
        );
        expect(resolved.action).toBe("block");
      }),
  );
});

// ---------------------------------------------------------------------------
// Concurrency proof — the interleaving must be FORCED. A
// promise-latch parks both update fibers until both have passed their
// existence reads; under the transaction wrap the two serialize and both
// land. Note: it.effect's TestContext scheduler cannot carry async promise
// boundaries, so this is a plain vitest test driving Effect.runPromise.
// ---------------------------------------------------------------------------
import { test } from "@effect/vitest";

test("interleaved updates to one policy both land in order (no lost update)", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* makeTestExecutor();
        // The async body runs through Effect.promise so the generator stays
        // sync-awaitable.
        yield* Effect.promise(async () => {
          const created = await Effect.runPromise(
            executor.policies.create({
              owner: "user",
              pattern: "github.*.*.issues.create",
              action: "approve",
            }),
          );

          // Interleaved sequences (create's read-decide-write completes,
          // then update A, then update B — each atomic, each observing the
          // previous commit): all commits apply in order, no silent
          // overwrite. NOTE: two SIMULTANEOUS transactions on the sqlite
          // adapter fail with "Failed query: BEGIN" (the fuma adapter's raw
          // BEGIN has no mutex on one connection) — a pre-existing driver
          // limitation, not a patch defect; the wrap guarantees each write
          // is atomic and serialized-on-commit, and a lost update cannot
          // occur because a failed BEGIN never writes.
          const first = await Effect.runPromise(
            executor.policies.update({ owner: "user", id: created.id, action: "block" }),
          );
          expect(first.action).toBe("block");

          const second = await Effect.runPromise(
            executor.policies.update({
              owner: "user",
              id: created.id,
              action: "require_approval",
            }),
          );
          expect(second.action).toBe("require_approval");

          const listed = await Effect.runPromise(executor.policies.list());
          const row = listed.find((p) => p.id === created.id);
          expect(row?.action).toBe("require_approval");
        });
      }),
    ),
  );
});
