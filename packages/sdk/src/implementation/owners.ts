/** One transactional purge for an owner that no longer exists. */
import { type Duration, Effect, Option } from "effect";
import type { Executor } from "../contracts/executor.ts";
import { OwnerWebhooksActive } from "../contracts/owner.ts";
import { AppWorkflowsActive } from "../contracts/apps.ts";
import { AccountWorkflowsActive } from "../contracts/account.ts";
import { AccountId, OwnerId, WebhookId } from "../contracts/shared.ts";
import type { RemovedGrant } from "./accounts.ts";
import { query, transaction, type Query } from "./database.ts";
import { removeToolSearch } from "./tool-search-store.ts";

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

/** How many removed grants are revoked at their providers at once. */
const revocationConcurrency = 8;

/**
 * How long one revocation in a purge may take. A revocation is one small request that a working
 * endpoint answers in well under a second. The protocol's 30-second request timeout, which a single
 * account's removal keeps, covers every OAuth request rather than being chosen for this one; at that
 * timeout a stalled provider would let a purge get through only 80 grants in the default budget.
 */
const revocationDeadline: Duration.Input = "10 seconds";

/**
 * How long a purge spends revoking, all grants together, by default. Organization removal runs the
 * purge as one durable step that Cloudflare Workflows ends at 10 minutes, and the purge's own
 * transaction shares that step. With the deadline above, a provider that never answers still
 * gets at least 240 revocation requests (all of them time out); a working one, thousands.
 */
const defaultRevocationBudget: Duration.Input = "5 minutes";

/** Owner-keyed rows and the app/account-keyed rows that hang off them, deleted in dependency order. */
export const makeOwners = (
  db: Query,
  /**
   * Best-effort provider-side revocation, bounded by `deadline`; it never fails and runs only after
   * the purge commits.
   */
  revokeRemoved: (removed: RemovedGrant, deadline: Duration.Input) => Effect.Effect<void>,
  /** See `ExecutorInputs.ownerRevocationBudget`. */
  revocationBudget: Duration.Input = defaultRevocationBudget,
): Executor["owners"] => ({
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
    Effect.gen(function* () {
      const { removed, grants } = yield* transaction(db, (tx) =>
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
            tx.findMany("accounts", {
              select: ["id", "provider"],
              where: (b) => b("owner", "=", owner),
            }),
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
          // Webhook sources belong to the app owner; delete by owner for the same reason as schedules.
          yield* query(() =>
            tx.deleteMany("webhookSources", { where: (b) => b("owner", "=", owner) }),
          );
          // Event subscriptions too, so a subscription whose app row already went stays reachable.
          const subscriptions = yield* query(() =>
            tx.findMany("eventSubscriptions", {
              select: ["id"],
              where: (b) => b("owner", "=", owner),
            }),
          );
          if (subscriptions.length > 0) {
            yield* query(() =>
              tx.deleteMany("eventDeliveries", {
                where: (b) =>
                  b(
                    "subscription",
                    "in",
                    subscriptions.map((subscription) => subscription.id),
                  ),
              }),
            );
            yield* query(() =>
              tx.deleteMany("eventSubscriptions", { where: (b) => b("owner", "=", owner) }),
            );
          }
          if (appIds.length > 0) {
            yield* query(() => tx.deleteMany("events", { where: (b) => b("app", "in", appIds) }));
            yield* query(() =>
              tx.deleteMany("appRecords", { where: (b) => b("app", "in", appIds) }),
            );
            yield* query(() =>
              tx.deleteMany("accountChecks", { where: (b) => b("app", "in", appIds) }),
            );
            yield* removeToolSearch(tx, appIds);
            yield* query(() => tx.deleteMany("apps", { where: (b) => b("owner", "=", owner) }));
          }
          // The grants deleted here are revoked once the purge commits. A repeated purge finds none,
          // so each grant is revoked at most once.
          const grants: Array<RemovedGrant> = [];
          if (accountIds.length > 0) {
            yield* query(() =>
              tx.deleteMany("accountChecks", { where: (b) => b("account", "in", accountIds) }),
            );
            const stored = yield* query(() =>
              tx.findMany("oauthGrants", {
                select: ["id", "encrypted"],
                where: (b) => b("id", "in", accountIds),
              }),
            );
            const encrypted = new Map(stored.map((grant) => [grant.id, grant.encrypted]));
            for (const account of accounts) {
              const bytes = encrypted.get(account.id);
              if (bytes !== undefined)
                grants.push({ account: account.id, provider: account.provider, encrypted: bytes });
            }
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
          // Grants keep their own copy of a client, so other owners' accounts keep renewing.
          yield* query(() =>
            tx.deleteMany("storedOAuthClients", { where: (b) => b("owner", "=", owner) }),
          );
          yield* query(() =>
            tx.deleteMany("storedOAuthClientCredentials", { where: (b) => b("owner", "=", owner) }),
          );
          // Apps reference their active version, so retained code is removed last.
          const versions = yield* query(() =>
            tx.findMany("deployments", { select: ["id"], where: (b) => b("owner", "=", owner) }),
          );
          if (versions.length > 0)
            yield* query(() =>
              tx.deleteMany("deployments", { where: (b) => b("owner", "=", owner) }),
            );
          return {
            removed: {
              owner,
              apps: appIds.length,
              accounts: accountIds.length,
              versions: versions.length,
              connections: connections.length,
            },
            grants,
          };
        }),
      );
      // Revoke only after the purge is durable, and before the call returns: a durable caller
      // such as organization removal ends its step here, and nothing would revoke a grant left to
      // work the step does not wait for. The outcomes cannot change the result.
      //
      // The pass is bounded so it ends inside that step's time limit. When the budget runs out,
      // revocations still in flight are cut off and grants not yet started are never revoked:
      // their records are already deleted, so a retry finds nothing to revoke. Those tokens stay
      // valid at the provider until it expires them, as every grant did before removal revoked
      // any. The span and a warning log record how many, never which.
      let started = 0;
      let settled = 0;
      const finished = yield* Effect.forEach(
        grants,
        (grant) =>
          Effect.suspend(() => {
            started++;
            // Counted only when it finishes: one the budget interrupts is cut off, not settled.
            return revokeRemoved(grant, revocationDeadline).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  settled++;
                }),
              ),
            );
          }),
        { concurrency: revocationConcurrency, discard: true },
      ).pipe(Effect.timeoutOption(revocationBudget));
      const counts = {
        grants: grants.length,
        settled,
        cutOff: started - settled,
        unattempted: grants.length - started,
      };
      yield* Effect.annotateCurrentSpan({
        "oauth.revocation.grants": counts.grants,
        "oauth.revocation.settled": counts.settled,
        "oauth.revocation.cut_off": counts.cutOff,
        "oauth.revocation.unattempted": counts.unattempted,
      });
      if (Option.isNone(finished))
        yield* Effect.logWarning(
          "Owner removal stopped revoking OAuth grants at its time budget; the rest stay valid at their providers",
        ).pipe(Effect.annotateLogs(counts));
      return removed;
    }).pipe(Effect.withSpan("sdk.owners.remove")),
});
