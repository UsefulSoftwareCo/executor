/** Explicit retirement validates, leases, invokes without SQL, then rechecks and commits. */
import { type Crypto, Effect, Option, Schema } from "effect";
import { InteractiveRemovalDone, type InteractiveHost } from "../contracts/interactive-accounts.ts";
import { InteractiveRetirementFailed } from "../contracts/interactive-errors.ts";
import { type AccountWebhooksActive, type AccountWorkflowsActive } from "../contracts/account.ts";
import { StorageError, type AccountId, type OwnerId } from "../contracts/shared.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import { query, transaction, type Query } from "./database.ts";
import { StoredState } from "./connection-state.ts";
import { makeRetirementClaims, retirementRecords } from "./interactive-retirement-claims.ts";
import { interactiveStepMillis } from "./interactive-runner.ts";
import { validateRemovalChange } from "./removal-validation.ts";
const decode = Schema.decodeUnknownOption(StoredState);
export const makeInteractiveRetirement = (
  db: Query,
  crypto: Crypto.Crypto,
  remove: InteractiveHost["remove"],
  deleteAccount: (input: {
    owner: OwnerId;
    account: AccountId;
  }) => Effect.Effect<unknown, StorageError | AccountWebhooksActive | AccountWorkflowsActive>,
  lifecycle?: ResourceLifecycle,
) => {
  const leases = makeRetirementClaims(db, crypto, lifecycle);
  const acquired: InteractiveHost["acquired"] = (input) =>
    Effect.gen(function* () {
      const present = new Set(
        (yield* query(() =>
          db.findMany("accounts", { select: ["id"], where: (b) => b("owner", "=", input.owner) }),
        )).map((a) => a.id),
      );
      const ids = new Set<AccountId>();
      for (const row of yield* retirementRecords(db, input.owner)) {
        const parsed = decode(row.state);
        if (
          Option.isSome(parsed) &&
          parsed.value.status === "completed" &&
          parsed.value.interactive !== undefined &&
          (input.app === undefined || parsed.value.interactive.app === input.app) &&
          present.has(parsed.value.account.id)
        )
          ids.add(parsed.value.account.id);
      }
      return [...ids];
    });
  const retire: InteractiveHost["retire"] = (input, action) =>
    Effect.gen(function* () {
      const held = yield* InteractiveRemovalDone;
      const accounts = input.accounts.filter((account) => !held.has(account));
      const first = accounts[0];
      if (first === undefined) return yield* action;
      yield* leases.check({ ...input, accounts });
      const change = Effect.gen(function* () {
        const result = yield* action;
        for (const account of accounts)
          yield* deleteAccount({ owner: input.owner, account }).pipe(
            Effect.mapError(() => new StorageError()),
          );
        return result;
      }).pipe(Effect.provideService(InteractiveRemovalDone, new Set([...held, ...accounts])));
      // Use the canonical mutation's complete checks, then roll back and release every SQL lock.
      yield* validateRemovalChange(db, change);
      const claims = yield* leases.begin({ ...input, accounts });
      const removed = new Set(
        claims.filter((claim) => claim.removed).map((claim) => claim.account),
      );
      return yield* Effect.gen(function* () {
        yield* Effect.forEach(
          claims,
          (claim) =>
            removed.has(claim.account)
              ? Effect.void
              : remove({ owner: input.owner, account: claim.account }).pipe(
                  Effect.timeout(interactiveStepMillis),
                  Effect.mapError(
                    () =>
                      new InteractiveRetirementFailed({ account: claim.account, reason: "remove" }),
                  ),
                  Effect.tap(() => Effect.sync(() => removed.add(claim.account))),
                ),
          { concurrency: 4, discard: true },
        ).pipe(
          Effect.timeout(interactiveStepMillis),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(new InteractiveRetirementFailed({ account: first, reason: "remove" })),
          ),
        );
        return yield* transaction(db, () =>
          Effect.gen(function* () {
            for (const claim of claims) yield* leases.ensure(claim);
            const result = yield* change;
            for (const claim of claims) yield* leases.release(claim, removed.has(claim.account));
            return result;
          }),
        );
      }).pipe(
        Effect.ensuring(
          Effect.forEach(claims, (claim) => leases.release(claim, removed.has(claim.account)), {
            discard: true,
          }).pipe(
            Effect.catch(() =>
              Effect.logWarning(
                "Interactive retirement claim could not be released; its lease will expire",
              ),
            ),
          ),
        ),
      );
    });
  /** Bulk authority is the app/owner deletion. Its bound references cannot survive that app. */
  const discard = (input: { owner: OwnerId; accounts: readonly AccountId[] }) =>
    Effect.gen(function* () {
      if (input.accounts.length === 0) return;
      for (const table of ["webhookSources", "accountChecks"] as const)
        yield* query(() =>
          db.deleteMany(table, { where: (b) => b("account", "in", input.accounts) }),
        );
      yield* query(() =>
        db.deleteMany("oauthGrants", { where: (b) => b("id", "in", input.accounts) }),
      );
      yield* query(() =>
        db.deleteMany("accounts", {
          where: (b) => b.and(b("owner", "=", input.owner), b("id", "in", input.accounts)),
        }),
      );
    });
  return { retire, acquired, discard };
};
