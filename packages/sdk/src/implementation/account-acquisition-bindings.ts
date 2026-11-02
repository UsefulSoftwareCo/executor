import { Effect, Redacted, Schema } from "effect";
import {
  AccountAcquisitionBinding,
  AccountAcquisitionUnavailable,
} from "../contracts/account-acquisition-driver.ts";
import type { Credentials, StoredAccount } from "../contracts/storage.ts";
import { StorageError, type AccountId, type OwnerId } from "../contracts/shared.ts";
import { storedAccount } from "./accounts.ts";
import { query, type Query } from "./database.ts";

export const acquisitionBinding = (
  db: Query,
  input: { readonly account: AccountId; readonly owner?: OwnerId },
) =>
  Effect.gen(function* () {
    const row = yield* query(() =>
      db.findFirst("accountAcquisitions", {
        where: (b) =>
          b.and(
            b("account", "=", input.account),
            input.owner === undefined ? true : b("owner", "=", input.owner),
          ),
      }),
    );
    return row === null
      ? undefined
      : yield* Schema.decodeUnknownEffect(AccountAcquisitionBinding)(row).pipe(
          Effect.mapError(() => new StorageError()),
        );
  });

export const bindingMatchesAccount = (
  binding: AccountAcquisitionBinding,
  account: StoredAccount,
  allowRemoval = false,
) =>
  binding.account === account.id &&
  binding.owner === account.owner &&
  binding.provider === account.provider &&
  binding.method === account.method &&
  binding.generation === account.credentialGeneration &&
  (allowRemoval || binding.removal === null);

/** This read does not create or adopt a binding. Missing and stale bindings stay distinguishable. */
export const resolveAcquisitionBinding =
  (db: Query, credentials: Credentials, allowRemoval = false) =>
  (input: { readonly account: AccountId; readonly owner?: OwnerId }) =>
    Effect.gen(function* () {
      const account = yield* storedAccount(db, input.account, input.owner);
      const binding = yield* acquisitionBinding(db, { account: account.id, owner: account.owner });
      if (binding === undefined) return undefined;
      if (!bindingMatchesAccount(binding, account, allowRemoval))
        return yield* new AccountAcquisitionUnavailable({ reason: "changed" });
      const fields = yield* credentials
        .decrypt(account.id, account.encryptedCredentials)
        .pipe(Effect.mapError(() => new StorageError()));
      const value = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ ref: Schema.NonEmptyString }),
      )(Redacted.value(fields)).pipe(Effect.mapError(() => new StorageError()));
      return { account, binding, reference: Redacted.make(value.ref) };
    });

/** Recheck inside the transaction that saves a hook result or credential replacement. */
export const requireAcquisitionBinding = (
  db: Query,
  expected: AccountAcquisitionBinding,
  allowRemoval = false,
) =>
  Effect.gen(function* () {
    yield* query(() =>
      db.updateMany("accounts", {
        where: (b) =>
          b.and(
            b("id", "=", expected.account),
            b("owner", "=", expected.owner),
            b("credentialGeneration", "=", expected.generation),
          ),
        set: { owner: expected.owner },
      }),
    );
    yield* query(() =>
      db.updateMany("accountAcquisitions", {
        where: (b) =>
          b.and(b("account", "=", expected.account), b("revision", "=", expected.revision)),
        set: { revision: expected.revision },
      }),
    );
    const account = yield* storedAccount(db, expected.account, expected.owner);
    const current = yield* acquisitionBinding(db, expected);
    if (
      current === undefined ||
      current.revision !== expected.revision ||
      current.driver !== expected.driver ||
      current.driverRevision !== expected.driverRevision ||
      current.generation !== expected.generation ||
      !bindingMatchesAccount(current, account, allowRemoval)
    )
      return yield* new AccountAcquisitionUnavailable({ reason: "changed" });
    return current;
  });
