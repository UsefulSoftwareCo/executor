/** Durable explicit-retirement leases. No transaction escapes these helpers. */
import { Clock, type Crypto, Effect, Option, Schema } from "effect";
import {
  InteractiveRetirementBusy,
  InteractiveRetirementFailed,
} from "../contracts/interactive-errors.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import {
  StorageError,
  type AccountId,
  type AccountConnectionId,
  type OwnerId,
} from "../contracts/shared.ts";
import { lockConnection, StoredState } from "./connection-state.ts";
import { ownedAccount, publicAccount } from "./accounts.ts";
import { query, transaction, type Query } from "./database.ts";
const decode = Schema.decodeUnknownOption(StoredState),
  encode = Schema.encodeSync(StoredState);
/** The complete remove step is limited to 15 seconds, leaving 5 seconds to settle its lease. */
export const retirementLeaseMillis = 20_000;
export interface RetirementClaim {
  readonly connection: AccountConnectionId;
  readonly account: AccountId;
  readonly owner: OwnerId;
  readonly token: string;
  readonly removed: boolean;
}
export const retirementRecords = (db: Query, owner: OwnerId) =>
  query(() =>
    db.findMany("accountConnections", {
      where: (b) => b("owner", "=", owner),
      orderBy: ["createdAt", "desc"],
    }),
  );
export const makeRetirementClaims = (
  db: Query,
  crypto: Crypto.Crypto,
  lifecycle?: ResourceLifecycle,
) => {
  const check = (input: { owner: OwnerId; accounts: readonly AccountId[] }) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const wanted = new Set(input.accounts);
      for (const row of yield* retirementRecords(db, input.owner)) {
        const state = decode(row.state);
        if (
          Option.isSome(state) &&
          state.value.status === "completed" &&
          wanted.delete(state.value.account.id)
        ) {
          const lease = state.value.interactive?.retirement;
          if (lease?.token !== undefined && (lease.expiresAt ?? 0) > now)
            return yield* new InteractiveRetirementBusy({ account: state.value.account.id });
        }
      }
    });
  const begin = (input: { owner: OwnerId; accounts: readonly AccountId[] }) =>
    transaction(db, (tx) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const token = yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()));
        const wanted = new Set(input.accounts),
          claims: RetirementClaim[] = [];
        for (const record of yield* retirementRecords(tx, input.owner)) {
          const parsed = decode(record.state);
          if (
            Option.isNone(parsed) ||
            parsed.value.status !== "completed" ||
            parsed.value.interactive === undefined ||
            !wanted.delete(parsed.value.account.id)
          )
            continue;
          const row = yield* lockConnection(
            tx,
            { connection: record.id, owner: input.owner },
            crypto,
          ).pipe(Effect.mapError(() => new StorageError()));
          if (row.storedState.status !== "completed" || row.storedState.interactive === undefined)
            return yield* new StorageError();
          const state = row.storedState,
            binding = row.storedState.interactive,
            account = state.account.id;
          const lease = binding.retirement;
          // A legacy claim without an expiry is reclaimable too; it cannot block an upgrade forever.
          if (lease?.token !== undefined && (lease.expiresAt ?? 0) > now)
            return yield* new InteractiveRetirementBusy({ account });
          const saved = yield* ownedAccount(tx, { account, owner: input.owner }).pipe(
            Effect.mapError(() => new StorageError()),
          );
          yield* (lifecycle?.accountRetiring?.(yield* publicAccount(saved)) ?? Effect.void).pipe(
            Effect.mapError(
              () => new InteractiveRetirementFailed({ account, reason: "authority" }),
            ),
          );
          for (const table of ["webhookAccounts", "workflowAccounts"] as const)
            if (
              (yield* query(() =>
                tx.findFirst(table, { where: (b) => b("account", "=", account) }),
              )) !== null
            )
              return yield* new InteractiveRetirementFailed({ account, reason: "active" });
          yield* query(() =>
            tx.updateMany("accountConnections", {
              where: (b) => b("id", "=", row.id),
              set: {
                state: encode({
                  ...state,
                  interactive: {
                    ...binding,
                    retirement: {
                      token,
                      expiresAt: now + retirementLeaseMillis,
                      removed: lease?.removed ?? false,
                    },
                  },
                }),
              },
            }),
          );
          claims.push({
            owner: input.owner,
            account,
            connection: row.id,
            token,
            removed: lease?.removed ?? false,
          });
        }
        return claims;
      }),
    );
  const current = (claim: RetirementClaim) =>
    lockConnection(db, claim, crypto).pipe(
      Effect.catchTag("AccountConnectionNotFound", () => Effect.succeed(undefined)),
      Effect.mapError(() => new StorageError()),
    );
  const ensure = (claim: RetirementClaim) =>
    Effect.gen(function* () {
      const row = yield* current(claim);
      if (
        row?.storedState.status !== "completed" ||
        row.storedState.interactive?.retirement?.token !== claim.token
      )
        return yield* new InteractiveRetirementBusy({ account: claim.account });
    });
  const release = (claim: RetirementClaim, removed: boolean) =>
    transaction(db, () =>
      Effect.gen(function* () {
        const row = yield* current(claim);
        if (
          row?.storedState.status !== "completed" ||
          row.storedState.interactive?.retirement?.token !== claim.token
        )
          return;
        const state = row.storedState,
          binding = state.interactive;
        if (binding === undefined) return;
        yield* query(() =>
          db.updateMany("accountConnections", {
            where: (b) => b("id", "=", row.id),
            set: {
              state: encode({ ...state, interactive: { ...binding, retirement: { removed } } }),
            },
          }),
        );
      }),
    );
  return { check, begin, ensure, release };
};
