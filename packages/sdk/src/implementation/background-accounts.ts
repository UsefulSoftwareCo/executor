import { Effect, Schema } from "effect";
import { AccountRequired, type AppAccounts } from "../contracts/apps.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import {
  AccountId,
  ProviderId,
  StorageError,
  type AppId,
  type VersionId,
} from "../contracts/shared.ts";
import { storedApp, storedVersion } from "./apps.ts";
import { query, type Query } from "./database.ts";
import { plainAccount } from "./linked-accounts.ts";

const LinkedAccount = Schema.Struct({ id: AccountId, provider: ProviderId });

const readAccounts = (db: Query, ids: readonly AccountId[]) =>
  Effect.gen(function* () {
    const rows =
      ids.length === 0
        ? []
        : yield* query(() =>
            db.findMany("accounts", {
              select: ["id", "provider"],
              where: (b) => b("id", "in", ids),
            }),
          );
    const found = yield* Schema.decodeUnknownEffect(Schema.Array(LinkedAccount))(rows).pipe(
      Effect.mapError(() => new StorageError()),
    );
    return ids.flatMap((id) => found.filter((account) => account.id === id));
  });

export const backgroundAccounts = (
  db: Query,
  lifecycle: ResourceLifecycle | undefined,
  input: {
    readonly app: AppId;
    readonly version?: VersionId | undefined;
    readonly actor: string | undefined;
    readonly source?: AccountId | undefined;
    readonly connecting?: string;
  },
) =>
  Effect.gen(function* () {
    const app = yield* storedApp(db, { app: input.app });
    const version = yield* storedVersion(db, app, input.version);
    const requirements = Object.entries(version.requirements.accounts);
    const required = (scope: "app" | "user") =>
      requirements.filter(([, requirement]) => requirement.scope === scope);
    const resolved: {
      app: Record<string, ReadonlyArray<AccountId>>;
      user: Record<string, ReadonlyArray<AccountId>>;
    } = { app: {}, user: {} };
    const fail = (slot: string, scope: "app" | "user") =>
      new AccountRequired({ app: app.id, version: version.id, slot, scope });

    const appRequirements = required("app");
    if (appRequirements.length > 0) {
      const links = lifecycle === undefined ? [] : yield* lifecycle.appLinks({ app: app.id });
      const existing = new Set(
        (yield* readAccounts(db, [...new Set(links.map(({ account }) => account))])).map(
          (account) => account.id,
        ),
      );
      for (const [slot, requirement] of appRequirements) {
        const linked = links
          .filter((link) => link.requirement === slot && existing.has(link.account))
          .map((link) => link.account);
        if (requirement.cardinality === "many") {
          resolved.app[slot] = linked;
          continue;
        }
        const account =
          input.source !== undefined && linked.includes(input.source)
            ? input.source
            : plainAccount(linked);
        if (account === undefined && input.connecting !== undefined) continue;
        if (account === undefined) return yield* fail(slot, "app");
        resolved.app[slot] = [account];
      }
    }

    if (input.actor === undefined) return { app: resolved.app } satisfies AppAccounts;
    const userRequirements = required("user");
    if (userRequirements.length === 0) return { app: resolved.app, user: {} } satisfies AppAccounts;
    const links =
      lifecycle === undefined
        ? []
        : yield* lifecycle.userLinks({ app: app.id, subject: input.actor });
    const appSource =
      input.source !== undefined &&
      Object.values(resolved.app).some((linked) => linked.includes(input.source as AccountId));
    if (
      input.source !== undefined &&
      !appSource &&
      lifecycle !== undefined &&
      !links.some((link) => link.account === input.source)
    )
      yield* lifecycle.sourceActorLost({
        app: app.id,
        account: input.source,
        actor: input.actor,
      });
    const accounts = yield* readAccounts(db, [...new Set(links.map((link) => link.account))]);
    const found = new Map(accounts.map((account) => [account.id, account]));
    for (const [slot, requirement] of userRequirements) {
      const candidates = links.flatMap((link) => {
        const account = link.requirement === slot ? found.get(link.account) : undefined;
        return account === undefined ? [] : [account.id];
      });
      if (requirement.cardinality === "many") {
        resolved.user[slot] = candidates;
        continue;
      }
      const account =
        input.source !== undefined && !appSource && candidates.includes(input.source)
          ? input.source
          : plainAccount(candidates);
      if (account === undefined && input.connecting !== undefined) continue;
      if (account === undefined) return yield* fail(slot, "user");
      resolved.user[slot] = [account];
    }
    return resolved satisfies AppAccounts;
  });
