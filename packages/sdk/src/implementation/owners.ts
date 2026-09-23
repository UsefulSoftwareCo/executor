/** One transactional purge for an owner that no longer exists. */
import { Effect } from "effect";
import type { Executor } from "../contracts/executor.ts";
import { OwnerWebhooksActive } from "../contracts/owner.ts";
import { AppWorkflowsActive } from "../contracts/apps.ts";
import { AccountWorkflowsActive } from "../contracts/account.ts";
import { AccountId, OwnerId, WebhookId } from "../contracts/shared.ts";
import { query, transaction, type Query } from "./database.ts";

/**
 * The refusals a caller cannot clear by acting on providers: work is in flight
 * and will finish on its own. Read-only, so `check` and `remove` share one
 * definition and a caller can gate irreversible steps on the same verdict.
 */
const assertNoWorkInFlight = (tx: Query, owner: OwnerId, accountIds: ReadonlyArray<AccountId>) =>
  Effect.gen(function* () {
    const activeRun = yield* query(() =>
      tx.findFirst("workflowRuns", {
        where: (b) =>
          b.and(
            b("owner", "=", owner),
            b.or(b("status", "=", "queued"), b("status", "=", "running")),
          ),
      }),
    );
    if (activeRun !== null) return yield* new AppWorkflowsActive({ app: activeRun.app });
    if (accountIds.length > 0) {
      const pinned = yield* query(() =>
        tx.findFirst("workflowAccounts", {
          where: (b) => b("account", "in", accountIds),
        }),
      );
      if (pinned !== null) return yield* new AccountWorkflowsActive({ account: pinned.account });
    }
  });

/** Owner-keyed rows and the app/account-keyed rows that hang off them, deleted in dependency order. */
export const makeOwners = (db: Query): Executor["owners"] => ({
  check: (input: Parameters<Executor["owners"]["check"]>[0]) =>
    transaction(db, (tx) =>
      Effect.gen(function* () {
        const owner = input.owner;
        const accounts = yield* query(() =>
          tx.findMany("accounts", { select: ["id"], where: (b) => b("owner", "=", owner) }),
        );
        yield* assertNoWorkInFlight(
          tx,
          owner,
          accounts.map((account) => account.id),
        );
        return { owner };
      }),
    ).pipe(Effect.withSpan("sdk.owners.check")),
  remove: (input: Parameters<Executor["owners"]["remove"]>[0]) =>
    transaction(db, (tx) =>
      Effect.gen(function* () {
        const owner = input.owner;
        // Workflow start locks apps before accounts. Hold that same order through the purge.
        yield* query(() =>
          tx.updateMany("apps", { where: (b) => b("owner", "=", owner), set: { owner } }),
        );
        yield* query(() =>
          tx.updateMany("accounts", { where: (b) => b("owner", "=", owner), set: { owner } }),
        );
        const apps = yield* query(() =>
          tx.findMany("apps", { select: ["id"], where: (b) => b("owner", "=", owner) }),
        );
        const accounts = yield* query(() =>
          tx.findMany("accounts", { select: ["id"], where: (b) => b("owner", "=", owner) }),
        );
        const webhooks = yield* query(() =>
          tx.findMany("webhooks", {
            select: ["id", "status"],
            where: (b) => b("owner", "=", owner),
          }),
        );
        // A registration still held at the provider is the caller's to remove; never abandon it.
        const live = webhooks.filter((webhook) => webhook.status !== "stopped");
        if (live.length > 0)
          return yield* new OwnerWebhooksActive({
            owner,
            subscriptions: live.map((webhook) => WebhookId.make(webhook.id)),
          });
        const appIds = apps.map((app) => app.id);
        const accountIds = accounts.map((account) => account.id);
        const webhookIds = webhooks.map((webhook) => webhook.id);
        yield* assertNoWorkInFlight(tx, owner, accountIds);
        const runs = yield* query(() =>
          tx.findMany("workflowRuns", {
            select: ["id"],
            where: (b) => b("owner", "=", owner),
          }),
        );
        if (runs.length > 0) {
          yield* query(() =>
            tx.deleteMany("workflowAccounts", {
              where: (b) =>
                b(
                  "run",
                  "in",
                  runs.map((run) => run.id),
                ),
            }),
          );
          yield* query(() =>
            tx.deleteMany("workflowRuns", { where: (b) => b("owner", "=", owner) }),
          );
        }
        if (webhookIds.length > 0) {
          yield* query(() =>
            tx.deleteMany("webhookAccounts", {
              where: (b) => b("subscription", "in", webhookIds),
            }),
          );
          yield* query(() => tx.deleteMany("webhooks", { where: (b) => b("owner", "=", owner) }));
        }
        // The due scan selects on schedule state alone, so a surviving schedule keeps
        // claiming and failing forever. Delete by owner, not by app, so a schedule whose
        // app row already went stays reachable. Same order as apps.remove.
        yield* query(() =>
          tx.deleteMany("scheduledRuns", { where: (b) => b("owner", "=", owner) }),
        );
        yield* query(() => tx.deleteMany("schedules", { where: (b) => b("owner", "=", owner) }));
        if (appIds.length > 0) {
          yield* query(() => tx.deleteMany("appRecords", { where: (b) => b("app", "in", appIds) }));
          yield* query(() => tx.deleteMany("profiles", { where: (b) => b("owner", "=", owner) }));
          yield* query(() => tx.deleteMany("apps", { where: (b) => b("owner", "=", owner) }));
        }
        if (accountIds.length > 0) {
          yield* query(() =>
            tx.deleteMany("oauthGrants", { where: (b) => b("id", "in", accountIds) }),
          );
          yield* query(() => tx.deleteMany("accounts", { where: (b) => b("owner", "=", owner) }));
        }
        const connections = yield* query(() =>
          tx.findMany("accountConnections", {
            select: ["id", "oauthAttempt"],
            where: (b) => b("owner", "=", owner),
          }),
        );
        const attempts = connections
          .map((connection) => connection.oauthAttempt)
          .filter((attempt): attempt is string => attempt !== null);
        if (attempts.length > 0)
          yield* query(() =>
            tx.deleteMany("oauthAttempts", { where: (b) => b("id", "in", attempts) }),
          );
        if (connections.length > 0)
          yield* query(() =>
            tx.deleteMany("accountConnections", { where: (b) => b("owner", "=", owner) }),
          );
        yield* query(() =>
          tx.deleteMany("toolApprovals", { where: (b) => b("owner", "=", owner) }),
        );
        // Apps reference their active deployment, so retained code is removed last.
        const deployments = yield* query(() =>
          tx.findMany("deployments", { select: ["id"], where: (b) => b("owner", "=", owner) }),
        );
        if (deployments.length > 0)
          yield* query(() =>
            tx.deleteMany("deployments", { where: (b) => b("owner", "=", owner) }),
          );
        return {
          owner,
          apps: appIds.length,
          accounts: accountIds.length,
          deployments: deployments.length,
          connections: connections.length,
        };
      }),
    ).pipe(Effect.withSpan("sdk.owners.remove")),
});
