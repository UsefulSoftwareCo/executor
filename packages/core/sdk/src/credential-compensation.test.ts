import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Predicate } from "effect";

import { restoreCredentialSnapshotsWithRecheck } from "./credential-compensation";
import { StorageError } from "./fuma-runtime";
import { ProviderItemId } from "./ids";

describe("restoreCredentialSnapshotsWithRecheck", () => {
  it.effect("attempts every restore and reports their combined failed outcome", () =>
    Effect.gen(function* () {
      const attempts: string[] = [];
      const failure = new StorageError({ message: "first restore refused", cause: undefined });
      const outcome = yield* restoreCredentialSnapshotsWithRecheck(
        [
          {
            itemId: ProviderItemId.make("first"),
            value: "new-first",
            write: Effect.void,
            restoreSupported: true,
            restore: Effect.sync(() => attempts.push("first")).pipe(
              Effect.andThen(Effect.fail(failure)),
            ),
          },
          {
            itemId: ProviderItemId.make("second"),
            value: "new-second",
            write: Effect.void,
            restoreSupported: true,
            restore: Effect.sync(() => {
              attempts.push("second");
            }),
          },
        ],
        Effect.succeed(true),
      );

      expect(attempts).toEqual(["first", "second"]);
      expect(Predicate.isTagged(outcome, "Failed")).toBe(true);
      if (!Predicate.isTagged(outcome, "Failed")) return;
      expect(
        outcome.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
      ).toEqual([failure]);
    }),
  );
});
