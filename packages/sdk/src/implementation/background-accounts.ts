/**
 * The accounts background work runs with. Schedules, webhook callbacks and their reconciliation
 * have no caller to name accounts, so each run resolves them at that moment: app requirements
 * from the app links, and user requirements from its actor's user links. Work without an actor, an
 * app schedule or an app-account webhook, runs with the app's accounts only.
 */
import { Effect, Schema } from "effect";
import { AccountRequired, type AppAccounts } from "../contracts/apps.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import {
  AccountId,
  ProviderId,
  StorageError,
  type AppId,
  type DeploymentId,
} from "../contracts/shared.ts";
import { storedApp, storedDeployment } from "./apps.ts";
import { query, type Query } from "./database.ts";
import { plainAccount } from "./linked-accounts.ts";

const LinkedAccount = Schema.Struct({ id: AccountId, provider: ProviderId });

/** The stored accounts of these IDs that still exist, in the IDs' order. */
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

/**
 * Resolve every requirement of the app's active deployment, or of `deployment` when pinned:
 *
 * - App requirements use the app links (`appLinks`), oldest first: a plain one the newest (see
 *   `plainAccount`), many() every one. A plain one with no link fails with `AccountRequired`.
 * - With an actor, user requirements use the actor's user links (`userLinks`) the same way. A plain
 *   requirement the actor links the `source` account to uses that account; user-account webhook
 *   subscriptions fix their source. A source serves only the requirements it is linked to, never
 *   another one of the same provider. Without an actor user requirements are not resolved, and the
 *   run has no `user`.
 *
 * Without a product lifecycle nothing is linked. With one, a user source its actor no longer links
 * is reported with `sourceActorLost`, so the product can hand the source to another subject; it
 * serves no requirement in this run. An app-account source serves its plain app requirement while
 * it stays linked to it.
 */
export const backgroundAccounts = (
  db: Query,
  lifecycle: ResourceLifecycle | undefined,
  input: {
    readonly app: AppId;
    readonly deployment?: DeploymentId | undefined;
    /** The subject a user-scope run is checked against; undefined for app-scope work. */
    readonly actor: string | undefined;
    readonly source?: AccountId | undefined;
  },
) =>
  Effect.gen(function* () {
    const app = yield* storedApp(db, { app: input.app });
    const deployment = yield* storedDeployment(db, app, input.deployment);
    const requirements = Object.entries(deployment.requirements.accounts);
    const required = (scope: "app" | "user") =>
      requirements.filter(([, requirement]) => requirement.scope === scope);
    const resolved: {
      app: Record<string, ReadonlyArray<AccountId>>;
      user: Record<string, ReadonlyArray<AccountId>>;
    } = { app: {}, user: {} };
    const fail = (slot: string, scope: "app" | "user") =>
      new AccountRequired({ app: app.id, deployment: deployment.id, slot, scope });

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
        // An app-account webhook fixes its source while it stays linked.
        const account =
          input.source !== undefined && linked.includes(input.source)
            ? input.source
            : plainAccount(linked);
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
    // A source serving an app requirement is the app's own link, not the actor's.
    const appSource =
      input.source !== undefined &&
      Object.values(resolved.app).some((linked) => linked.includes(input.source as AccountId));
    // A user source the actor no longer links serves none of their requirements. The product hands
    // it to another member or removes it; its registrations are removed with the accounts they
    // were registered with, not these.
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
      // In link order, so the newest link is last.
      const candidates = links.flatMap((link) => {
        const account = link.requirement === slot ? found.get(link.account) : undefined;
        return account === undefined ? [] : [account.id];
      });
      if (requirement.cardinality === "many") {
        resolved.user[slot] = candidates;
        continue;
      }
      // A user-account webhook fixes its source for the requirements it is linked to only; another
      // requirement of the same provider keeps its own link.
      const account =
        input.source !== undefined && !appSource && candidates.includes(input.source)
          ? input.source
          : plainAccount(candidates);
      if (account === undefined) return yield* fail(slot, "user");
      resolved.user[slot] = [account];
    }
    return resolved satisfies AppAccounts;
  });
