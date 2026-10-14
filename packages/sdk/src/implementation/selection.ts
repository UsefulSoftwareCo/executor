/** Validate account selections against a deployment's requirements. */
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
import { StoredAccount, type StoredDeployment } from "../contracts/storage.ts";
import { query, type Query } from "./database.ts";

/** The distinct accounts a selection names, in selection order. */
export const selectionAccountIds = (selected: SelectedAccounts): readonly AccountId[] => [
  ...new Set(
    Object.values(selected).flatMap((value) => (typeof value === "string" ? [value] : value)),
  ),
];

/** The stored rows of the named accounts, in one statement; none when it names none. */
export const readSelectionAccounts = (db: Query, ids: readonly AccountId[]) =>
  ids.length === 0
    ? Effect.succeed([])
    : query(() => db.findMany("accounts", { where: (b) => b("id", "in", ids) }));

/** Rows {@link readSelectionAccounts} returned for these IDs, read before the selection was known. */
export interface SelectionAccountsRead {
  readonly ids: readonly AccountId[];
  readonly rows: Result.Result<
    Effect.Success<ReturnType<typeof readSelectionAccounts>>,
    StorageError
  >;
}

/**
 * Whether a read made ahead answered: it stands in for the read it was made for unless it failed
 * for storage. Reads made at once share a connection, so one dropped after an earlier reply fails
 * the rest; read in order, the same read could reach a fresh connection.
 */
export const answered = <A, E extends { readonly _tag: string }>(read: Result.Result<A, E>) =>
  Result.isSuccess(read) || read.failure._tag !== "StorageError";

const sameIds = (left: readonly AccountId[], right: readonly AccountId[]) => {
  const ids = new Set(left);
  return ids.size === right.length && right.every((id) => ids.has(id));
};

/**
 * Batch-load and resolve supplied slots; callers decide whether missing slots are allowed. `read`
 * is a read of the accounts made ahead of the selection; it stands in for this read only when it
 * named the same accounts and {@link answered}.
 */
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

/** The scope accounts named by scope run in: without `user`, the app's, with no caller. */
export const invocationScope = (chosen: AppAccounts | undefined): AccountScope =>
  chosen !== undefined && chosen.user === undefined ? "app" : "user";

/**
 * Validate the accounts an operation names against a deployment's requirements. Each scope names
 * only its own requirements. Every requirement of the invocation's scope is named: app requirements
 * always, and user requirements unless the invocation has no `user`, which runs without a caller.
 * A plain requirement names exactly one account and many() any number. Returns the scope, the
 * cardinality-shaped selection and the resolved accounts in requirement order. `read` is the
 * accounts' read made ahead; see {@link validateSelection}.
 */
export const chooseAccounts = (
  db: Query,
  app: AppId,
  deployment: Pick<StoredDeployment, "id" | "requirements">,
  chosen: AppAccounts | undefined,
  read?: SelectionAccountsRead,
) =>
  Effect.gen(function* () {
    const requirements = deployment.requirements.accounts;
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
    const validated = yield* validateSelection(db, app, deployment.requirements, selected, read);
    const scoped = Object.entries(requirements).filter(
      ([, required]) => scope === "user" || required.scope === "app",
    );
    const selections = yield* Effect.forEach(scoped, ([slot, required]) => {
      const selection = validated.get(slot);
      return selection === undefined
        ? Effect.fail(
            new AccountRequired({ app, deployment: deployment.id, slot, scope: required.scope }),
          )
        : Effect.succeed(selection);
    });
    return { scope, accounts: selected, selections };
  });

/** A selection as the accounts it names, by scope; without a caller it names no `user`. */
export const scopedSelection = (
  requirements: AppRequirements["accounts"],
  selected: SelectedAccounts,
  scope: AccountScope,
): AppAccounts => {
  const app: Record<string, ReadonlyArray<AccountId>> = {};
  const user: Record<string, ReadonlyArray<AccountId>> = {};
  for (const [slot, value] of Object.entries(selected)) {
    const required = Object.hasOwn(requirements, slot) ? requirements[slot] : undefined;
    // An unknown requirement stays named, so validating the selection refuses it.
    (required?.scope === "app" ? app : user)[slot] = typeof value === "string" ? [value] : value;
  }
  return scope === "app" ? { app } : { app, user };
};

/**
 * The accounts an evaluation runs with, by how the product authorizes them: each distinct account
 * a user requirement uses by the actor's use (`user`), and each app requirement's account by the
 * app link for that requirement (`app`). An account used by both scopes is in both and
 * must pass both checks.
 */
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
