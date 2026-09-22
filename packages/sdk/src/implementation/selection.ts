/** Validate stored account selections against a deployment's requirements. */
import { Effect, Schema } from "effect";
import {
  AccountSelectionInvalid,
  type AppRequirements,
  SelectedAccounts,
} from "../contracts/apps.ts";
import { type AppId, StorageError } from "../contracts/shared.ts";
import { AccountNotFound } from "../contracts/account.ts";
import { StoredAccount } from "../contracts/storage.ts";
import { query, type Query } from "./database.ts";

/** Batch-load and resolve supplied slots; missing slots are allowed during setup. */
export const validateSelection = (
  db: Query,
  app: AppId,
  requirements: AppRequirements,
  selected: SelectedAccounts,
) =>
  Effect.gen(function* () {
    const ids = [
      ...new Set(
        Object.values(selected).flatMap((value) => (typeof value === "string" ? [value] : value)),
      ),
    ];
    const rows =
      ids.length === 0
        ? []
        : yield* query(() => db.findMany("accounts", { where: (b) => b("id", "in", ids) }));
    const accounts = yield* Schema.decodeUnknownEffect(Schema.Array(StoredAccount))(rows).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const byId = new Map(accounts.map((account) => [account.id, account]));
    const selections = yield* Effect.forEach(Object.entries(selected), ([slot, value]) =>
      Effect.gen(function* () {
        const required = Object.hasOwn(requirements.accounts, slot)
          ? requirements.accounts[slot]
          : undefined;
        const invalid = (reason: AccountSelectionInvalid["reason"]) =>
          new AccountSelectionInvalid({ app, slot, reason });
        if (required === undefined) return yield* Effect.fail(invalid("unknown_slot"));
        const many = Array.isArray(value);
        if (required.cardinality === "one" && many)
          return yield* Effect.fail(invalid("expected_one"));
        if (required.cardinality === "many" && !many)
          return yield* Effect.fail(invalid("expected_many"));
        const ids = typeof value === "string" ? [value] : value;
        if (new Set(ids).size !== ids.length)
          return yield* Effect.fail(invalid("duplicate_account"));
        const resolved = yield* Effect.forEach(ids, (id) =>
          Effect.gen(function* () {
            const account = byId.get(id);
            if (account === undefined) return yield* new AccountNotFound({ account: id });
            if (account.provider !== required.provider)
              return yield* Effect.fail(invalid("provider_mismatch"));
            return account;
          }),
        );
        return { slot, required, accounts: resolved };
      }),
    );
    return new Map(selections.map((selection) => [selection.slot, selection]));
  });

/** A fixed binding cannot take over a slot already used by any live personal profile. */
export const assertFixedSlotsAvailable = (db: Query, app: AppId, slots: readonly string[]) =>
  Effect.gen(function* () {
    if (slots.length === 0) return;
    const profiles = yield* query(() =>
      db.findMany("profiles", {
        where: (b) => b.and(b("app", "=", app), b("status", "!=", "removed")),
        select: ["accounts"],
      }),
    );
    for (const profile of profiles) {
      const bindings = yield* Schema.decodeUnknownEffect(SelectedAccounts)(profile.accounts).pipe(
        Effect.mapError(() => new StorageError()),
      );
      for (const slot of slots)
        if (Object.hasOwn(bindings, slot))
          return yield* new AccountSelectionInvalid({ app, slot, reason: "profile_bound" });
    }
  });
