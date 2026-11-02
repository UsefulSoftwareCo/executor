import { Clock, Effect, Schema, type Crypto } from "effect";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import {
  AccountAcquisitionRemoval,
  AccountAcquisitionUnavailable,
} from "../contracts/account-acquisition-driver.ts";
import {
  InteractiveRetirementBusy,
  InteractiveRetirementFailed,
} from "../contracts/interactive-errors.ts";
import { StorageError, type AccountId, type OwnerId } from "../contracts/shared.ts";
import { publicAccount } from "./accounts.ts";
import { query, transaction, type Query } from "./database.ts";
import {
  resolveAcquisitionBinding,
  requireAcquisitionBinding,
} from "./account-acquisition-bindings.ts";
import { invokeAcquisitionDriver } from "./account-acquisition-runtime.ts";
import type { AcquisitionRegistry } from "./account-acquisition-registry.ts";
import { validateRemovalChange } from "./removal-validation.ts";

const encode = Schema.encodeSync(AccountAcquisitionRemoval);

/** A retained operation ID makes a retry after an uncertain backend response the same removal. */
export const makeAcquisitionRetirement = (
  db: Query,
  credentials: import("../contracts/storage.ts").Credentials,
  crypto: Crypto.Crypto,
  registry: AcquisitionRegistry,
  lifecycle?: ResourceLifecycle,
) => {
  const resolve = resolveAcquisitionBinding(db, credentials, true);
  return <A, E, R>(
    input: { readonly account: AccountId; readonly owner: OwnerId },
    removeAccount: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      yield* validateRemovalChange(db, removeAccount);
      const claim = yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const saved = yield* resolve(input);
          if (saved === undefined) return yield* new StorageError();
          const binding = yield* requireAcquisitionBinding(tx, saved.binding, true);
          const now = yield* Clock.currentTimeMillis;
          if (binding.removal?.lease !== undefined && (binding.removal.leaseUntil ?? 0) > now)
            return yield* new InteractiveRetirementBusy({ account: input.account });
          yield* lifecycle?.accountRetiring?.(yield* publicAccount(saved.account)) ?? Effect.void;
          const registration = yield* registry.retained(binding);
          const token = yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()));
          const removal = {
            operation: binding.removal?.operation ?? token,
            removed: binding.removal?.removed ?? false,
            lease: token,
            leaseUntil: now + 20_000,
          };
          yield* query(() =>
            tx.updateMany("accountAcquisitions", {
              where: (b) => b("account", "=", input.account),
              set: { removal: encode(removal) },
            }),
          );
          return { ...saved, binding, registration, removal };
        }),
      );
      const held = () =>
        Effect.gen(function* () {
          const current = yield* requireAcquisitionBinding(db, claim.binding, true);
          if (current.removal?.lease !== claim.removal.lease)
            return yield* new InteractiveRetirementBusy({ account: input.account });
          return current;
        });
      return yield* Effect.gen(function* () {
        if (!claim.removal.removed) {
          yield* invokeAcquisitionDriver(
            claim.registration,
            {
              owner: input.owner,
              provider: claim.binding.provider,
              method: claim.binding.method,
              operation: claim.removal.operation,
              deadline: (yield* Clock.currentTimeMillis) + 15_000,
            },
            (context) =>
              claim.registration.driver.remove({
                ...context,
                binding: claim.binding,
                reference: claim.reference,
              }),
          ).pipe(
            Effect.mapError(
              () =>
                new InteractiveRetirementFailed({
                  account: input.account,
                  reason: "remove",
                }),
            ),
          );
          yield* transaction(db, () =>
            Effect.gen(function* () {
              yield* held();
              yield* query(() =>
                db.updateMany("accountAcquisitions", {
                  where: (b) => b("account", "=", input.account),
                  set: { removal: encode({ ...claim.removal, removed: true }) },
                }),
              );
            }),
          );
        }
        return yield* transaction(db, () =>
          Effect.gen(function* () {
            yield* held();
            return yield* removeAccount;
          }),
        );
      }).pipe(
        Effect.ensuring(
          transaction(db, () =>
            Effect.gen(function* () {
              const saved = yield* resolve(input).pipe(
                Effect.catchTag("AccountNotFound", () => Effect.succeed(undefined)),
              );
              if (saved?.binding.removal?.lease !== claim.removal.lease) return;
              const current = yield* requireAcquisitionBinding(db, saved.binding, true);
              const removal = current.removal;
              if (removal === null) return;
              yield* query(() =>
                db.updateMany("accountAcquisitions", {
                  where: (b) => b("account", "=", input.account),
                  set: {
                    removal: encode({
                      operation: removal.operation,
                      removed: removal.removed,
                    }),
                  },
                }),
              );
            }),
          ).pipe(Effect.catch(() => Effect.logWarning("Account removal lease will expire"))),
        ),
      );
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(AccountAcquisitionUnavailable)(error)
          ? new InteractiveRetirementFailed({ account: input.account, reason: "remove" })
          : error,
      ),
    );
};
