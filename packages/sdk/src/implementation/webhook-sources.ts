import { AppProviderFailed } from "../contracts/tools.ts";
/**
 * Managed webhook registration for each account linked to an app as a webhook source. Linking only
 * saves intent; a lease covers the network work without holding SQL transactions.
 */
import { Clock, Effect, Exit, Result, Schema, type Crypto } from "effect";
import { AccountRequired, AccountSelectionInvalid } from "../contracts/apps.ts";
import { AccountNotFound } from "../contracts/account.ts";
import { CurrentActor, type ResourceLifecycle } from "../contracts/executor.ts";
import { OAuthReconnectRequired } from "../contracts/oauth.ts";
import {
  LinkWebhookSource,
  UnlinkWebhookSource,
  UpdateWebhookSource,
  WebhookApp,
  WebhookConflict,
  WebhookFailed,
  WebhookNotFound,
  WebhookSource,
  WebhookSourceFields,
  WebhookSourceSummary,
  type WebhookSubscription,
} from "../contracts/webhooks.ts";
import {
  RequestInvalid,
  StorageError,
  type AccountId,
  type AppId,
  type Json,
} from "../contracts/shared.ts";
import { query, transaction, type Query } from "./database.ts";
import { lockApp, storedApp } from "./apps.ts";
import { storedAccount } from "./accounts.ts";
import { backgroundAccounts } from "./background-accounts.ts";
import { snapshot, type InvocationSnapshot } from "./tools.ts";
import type { makeTools } from "./tools.ts";
import type { makeWebhooks } from "./webhooks.ts";

const canonical = (value: Json): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
          .join(",")}}`
      : JSON.stringify(value);

const StoredSource = Schema.Struct({
  ...WebhookSourceFields.fields,
  id: Schema.String,
  revision: Schema.Int,
  lease: Schema.NullOr(Schema.String),
  leaseUntil: Schema.Date,
  retries: Schema.Int,
})
  // Storage keeps the columns' former names.
  .pipe(Schema.encodeKeys({ reconciledVersion: "reconciledDeployment" }));
type StoredSource = typeof StoredSource.Type;

/**
 * The wait after a source's `retries`-th attempt in a row that failed or found it needing setup: 30
 * seconds, doubling to at most an hour. A failure that persists, such as a service refusing the
 * account's OAuth client, then costs one attempt an hour instead of one a tick, and so does a
 * source waiting for a person, which an attempt cannot fix. New intent resets the count and runs
 * at once.
 */
const retryDelay = (retries: number) => Math.min(30_000 * 2 ** (retries - 1), 3_600_000);

/**
 * Completing a manual setup is new intent for the source whose subscription it completed: a source
 * that needs that setup runs again at once rather than waiting out its delay. Run in the
 * completion's transaction after it takes the app's lock, as every write that saves intent does, so
 * a pass completing meanwhile sees the new revision and runs again.
 */
export const setupCompleted = (
  tx: Query,
  input: { readonly app: AppId; readonly account: AccountId },
) =>
  Effect.gen(function* () {
    const row = yield* query(() =>
      tx.findFirst("webhookSources", {
        where: (b) => b.and(b("app", "=", input.app), b("account", "=", input.account)),
      }),
    );
    if (row === null || row.status === "removing") return;
    yield* query(() =>
      tx.updateMany("webhookSources", {
        where: (b) => b("id", "=", row.id),
        set: {
          status: "pending",
          failure: null,
          retries: 0,
          revision: row.revision + 1,
        },
      }),
    );
  });

/**
 * Keys of managed subscriptions start with `setup-` and hash the definition, source, configuration
 * and the version that created them, so retries reuse a registration and a new version registers
 * again. A manual subscription instead moves to the new version while its setup still fits, since
 * a person copied its callback URL and secret into the provider. The actor and its accounts are not
 * part of the key: callbacks resolve them at each delivery.
 *
 * A reconciliation works for the activation it claimed, the app's `activatedSequence`, which every
 * activation advances, also one back to the same version. It creates and removes subscriptions
 * only while that activation is current, and a source it claimed is ready only if no other
 * activation came in between; otherwise the source stays pending and reconciles again.
 */
export const makeWebhookSources = (
  db: Query,
  crypto: Crypto.Crypto,
  lifecycle: ResourceLifecycle | undefined,
  resources: {
    readonly webhooks: ReturnType<typeof makeWebhooks>["webhooks"];
    /** Evaluated now, never reused: reconciliation changes upstream registrations. */
    readonly liveDefinitions: ReturnType<typeof makeWebhooks>["liveDefinitions"];
    readonly retarget: ReturnType<typeof makeWebhooks>["retarget"];
    /** Creates a managed subscription beside earlier ones with the same key, for an activation. */
    readonly createManaged: ReturnType<typeof makeWebhooks>["createManaged"];
    /** Removes a managed subscription while an activation is current. */
    readonly removeManaged: ReturnType<typeof makeWebhooks>["removeManaged"];
    /** Stored-state check for an account whose sign-in must reconnect. */
    readonly accountNeedingReconnect: ReturnType<typeof makeTools>["accountNeedingReconnect"];
  },
) => {
  const now = Clock.currentTimeMillis;
  const keyFor = (value: Json) =>
    crypto.digest("SHA-256", new TextEncoder().encode(canonical(value))).pipe(
      Effect.map(
        (bytes) =>
          `setup-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      ),
      Effect.mapError(() => new StorageError()),
    );
  const find = (input: { readonly app: AppId; readonly account: AccountId }) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("webhookSources", {
          where: (b) => b.and(b("app", "=", input.app), b("account", "=", input.account)),
        }),
      );
      return row === null
        ? undefined
        : yield* Schema.decodeUnknownEffect(StoredSource)(row).pipe(
            Effect.mapError(() => new StorageError()),
          );
    });
  const view = (row: StoredSource) =>
    Schema.decodeUnknownEffect(WebhookSource)(row).pipe(Effect.mapError(() => new StorageError()));
  /**
   * The source's accounts on the active version: the account itself, the app links and, for a
   * user link, the actor's others. An app link's source has no actor.
   */
  const accountsOf = (source: StoredSource) =>
    backgroundAccounts(db, lifecycle, {
      app: source.app,
      actor: source.actor ?? undefined,
      source: source.account,
    });
  /** Managed subscriptions this source registered. */
  const managed = (source: StoredSource) =>
    resources.webhooks
      .list({ app: source.app })
      .pipe(
        Effect.map((hooks) =>
          hooks.filter(
            (hook: WebhookSubscription) =>
              hook.sourceAccount === source.account && hook.key.startsWith("setup-"),
          ),
        ),
      );

  const reconcile = (
    input: { readonly app: AppId; readonly account: AccountId },
    automatic = false,
  ) =>
    Effect.gen(function* () {
      const token = yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()));
      return yield* Effect.acquireUseRelease(
        transaction(db, (tx) =>
          Effect.gen(function* () {
            const app = yield* lockApp(tx, { app: input.app });
            const current = yield* find(input);
            if (current === undefined) return { app, current, claimed: false };
            const time = yield* now;
            if (
              (current.lease !== null && current.leaseUntil.getTime() > time) ||
              (automatic && current.status !== "pending" && current.leaseUntil.getTime() > time) ||
              (current.status === "ready" && current.reconciledVersion === app.activeVersion)
            )
              return { app, current, claimed: false };
            yield* query(() =>
              tx.updateMany("webhookSources", {
                where: (b) => b("id", "=", current.id),
                set: { lease: token, leaseUntil: new Date(time + 120_000) },
              }),
            );
            return { app, current, claimed: true };
          }),
        ),
        (claim) =>
          Effect.gen(function* () {
            const { app, current } = claim;
            if (current === undefined) return undefined;
            if (!claim.claimed) {
              yield* Effect.annotateCurrentSpan("executor.webhooks.source.claimed", false);
              return yield* view(current);
            }
            const removing = current.status === "removing";
            let failure: WebhookSource["failure"] = null;
            let status: WebhookSource["status"] = removing ? "removing" : "ready";
            // How many of the active version's webhooks use this source, once evaluated.
            let served: number | undefined;
            const attempt = yield* Effect.gen(function* () {
              const hooks = yield* managed(current);
              if (removing) {
                for (const hook of hooks)
                  if (hook.status !== "stopped") {
                    const stopped = yield* resources.webhooks.remove({
                      app: app.id,
                      subscription: hook.id,
                    });
                    if (stopped.status !== "stopped") failure = "cleanup";
                  }
                return;
              }
              if (app.activeVersion === null) {
                status = "needs-setup";
                failure = "deployment";
                return;
              }
              const version = app.activeVersion;
              const activation = app.activatedSequence;
              const accounts = yield* accountsOf(current);
              const state: InvocationSnapshot = yield* snapshot(db, {
                app: app.id,
                version,
                accounts,
              });
              const source = yield* storedAccount(db, current.account);
              const definitions = yield* resources.liveDefinitions(state);
              const desired = new Set<string>();
              for (const hook of definitions) {
                const required = Object.hasOwn(state.version.requirements.accounts, hook.account)
                  ? state.version.requirements.accounts[hook.account]
                  : undefined;
                // Only definitions of the source's scope whose requirement the run resolved to this
                // account use it as their source: an app link serves the app-account webhooks of the
                // requirements it is linked to, a user link user-account webhooks. Another
                // requirement of the same provider is linked to other accounts.
                const selected = Object.hasOwn(state.accounts, hook.account)
                  ? state.accounts[hook.account]
                  : undefined;
                if (
                  required === undefined ||
                  required.provider !== source.provider ||
                  (required.scope === "app") !== (current.actor === null) ||
                  selected === undefined ||
                  !(typeof selected === "string"
                    ? selected === current.account
                    : selected.includes(current.account))
                )
                  continue;
                const supplied = current.config[hook.name];
                const config = supplied === undefined ? {} : supplied;
                const key = yield* keyFor({
                  name: hook.name,
                  account: current.account,
                  config,
                  version,
                });
                // A subscription pinned to another version, such as one an earlier version created
                // and a later one carried, goes through creation, which moves a manual one back
                // only while its setup still fits.
                const kept = hooks.find(
                  (saved) =>
                    saved.key === key &&
                    saved.version === version &&
                    (saved.status === "active" ||
                      saved.status === "pending" ||
                      saved.status === "setup-required"),
                );
                // Creating may instead carry a manual subscription from an earlier version.
                const created =
                  kept ??
                  (yield* resources.createManaged(
                    {
                      app: app.id,
                      actor: current.actor,
                      name: hook.name,
                      sourceAccount: current.account,
                      key,
                      config,
                    },
                    activation,
                  ));
                desired.add(created.id);
                // A registration kept from an earlier actor follows the source's current one.
                yield* resources.retarget(created.id, current.actor);
                const subscription =
                  created.status === "pending"
                    ? yield* resources.webhooks.reconcile({
                        app: app.id,
                        subscription: created.id,
                      })
                    : created;
                if (subscription.status === "setup-required") {
                  status = "needs-setup";
                  failure = "configuration";
                } else if (subscription.status !== "active") {
                  status = "failed";
                  failure = "registration";
                }
              }
              served = desired.size;
              // Old registrations retain the code and state required for their own cleanup.
              for (const hook of hooks)
                if (hook.status !== "stopped" && !desired.has(hook.id)) {
                  const stopped = yield* resources.removeManaged(
                    { app: app.id, subscription: hook.id },
                    activation,
                  );
                  if (stopped.status !== "stopped") {
                    status = "failed";
                    failure = "cleanup";
                  }
                }
            }).pipe(
              Effect.provideService(CurrentActor, current.actor ?? undefined),
              Effect.timeout("90 seconds"),
              Effect.result,
            );
            if (Result.isFailure(attempt)) {
              const error = attempt.failure;
              status = removing ? "removing" : "failed";
              failure = removing ? "cleanup" : "registration";
              if (
                !removing &&
                (Schema.is(AccountRequired)(error) ||
                  Schema.is(AccountNotFound)(error) ||
                  Schema.is(AccountSelectionInvalid)(error) ||
                  Schema.is(OAuthReconnectRequired)(error) ||
                  (Schema.is(AppProviderFailed)(error) &&
                    (error.reason === "unauthorized" || error.reason === "forbidden")))
              ) {
                status = "needs-setup";
                failure = "accounts";
              }
              if (!removing && Schema.is(WebhookFailed)(error) && error.reason === "input") {
                status = "needs-setup";
                failure = "configuration";
              }
            } else if (removing && failure !== null) status = "removing";
            const result = yield* transaction(db, (tx) =>
              Effect.gen(function* () {
                const liveApp = yield* lockApp(tx, { app: input.app });
                const live = yield* find(input);
                if (live === undefined || live.lease !== token)
                  return live === undefined ? undefined : yield* view(live);
                // Another activation since the claim, even one back to the same version, means this
                // pass may have created or kept subscriptions for an activation that is no longer
                // current, so it does not count.
                const changed =
                  live.revision !== current.revision ||
                  liveApp.activatedSequence !== app.activatedSequence;
                const completedAt = yield* now;
                // A removed source is deleted once its subscriptions have stopped.
                if (!changed && removing && failure === null) {
                  yield* query(() =>
                    tx.deleteMany("webhookSources", { where: (b) => b("id", "=", live.id) }),
                  );
                  return yield* view({ ...live, lease: null });
                }
                const next = changed
                  ? live.status === "removing"
                    ? "removing"
                    : "pending"
                  : status;
                // A source that failed, needs setup or could not finish removing backs off: another
                // attempt cannot succeed until something changes. The changes Executor sees save new
                // intent, which runs at once: linking, configuring, an activation, new credentials
                // for its account and completing a manual setup.
                const retries = !changed && next !== "ready" ? live.retries + 1 : 0;
                yield* query(() =>
                  tx.updateMany("webhookSources", {
                    where: (b) => b("id", "=", live.id),
                    set: {
                      status: next,
                      failure: changed ? null : failure,
                      lease: null,
                      leaseUntil: new Date(completedAt + (retries > 0 ? retryDelay(retries) : 0)),
                      retries,
                      ...(next === "ready" ? { reconciledDeployment: app.activeVersion } : {}),
                    },
                  }),
                );
                const saved = yield* find(input);
                return saved === undefined ? undefined : yield* view(saved);
              }),
            );
            yield* Effect.annotateCurrentSpan({
              "executor.webhooks.source.claimed": true,
              "executor.webhooks.source.status": result === undefined ? "gone" : result.status,
              ...(result === undefined || result.failure === null
                ? {}
                : { "executor.webhooks.source.failure": result.failure }),
              ...(served === undefined ? {} : { "executor.webhooks.source.served": served }),
            });
            return result;
          }),
        (claim, exit) =>
          !claim.claimed || claim.current === undefined || Exit.isSuccess(exit)
            ? Effect.void
            : transaction(db, (tx) =>
                Effect.gen(function* () {
                  // Acquire/release owns the claim across interruption and defects too.
                  // A completed or superseded claim must never release another worker's lease.
                  yield* lockApp(tx, { app: input.app });
                  yield* query(() =>
                    tx.updateMany("webhookSources", {
                      where: (b) =>
                        b.and(
                          b("app", "=", input.app),
                          b("account", "=", input.account),
                          b("lease", "=", token),
                        ),
                      set: { lease: null, leaseUntil: new Date(0) },
                    }),
                  );
                }),
              ).pipe(Effect.orDie),
      );
    }).pipe(
      Effect.withSpan("sdk.webhooks.reconcileSource", {
        attributes: {
          "executor.app.id": input.app,
          "executor.account.id": input.account,
          "executor.webhooks.automatic": automatic,
        },
      }),
    );

  /**
   * A source that failed on its accounts waits while they still cannot be used: an account must
   * reconnect, or a plain requirement has no linked account. Checking reads stored state only.
   */
  const waiting = (row: StoredSource) =>
    accountsOf(row).pipe(
      Effect.flatMap((accounts) => resources.accountNeedingReconnect({ app: row.app, accounts })),
      Effect.map((account) => account !== undefined),
      Effect.catchIf(Schema.is(AccountRequired), () => Effect.succeed(true)),
      Effect.catch(() => Effect.succeed(false)),
      Effect.provideService(CurrentActor, row.actor ?? undefined),
    );

  return {
    sources: (input: typeof WebhookApp.Type) =>
      Effect.gen(function* () {
        yield* storedApp(db, input);
        const rows = yield* query(() =>
          db.findMany("webhookSources", {
            where: (b) => b("app", "=", input.app),
            orderBy: ["createdAt", "asc"],
          }),
        );
        const ids = [...new Set(rows.map((row) => row.account))];
        const accounts =
          ids.length === 0
            ? []
            : yield* query(() =>
                db.findMany("accounts", {
                  where: (b) => b("id", "in", ids),
                  select: ["id", "label"],
                }),
              );
        const labels = new Map(accounts.map((account) => [account.id, account.label]));
        return yield* Schema.decodeUnknownEffect(Schema.Array(WebhookSourceSummary))(
          rows.map((row) => ({ ...row, label: labels.get(row.account) })),
        ).pipe(Effect.mapError(() => new StorageError()));
      }),
    link: (input: typeof LinkWebhookSource.Type) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          const parsed = yield* Schema.decodeUnknownEffect(LinkWebhookSource)(input).pipe(
            Effect.mapError(() => new RequestInvalid()),
          );
          const app = yield* lockApp(tx, parsed);
          yield* storedAccount(tx, parsed.account);
          const existing = yield* find(parsed);
          // Omitted configuration keeps the saved one.
          const config =
            parsed.config !== undefined
              ? parsed.config
              : existing === undefined
                ? {}
                : existing.config;
          // Without an actor the account is an app link and serves app-account webhooks; with one,
          // a user link. Linking in the other scope moves the source, as a handover moves its actor.
          const fields = {
            actor: parsed.actor ?? null,
            accounts: {},
            config,
            status: "pending" as const,
            failure: null,
            retries: 0,
          };
          if (existing === undefined) {
            const id = `src_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()))}`;
            const createdAt = new Date(yield* now);
            yield* query(() =>
              tx.create("webhookSources", {
                id,
                app: app.id,
                owner: app.owner,
                account: parsed.account,
                ...fields,
                revision: 1,
                reconciledDeployment: null,
                lease: null,
                leaseUntil: new Date(0),
                createdAt,
              }),
            );
          } else
            yield* query(() =>
              tx.updateMany("webhookSources", {
                where: (b) => b("id", "=", existing.id),
                set: { ...fields, revision: existing.revision + 1 },
              }),
            );
          const saved = yield* find(parsed);
          if (saved === undefined) return yield* new StorageError();
          return yield* view(saved);
        }),
      ),
    /**
     * Change a source's configuration under the app's lock, only while it is still the source the
     * caller authorized: same identity, actor and revision, and not being removed.
     */
    configureSource: (input: typeof UpdateWebhookSource.Type) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          const parsed = yield* Schema.decodeUnknownEffect(UpdateWebhookSource)(input).pipe(
            Effect.mapError(() => new RequestInvalid()),
          );
          yield* lockApp(tx, parsed);
          const existing = yield* find(parsed);
          if (
            existing === undefined ||
            existing.status === "removing" ||
            existing.id !== parsed.expected.id ||
            existing.actor !== parsed.expected.actor ||
            existing.revision !== parsed.expected.revision
          )
            return yield* new WebhookConflict();
          yield* query(() =>
            tx.updateMany("webhookSources", {
              where: (b) => b("id", "=", existing.id),
              set: {
                accounts: {},
                config: parsed.config,
                status: "pending",
                failure: null,
                retries: 0,
                revision: existing.revision + 1,
              },
            }),
          );
          const saved = yield* find(parsed);
          if (saved === undefined) return yield* new StorageError();
          return yield* view(saved);
        }),
      ),
    unlink: (input: typeof UnlinkWebhookSource.Type) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          yield* lockApp(tx, input);
          const existing = yield* find(input);
          if (existing === undefined) return yield* new WebhookNotFound();
          // New removal intent runs at once, as new link intent does: it does not wait out the
          // retry delay a failed or waiting source left in `leaseUntil`. An attempt in progress
          // keeps its lease, and sees the new revision when it completes.
          const fields = {
            status: "removing" as const,
            failure: null,
            retries: 0,
            revision: existing.revision + 1,
            ...(existing.status !== "removing" && existing.lease === null
              ? { leaseUntil: new Date(0) }
              : {}),
          };
          yield* query(() =>
            tx.updateMany("webhookSources", {
              where: (b) => b("id", "=", existing.id),
              set: fields,
            }),
          );
          return yield* view({ ...existing, ...fields });
        }),
      ),
    tick: (limit: number) =>
      Effect.gen(function* () {
        const time = new Date(yield* now);
        // New saved intent runs immediately, ahead of retries: a backlog of failed or waiting
        // sources never delays one someone just changed.
        const intent = yield* query(() =>
          db.findMany("webhookSources", {
            where: (b) => b.and(b("status", "=", "pending"), b("lease", "is", null)),
            orderBy: ["leaseUntil", "asc"],
            limit,
          }),
        ).pipe(
          Effect.flatMap((rows) =>
            Schema.decodeUnknownEffect(Schema.Array(StoredSource))(rows).pipe(
              Effect.mapError(() => new StorageError()),
            ),
          ),
        );
        // An active worker keeps its lease; failed unchanged intent keeps its retry delay.
        const retries =
          intent.length >= limit
            ? []
            : yield* query(() =>
                db.findMany("webhookSources", {
                  where: (b) =>
                    b.and(
                      b("status", "!=", "ready"),
                      b("leaseUntil", "<=", time),
                      b.or(b("status", "!=", "pending"), b("lease", "is not", null)),
                    ),
                  orderBy: ["leaseUntil", "asc"],
                  limit: limit - intent.length,
                }),
              ).pipe(
                Effect.flatMap((rows) =>
                  Schema.decodeUnknownEffect(Schema.Array(StoredSource))(rows).pipe(
                    Effect.mapError(() => new StorageError()),
                  ),
                ),
              );
        // A source that failed on its accounts cannot succeed while one must reconnect or a
        // requirement needs a choice. Wait instead, checking stored state once per retry delay,
        // which doubles with each check that finds it still waiting. New credentials for the
        // source's account (`resumeWaitingSources`) and linking again end the wait at once.
        const ready = yield* Effect.filter(retries, (row) =>
          row.failure !== "accounts" || row.lease !== null
            ? Effect.succeed(true)
            : waiting(row).pipe(
                Effect.flatMap((wait) =>
                  !wait
                    ? Effect.succeed(true)
                    : query(() =>
                        db.updateMany("webhookSources", {
                          where: (b) =>
                            b.and(
                              b("id", "=", row.id),
                              b("lease", "is", null),
                              b("leaseUntil", "=", row.leaseUntil),
                            ),
                          set: {
                            leaseUntil: new Date(time.getTime() + retryDelay(row.retries + 1)),
                            retries: row.retries + 1,
                          },
                        }),
                      ).pipe(Effect.as(false)),
                ),
              ),
        );
        const reconciled = yield* Effect.forEach(
          [...intent, ...ready],
          (row) =>
            reconcile({ app: row.app, account: row.account }, true).pipe(
              Effect.as(true),
              Effect.catch(() =>
                Effect.logError("Webhook source reconciliation failed").pipe(Effect.as(false)),
              ),
            ),
          { concurrency: 4 },
        );
        // A full batch of saved intent may have left more behind. Continue while it makes
        // progress; a batch whose intent all failed waits for the host's next wake.
        return intent.length >= limit && reconciled.slice(0, intent.length).some(Boolean);
      }),
  };
};
