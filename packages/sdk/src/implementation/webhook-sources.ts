import { AppProviderFailed } from "../contracts/tools.ts";
import { Clock, Effect, Exit, Result, Schema } from "effect";
import type { HostCrypto } from "./host-crypto.ts";
import { Digest } from "effect/crypto";
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
}).pipe(Schema.encodeKeys({ reconciledVersion: "reconciledDeployment" }));
type StoredSource = typeof StoredSource.Type;

const retryDelay = (retries: number) => Math.min(30_000 * 2 ** (retries - 1), 3_600_000);

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
    const joining =
      row.lease === null ? { leaseUntil: new Date(yield* Clock.currentTimeMillis) } : {};
    yield* query(() =>
      tx.updateMany("webhookSources", {
        where: (b) => b("id", "=", row.id),
        set: {
          status: "pending",
          failure: null,
          retries: 0,
          revision: row.revision + 1,
          ...joining,
        },
      }),
    );
  });

export const makeWebhookSources = (
  db: Query,
  crypto: HostCrypto,
  lifecycle: ResourceLifecycle | undefined,
  resources: {
    readonly webhooks: ReturnType<typeof makeWebhooks>["webhooks"];
    readonly liveDefinitions: ReturnType<typeof makeWebhooks>["liveDefinitions"];
    readonly retarget: ReturnType<typeof makeWebhooks>["retarget"];
    readonly createManaged: ReturnType<typeof makeWebhooks>["createManaged"];
    readonly removeManaged: ReturnType<typeof makeWebhooks>["removeManaged"];
    readonly accountNeedingReconnect: ReturnType<typeof makeTools>["accountNeedingReconnect"];
  },
) => {
  const now = Clock.currentTimeMillis;
  const instance = globalThis.crypto.randomUUID();
  const queued = (source: { readonly lease: string | null }) =>
    Effect.map(now, (time): { readonly leaseUntil?: Date } =>
      source.lease === null ? { leaseUntil: new Date(time) } : {},
    );
  const keyFor = (value: Json) =>
    crypto.digest
      .digest(Digest.sha256, new TextEncoder().encode(canonical(value)))
      .pipe(
        Effect.map(
          (bytes) =>
            `setup-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
        ),
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
  const accountsOf = (source: StoredSource) =>
    backgroundAccounts(db, lifecycle, {
      app: source.app,
      actor: source.actor ?? undefined,
      source: source.account,
    });
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
      const token = yield* crypto.random.uuidV4();
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
                const kept = hooks.find(
                  (saved) =>
                    saved.key === key &&
                    saved.version === version &&
                    (saved.status === "active" ||
                      saved.status === "pending" ||
                      saved.status === "setup-required"),
                );
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
                const changed =
                  live.revision !== current.revision ||
                  liveApp.activatedSequence !== app.activatedSequence;
                const completedAt = yield* now;
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
                  yield* lockApp(tx, { app: input.app });
                  const queuedAt = new Date(yield* now);
                  yield* query(() =>
                    tx.updateMany("webhookSources", {
                      where: (b) =>
                        b.and(
                          b("app", "=", input.app),
                          b("account", "=", input.account),
                          b("lease", "=", token),
                        ),
                      set: { lease: null, leaseUntil: queuedAt },
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
      }).pipe(
        Effect.withSpan("sdk.webhooks.sources", {
          attributes: { "executor.webhooks.instance": instance },
        }),
      ),
    link: (input: typeof LinkWebhookSource.Type) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          const parsed = yield* Schema.decodeUnknownEffect(LinkWebhookSource)(input).pipe(
            Effect.mapError(() => new RequestInvalid()),
          );
          const app = yield* lockApp(tx, parsed);
          yield* storedAccount(tx, parsed.account);
          const existing = yield* find(parsed);
          const config =
            parsed.config !== undefined
              ? parsed.config
              : existing === undefined
                ? {}
                : existing.config;
          const fields = {
            actor: parsed.actor ?? null,
            accounts: {},
            config,
            status: "pending" as const,
            failure: null,
            retries: 0,
          };
          if (existing === undefined) {
            const id = `src_${yield* crypto.random.uuidV4()}`;
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
                leaseUntil: createdAt,
                createdAt,
              }),
            );
          } else {
            const joining = yield* queued(existing);
            yield* query(() =>
              tx.updateMany("webhookSources", {
                where: (b) => b("id", "=", existing.id),
                set: { ...fields, revision: existing.revision + 1, ...joining },
              }),
            );
          }
          const saved = yield* find(parsed);
          if (saved === undefined) return yield* new StorageError();
          return yield* view(saved);
        }),
      ),
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
          const joining = yield* queued(existing);
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
                ...joining,
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
        yield* Effect.annotateCurrentSpan({
          "executor.webhooks.instance": instance,
          "executor.webhooks.sweep.limit": limit,
          "executor.webhooks.sweep.taken": intent.length,
          "executor.webhooks.sweep.retries": ready.length,
        });
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
        return intent.length >= limit && reconciled.slice(0, intent.length).some(Boolean);
      }).pipe(Effect.withSpan("sdk.webhooks.sweep")),
  };
};
