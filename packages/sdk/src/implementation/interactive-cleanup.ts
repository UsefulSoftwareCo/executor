/** Bulk cleanup is bounded and advisory; a provider never vetoes the local purge. */
import { Clock, Effect } from "effect";
import type { InteractiveHost } from "../contracts/interactive-accounts.ts";
import type { AccountId, OwnerId } from "../contracts/shared.ts";
import { interactiveStepMillis } from "./interactive-runner.ts";
/** Self-host's HTTP idle limit is 30 seconds; leave 10 seconds for the local mutation. */
export const interactiveCleanupMillis = 20_000;
/** Capture resolved handler calls while the app, version and linked credentials still exist. */
export const prepareInteractiveCleanup = <E, E2>(
  prepare: (
    input: Parameters<InteractiveHost["remove"]>[0],
  ) => Effect.Effect<Effect.Effect<void, E>, E2>,
  input: { readonly owner: OwnerId; readonly accounts: readonly AccountId[] },
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + interactiveCleanupMillis;
    const prepared = new Map<AccountId, Effect.Effect<void, E>>();
    const warning = (account: AccountId) =>
      Effect.logWarning("Interactive account cleanup could not be prepared; continuing deletion", {
        account,
      });
    yield* Effect.forEach(
      input.accounts,
      (account) =>
        prepare({ owner: input.owner, account }).pipe(
          Effect.timeout(interactiveStepMillis),
          Effect.tap((call) => Effect.sync(() => prepared.set(account, call))),
          Effect.catchCause(() => warning(account)),
        ),
      { concurrency: 4, discard: true },
    ).pipe(
      Effect.timeout(interactiveCleanupMillis),
      Effect.catchCause(() =>
        Effect.forEach(
          input.accounts.filter((account) => !prepared.has(account)),
          warning,
          { discard: true },
        ),
      ),
    );
    return Effect.gen(function* () {
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      const pending = new Set(prepared.keys());
      const warn = (account: AccountId) =>
        Effect.logWarning("Interactive account cleanup did not finish after deletion", { account });
      if (remaining <= 0) return yield* Effect.forEach([...pending], warn, { discard: true });
      yield* Effect.forEach(
        [...prepared],
        ([account, call]) =>
          call.pipe(
            Effect.timeout(interactiveStepMillis),
            Effect.catchCause(() => warn(account)),
            Effect.tap(() => Effect.sync(() => pending.delete(account))),
          ),
        { concurrency: 4, discard: true },
      ).pipe(
        Effect.timeout(remaining),
        Effect.catchCause(() => Effect.forEach([...pending], warn, { discard: true })),
      );
    });
  });
