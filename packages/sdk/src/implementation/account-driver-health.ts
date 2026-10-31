import { Clock, Effect, Option, Result, Schema } from "effect";
import { AccountInfo, AccountCheckResult, HostOutputInvalid, ProviderError } from "apps/contracts";
import { AccountAcquisitionUnavailable } from "../contracts/account-acquisition-driver.ts";
import type {
  AccountDriverHealth,
  AccountHealth,
  AccountCheckStatus,
} from "../contracts/account.ts";
import type { StoredAccount } from "../contracts/storage.ts";
import { StorageError } from "../contracts/shared.ts";
import { query, transaction, type Query } from "./database.ts";
import { accountCheckRecord } from "./account-check-record.ts";
import {
  driverSourceCurrent,
  retainedDriverBinding,
  type AccountDriverResolver,
  type DriverAccount,
} from "./account-driver-source.ts";

export const makeDriverAccountHealth = (
  db: Query,
  acquisition: AccountDriverResolver | undefined,
  failure: {
    readonly status: (error: unknown) => AccountCheckStatus;
    readonly message: (error: unknown, late: boolean) => string | undefined;
  },
) => {
  const rows = (accounts: readonly DriverAccount[]) =>
    query(() =>
      db.findMany("accountDriverChecks", {
        where: (b) =>
          b(
            "account",
            "in",
            accounts.map((account) => account.id),
          ),
      }),
    );
  type Row = Effect.Success<ReturnType<typeof rows>>[number];
  const project = (account: DriverAccount, row: Row | undefined) =>
    Effect.gen(function* () {
      const binding = yield* retainedDriverBinding(acquisition, account);
      if (binding === undefined) return undefined;
      const saved =
        row !== undefined && row.driver === binding.driver && row.owner === account.owner
          ? row
          : undefined;
      const current =
        binding.removal === null &&
        saved !== undefined &&
        saved.generation === account.credentialGeneration &&
        saved.driverRevision === binding.driverRevision &&
        saved.bindingRevision === binding.revision;
      const info =
        saved === undefined ? Option.none() : Schema.decodeUnknownOption(AccountInfo)(saved.info);
      return {
        driver: {
          source: {
            kind: "driver",
            id: binding.driver,
            version: saved?.driverRevision ?? binding.driverRevision,
          },
          checkable: current && saved?.checkable === true,
          check:
            saved?.status == null
              ? null
              : {
                  status: saved.status,
                  checkedAt: saved.checkedAt,
                  current,
                  ...(saved.reason === null ? {} : { reason: saved.reason }),
                  ...(saved.message === null ? {} : { message: saved.message }),
                },
        } satisfies AccountDriverHealth,
        info: Option.getOrNull(info),
        infoCheckedAt: saved?.infoCheckedAt ?? null,
      };
    });

  const report = (account: DriverAccount) =>
    Effect.gen(function* () {
      if (acquisition === undefined) return undefined;
      return yield* project(account, (yield* rows([account]))[0]);
    });
  const list = (accounts: readonly DriverAccount[]) =>
    Effect.gen(function* () {
      if (acquisition === undefined || accounts.length === 0)
        return new Map<DriverAccount["id"], Effect.Success<ReturnType<typeof project>>>();
      const recorded = yield* rows(accounts);
      const values = yield* Effect.forEach(
        accounts,
        (account) =>
          Effect.gen(function* () {
            const result = yield* project(
              account,
              recorded.find((row) => row.account === account.id),
            );
            return [account.id, result] as const;
          }),
        { concurrency: 4 },
      );
      return new Map(values);
    });

  const check = (account: StoredAccount) =>
    Effect.gen(function* () {
      if (acquisition === undefined) return;
      const source = yield* acquisition.source({ account: account.id, owner: account.owner });
      if (source === undefined) return;
      const hook = source.check;
      const startedAt = yield* Clock.currentTimeMillis;
      // Missing capability is not a successful credential check.
      if (hook === undefined) {
        yield* transaction(db, () =>
          Effect.gen(function* () {
            if (!(yield* driverSourceCurrent(source, account))) return;
            yield* query(() =>
              db.updateMany("accountDriverChecks", {
                where: (b) =>
                  b.and(b("account", "=", account.id), b("driver", "=", source.binding.driver)),
                set: { checkable: false },
              }),
            );
          }),
        );
        return;
      }
      const outcome = yield* hook().pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(AccountCheckResult)(value === undefined ? {} : value).pipe(
            Effect.mapError(() => new HostOutputInvalid()),
          ),
        ),
        Effect.timeout(15_000),
        Effect.result,
      );
      if (Result.isFailure(outcome) && Schema.is(StorageError)(outcome.failure))
        return yield* outcome.failure;
      if (Result.isFailure(outcome) && Schema.is(AccountAcquisitionUnavailable)(outcome.failure))
        return yield* outcome.failure;
      const late = (yield* Clock.currentTimeMillis) >= startedAt + 14_000;
      yield* transaction(db, () =>
        Effect.gen(function* () {
          if (!(yield* driverSourceCurrent(source, account))) return;
          const existing = yield* query(() =>
            db.findFirst("accountDriverChecks", {
              where: (b) => b("account", "=", account.id),
            }),
          );
          if (existing !== null && existing.checkedAt.getTime() > startedAt) return;
          const success = Result.isSuccess(outcome) ? outcome.success : undefined;
          const checkedAt = new Date(startedAt);
          const identity = yield* accountCheckRecord(
            existing,
            success?.accountInfo,
            undefined,
            checkedAt,
          );
          const state = {
            owner: account.owner,
            driver: source.binding.driver,
            driverRevision: source.binding.driverRevision,
            bindingRevision: source.binding.revision,
            generation: account.credentialGeneration,
            checkable: true,
            status: Result.isSuccess(outcome)
              ? ("healthy" as const)
              : failure.status(outcome.failure),
            reason:
              Result.isFailure(outcome) && Schema.is(ProviderError)(outcome.failure)
                ? outcome.failure.reason
                : null,
            checkedAt,
            ...identity,
            message: Result.isSuccess(outcome)
              ? null
              : (failure.message(outcome.failure, late)?.slice(0, 500) ?? null),
          };
          yield* query(() =>
            db.upsert("accountDriverChecks", {
              where: (b) => b("account", "=", account.id),
              create: { account: account.id, ...state },
              update: state,
            }),
          );
        }),
      );
    });
  return { report, list, check };
};

export const withDriverHealth = (
  health: AccountHealth,
  saved: Effect.Success<ReturnType<ReturnType<typeof makeDriverAccountHealth>["report"]>>,
): AccountHealth => {
  if (saved === undefined) return health;
  const useIdentity =
    saved.info !== null &&
    saved.infoCheckedAt !== null &&
    (health.infoCheckedAt === null ||
      saved.infoCheckedAt.getTime() > health.infoCheckedAt.getTime());
  return {
    ...health,
    driver: saved.driver,
    ...(useIdentity ? { info: saved.info, infoCheckedAt: saved.infoCheckedAt } : {}),
  };
};
