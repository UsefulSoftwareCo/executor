import { Effect, Result, Schema } from "effect";
import {
  AccountRequired,
  AccountSelectionInvalid,
  type AccountScope,
  type AppRequirements,
  type AppAccounts,
  type SelectedAccounts,
} from "../contracts/apps.ts";
import { type AccountId, type AppId, StorageError } from "../contracts/shared.ts";
import { AccountNotFound } from "../contracts/account.ts";
import { StoredAccount, type StoredVersion } from "../contracts/storage.ts";
import { query, type Query } from "./database.ts";

export const selectionAccountIds = (selected: SelectedAccounts): readonly AccountId[] => [
  ...new Set(
    Object.values(selected).flatMap((value) => (typeof value === "string" ? [value] : value)),
  ),
];

export const readSelectionAccounts = (db: Query, ids: readonly AccountId[]) =>
  ids.length === 0
    ? Effect.succeed([])
    : query(() => db.findMany("accounts", { where: (b) => b("id", "in", ids) }));

export interface SelectionAccountsRead {
  readonly ids: readonly AccountId[];
  readonly rows: Result.Result<
    Effect.Success<ReturnType<typeof readSelectionAccounts>>,
    StorageError
  >;
}

export const answered = <A, E extends { readonly _tag: string }>(read: Result.Result<A, E>) =>
  Result.isSuccess(read) || read.failure._tag !== "StorageError";

const sameIds = (left: readonly AccountId[], right: readonly AccountId[]) => {
  const ids = new Set(left);
  return ids.size === right.length && right.every((id) => ids.has(id));
};

export const validateSelection = (
  db: Query,
  app: AppId,
  requirements: AppRequirements,
  selected: SelectedAccounts,
  read?: SelectionAccountsRead,
) =>
  Effect.gen(function* () {
    const ids = selectionAccountIds(selected);
    const rows =
      read !== undefined && sameIds(read.ids, ids) && answered(read.rows)
        ? yield* Effect.fromResult(read.rows)
        : yield* readSelectionAccounts(db, ids);
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

export const invocationScope = (chosen: AppAccounts | undefined): AccountScope =>
  chosen !== undefined && chosen.user === undefined ? "app" : "user";

export const chooseAccounts = (
  db: Query,
  app: AppId,
  version: Pick<StoredVersion, "id" | "requirements">,
  chosen: AppAccounts | undefined,
  read?: SelectionAccountsRead,
) =>
  Effect.gen(function* () {
    const requirements = version.requirements.accounts;
    const scope = invocationScope(chosen);
    const named: ReadonlyArray<readonly [AccountScope, string, ReadonlyArray<AccountId>]> = [
      ...Object.entries(chosen?.app ?? {}).map(([slot, ids]) => ["app", slot, ids] as const),
      ...Object.entries(chosen?.user ?? {}).map(([slot, ids]) => ["user", slot, ids] as const),
    ];
    const selected: { [slot: string]: SelectedAccounts[string] } = {};
    for (const [scopeNamed, slot, ids] of named) {
      const required = Object.hasOwn(requirements, slot) ? requirements[slot] : undefined;
      if (required === undefined || required.scope !== scopeNamed)
        return yield* new AccountSelectionInvalid({ app, slot, reason: "unknown_slot" });
      if (required.cardinality === "many") selected[slot] = ids;
      else if (ids.length > 1)
        return yield* new AccountSelectionInvalid({ app, slot, reason: "expected_one" });
      else {
        const [id] = ids;
        if (id !== undefined) selected[slot] = id;
      }
    }
    const validated = yield* validateSelection(db, app, version.requirements, selected, read);
    const scoped = Object.entries(requirements).filter(
      ([, required]) => scope === "user" || required.scope === "app",
    );
    const selections = yield* Effect.forEach(scoped, ([slot, required]) => {
      const selection = validated.get(slot);
      return selection === undefined
        ? Effect.fail(
            new AccountRequired({ app, version: version.id, slot, scope: required.scope }),
          )
        : Effect.succeed(selection);
    });
    return { scope, accounts: selected, selections };
  });

export const scopedSelection = (
  requirements: AppRequirements["accounts"],
  selected: SelectedAccounts,
  scope: AccountScope,
): AppAccounts => {
  const app: Record<string, ReadonlyArray<AccountId>> = {};
  const user: Record<string, ReadonlyArray<AccountId>> = {};
  for (const [slot, value] of Object.entries(selected)) {
    const required = Object.hasOwn(requirements, slot) ? requirements[slot] : undefined;
    (required?.scope === "app" ? app : user)[slot] = typeof value === "string" ? [value] : value;
  }
  return scope === "app" ? { app } : { app, user };
};

export const accountAuthority = <A extends { readonly id: AccountId }>(
  selections: ReadonlyArray<{
    readonly slot: string;
    readonly required: { readonly scope: AccountScope };
    readonly accounts: ReadonlyArray<A>;
  }>,
) => {
  const user = new Map<AccountId, A>();
  const app: Array<{ readonly requirement: string; readonly account: A }> = [];
  for (const { slot, required, accounts } of selections)
    for (const account of accounts)
      if (required.scope === "app") app.push({ requirement: slot, account });
      else if (!user.has(account.id)) user.set(account.id, account);
  return { user: [...user.values()], app };
};
