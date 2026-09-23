import type { ResourceLifecycle } from "../contracts/executor.ts";
import type { WorkflowHostControls } from "apps/contracts";
import type { AppDatabases } from "@executor-js/app-data";
import { bindAppStorage } from "./app-database.ts";
import { CompleteWebhookSetup, WebhookSetupView } from "../contracts/webhook-setup.ts";
/** Persist intent before upstream work. Explicit reconciliation uses a bounded, compare-and-swap lease. */
import { Clock, type Crypto, Effect, Redacted, Result, Schema } from "effect";
import {
  ManualWebhookDescriptor,
  HostedWebhook,
  WebhookResponseData,
  type WebhookCommand,
} from "apps/contracts";
import {
  defaultWebhookLifecycleLimits,
  CreateWebhook,
  WebhookTarget,
  DeliverWebhook,
  WebhookSubscription,
  WebhookApp,
  WebhookNotFound,
  WebhookConflict,
  WebhookFailed,
} from "../contracts/webhooks.ts";
import { AppId, WebhookId, StorageError, RequestInvalid } from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import type { Runtime } from "../contracts/runtime.ts";
import type { ExecutorDatabase } from "./storage.ts";
import type { makeOAuth } from "./oauth.ts";
import { database, query, transaction } from "./database.ts";
import { snapshot, resolve } from "./tools.ts";
import { storedProfile } from "./profiles.ts";
import { storedAccount } from "./accounts.ts";
import { storedApp } from "./apps.ts";

const StoredWebhook = Schema.Struct({
  ...WebhookSubscription.fields,
  encrypted: Schema.RedactedFromValue(Schema.Uint8Array),
  revision: Schema.String,
  leaseUntil: Schema.Date,
});
const PrivateState = Schema.Struct({
  config: Schema.Json,
  secret: Schema.String,
  state: Schema.Json,
  setup: Schema.optional(ManualWebhookDescriptor),
});

/** The host owns origin and authority. Each subscription pins code/account IDs while resolving current credentials. */
export const makeWebhooks = (
  storage: ExecutorDatabase,
  runtime: Runtime,
  resolveAccount: ReturnType<typeof makeOAuth>["resolve"],
  credentials: Credentials,
  crypto: Crypto.Crypto,
  origin?: string,
  appStorage?: AppDatabases,
  workflows?: (
    app: AppId,
    state?: Effect.Success<ReturnType<typeof snapshot>>,
  ) => WorkflowHostControls,
  lifecycle?: ResourceLifecycle,
) => {
  const db = database(storage);
  const next = crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()));
  const metadata = (row: typeof StoredWebhook.Type) =>
    Schema.decodeUnknownEffect(WebhookSubscription)(row).pipe(
      Effect.mapError(() => new StorageError()),
    );
  const read = (input: { app: AppId; subscription: WebhookId }) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("webhooks", {
          where: (b) => b.and(b("id", "=", input.subscription), b("app", "=", input.app)),
        }),
      );
      if (row === null) return yield* new WebhookNotFound();
      return yield* Schema.decodeUnknownEffect(StoredWebhook)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
    });
  const decrypt = (row: typeof StoredWebhook.Type) =>
    credentials.decrypt(row.id, row.encrypted).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(PrivateState)(Redacted.value(value))),
      Effect.mapError(() => new StorageError()),
    );
  const invoke = (row: typeof StoredWebhook.Type, command: WebhookCommand) =>
    Effect.gen(function* () {
      const state = yield* snapshot(
        db,
        { app: row.app, deployment: row.deployment, profile: row.profile ?? undefined },
        row.accounts,
        row.profileRevision ?? undefined,
        command.operation === "webhook-unregister",
      );
      const context = yield* resolve(state, resolveAccount, lifecycle);
      return yield* runtime
        .webhook({
          app: row.app,
          build: state.deployment.build,
          database: state.deployment.requirements.database !== undefined,
          ...context,
          ...(yield* bindAppStorage(appStorage, row.app)),
          ...(workflows === undefined ? {} : { workflowControls: workflows(row.app, state) }),
          command,
        })
        .pipe(
          Effect.mapError(
            () =>
              new WebhookFailed({
                reason: command.operation === "webhook-handle" ? "delivery" : "definition",
              }),
          ),
        );
    });
  const definitions = (input: typeof WebhookApp.Type) =>
    Effect.gen(function* () {
      const state = yield* snapshot(db, input);
      const context = yield* resolve(state, resolveAccount, lifecycle);
      return yield* runtime
        .webhook({
          app: input.app,
          build: state.deployment.build,
          database: state.deployment.requirements.database !== undefined,
          ...context,
          command: { operation: "webhooks" },
        })
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(HostedWebhook))),
          Effect.mapError(() => new WebhookFailed({ reason: "definition" })),
        );
    });
  const outsideTransaction = storage.reactivity.inTransaction.pipe(
    Effect.flatMap((inside) => (inside ? Effect.fail(new RequestInvalid()) : Effect.void)),
  );
  const reconcile = (input: typeof WebhookTarget.Type, remove = false) =>
    Effect.gen(function* () {
      yield* outsideTransaction;
      const parsed = yield* Schema.decodeUnknownEffect(WebhookTarget)(input).pipe(
        Effect.mapError(() => new RequestInvalid()),
      );
      const claim = yield* next;
      const row = yield* transaction(db, () =>
        Effect.gen(function* () {
          const row = yield* read(parsed);
          if (
            row.status === "stopped" ||
            (!remove && ["active", "setup-required", "disabled"].includes(row.status))
          )
            return row;
          const manual = remove && (yield* decrypt(row)).setup !== undefined;
          const now = yield* Clock.currentTimeMillis;
          if (row.leaseUntil.getTime() > now) return yield* new WebhookConflict();
          yield* query(() =>
            db.updateMany("webhooks", {
              where: (b) => b.and(b("id", "=", row.id), b("revision", "=", row.revision)),
              set: {
                revision: claim,
                leaseUntil: new Date(manual ? 0 : now + defaultWebhookLifecycleLimits.leaseMs),
                ...(remove ? { status: manual ? "disabled" : "stopping" } : {}),
              },
            }),
          );
          const claimed = yield* read(parsed);
          if (claimed.revision !== claim) return yield* new WebhookConflict();
          return claimed;
        }),
      );
      if (row.revision !== claim || row.status === "disabled") return yield* metadata(row);
      const stopping = row.status === "stopping";
      // The intent/lease commits before network I/O. A lost response leaves recoverable state.
      const work = Effect.gen(function* () {
        const saved = yield* decrypt(row);
        const common = {
          name: row.name,
          config: saved.config,
          secret: saved.secret,
          callbackUrl: row.callbackUrl,
          subscriptionId: row.id,
          sourceAccount: row.sourceAccount,
        };
        const value = yield* invoke(
          row,
          stopping
            ? { operation: "webhook-unregister", ...common, state: saved.state }
            : { operation: "webhook-register", ...common },
        );
        return yield* credentials.encrypt(
          row.id,
          Redacted.make({
            config: saved.config,
            secret: saved.secret,
            state: stopping ? null : value,
          }),
        );
      }).pipe(Effect.timeout(defaultWebhookLifecycleLimits.lifecycleTimeoutMs), Effect.result);
      const result = yield* work;
      yield* transaction(db, () =>
        Effect.gen(function* () {
          yield* query(() =>
            db.updateMany("webhooks", {
              where: (b) => b.and(b("id", "=", row.id), b("revision", "=", claim)),
              set: {
                leaseUntil: new Date(0),
                failure: Result.isFailure(result) ? (stopping ? "unregister" : "register") : null,
                ...(Result.isSuccess(result)
                  ? { status: stopping ? "stopped" : "active", encrypted: result.success }
                  : {}),
              },
            }),
          );
          const current = yield* read(parsed);
          if (current.revision === claim && current.status === "stopped")
            yield* query(() =>
              db.deleteMany("webhookAccounts", { where: (b) => b("subscription", "=", row.id) }),
            );
        }),
      );
      return yield* read(parsed).pipe(Effect.flatMap(metadata));
    }).pipe(Effect.withSpan("sdk.webhooks.reconcile"));
  const webhooks = {
    get: (input: typeof WebhookTarget.Type) => read(input).pipe(Effect.flatMap(metadata)),
    confirmRemoval: (input: typeof WebhookTarget.Type) =>
      transaction(db, () =>
        Effect.gen(function* () {
          const row = yield* read(input);
          if (row.status === "stopped") return yield* metadata(row);
          if (row.status !== "disabled" || (yield* decrypt(row)).setup === undefined)
            return yield* new WebhookConflict();
          const revision = yield* next;
          yield* query(() =>
            db.updateMany("webhooks", {
              where: (b) => b.and(b("id", "=", row.id), b("revision", "=", row.revision)),
              set: { status: "stopped", revision },
            }),
          );
          const current = yield* read(input);
          if (current.revision !== revision) return yield* new WebhookConflict();
          yield* query(() =>
            db.deleteMany("webhookAccounts", { where: (b) => b("subscription", "=", row.id) }),
          );
          return yield* metadata(current);
        }),
      ),
    definitions,
    list: (input: typeof WebhookApp.Type) =>
      Effect.gen(function* () {
        yield* storedApp(db, input);
        const rows = yield* query(() =>
          db.findMany("webhooks", {
            where: (b) =>
              b.and(
                b("app", "=", input.app),
                input.profile === undefined ? true : b("profile", "=", input.profile),
              ),
            orderBy: ["id", "asc"],
          }),
        );
        return yield* Schema.decodeUnknownEffect(Schema.Array(WebhookSubscription))(rows).pipe(
          Effect.mapError(() => new StorageError()),
        );
      }),
    create: (input: typeof CreateWebhook.Type) =>
      Effect.gen(function* () {
        yield* outsideTransaction;
        const parsed = yield* Schema.decodeUnknownEffect(CreateWebhook)(input).pipe(
          Effect.mapError(() => new RequestInvalid()),
        );
        if (origin === undefined) return yield* new WebhookFailed({ reason: "unavailable" });
        const base = yield* Effect.try(() => new URL(origin)).pipe(
          Effect.mapError(() => new WebhookFailed({ reason: "unavailable" })),
        );
        if (
          !["https:", "http:"].includes(base.protocol) ||
          base.username ||
          base.password ||
          base.pathname !== "/" ||
          base.search ||
          base.hash
        )
          return yield* new WebhookFailed({ reason: "unavailable" });
        const state = yield* snapshot(db, parsed);
        const context = yield* resolve(state, resolveAccount, lifecycle);
        const catalog = yield* runtime
          .webhook({
            app: parsed.app,
            build: state.deployment.build,
            database: state.deployment.requirements.database !== undefined,
            ...context,
            command: { operation: "webhooks" },
          })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(HostedWebhook))),
            Effect.mapError(() => new WebhookFailed({ reason: "definition" })),
          );
        const hook = catalog.find((hook) => hook.name === parsed.name);
        if (hook === undefined) return yield* new WebhookFailed({ reason: "definition" });
        const selected = state.accounts[hook.account];
        const sourceAccount =
          parsed.sourceAccount ?? (typeof selected === "string" ? selected : undefined);
        if (
          sourceAccount === undefined ||
          !(typeof selected === "string"
            ? selected === sourceAccount
            : selected?.includes(sourceAccount))
        )
          return yield* new WebhookFailed({ reason: "input" });
        const id = WebhookId.make(`whk_${yield* next}`);
        const callbackUrl = new URL(`/api/webhooks/${parsed.app}/${id}`, base).href;
        const secret = `${yield* next}${yield* next}`;
        const config = yield* runtime
          .webhook({
            app: parsed.app,
            build: state.deployment.build,
            database: state.deployment.requirements.database !== undefined,
            ...context,
            command: {
              operation: "webhook-validate",
              name: parsed.name,
              config: parsed.config,
              secret,
              callbackUrl,
              subscriptionId: id,
              sourceAccount,
            },
          })
          .pipe(Effect.mapError(() => new WebhookFailed({ reason: "input" })));
        const encrypted = yield* credentials.encrypt(
          id,
          Redacted.make({
            config,
            secret,
            state: null,
            ...(hook.setup === undefined ? {} : { setup: hook.setup }),
          }),
        );
        const revision = yield* next;
        const createdAt = new Date(yield* Clock.currentTimeMillis);
        const target = yield* transaction(db, () =>
          Effect.gen(function* () {
            // Serializes creation and app deletion without holding a lock across provider I/O.
            yield* query(() =>
              db.updateMany("apps", {
                where: (b) => b("id", "=", state.app.id),
                set: { createdAt: state.app.createdAt },
              }),
            );
            if (state.profile !== undefined) {
              const profile = yield* storedProfile(db, {
                app: state.app.id,
                profile: state.profile.id,
              });
              if (
                !profile.enabled ||
                profile.revision !== state.profile.revision ||
                profile.status === "removing" ||
                profile.status === "removed"
              )
                return yield* new WebhookConflict();
            }
            const current = yield* storedApp(db, { app: state.app.id });
            if (current.activeDeployment !== state.app.activeDeployment)
              return yield* new WebhookConflict();
            const existing = yield* query(() =>
              db.findFirst("webhooks", {
                where: (b) =>
                  b.and(
                    b("app", "=", parsed.app),
                    b("key", "=", parsed.key),
                    parsed.profile === undefined
                      ? b("profile", "is", null)
                      : b("profile", "=", parsed.profile),
                  ),
              }),
            );
            if (existing !== null) {
              const row = yield* read({ app: parsed.app, subscription: existing.id });
              const saved = yield* decrypt(row);
              if (
                row.name !== parsed.name ||
                row.sourceAccount !== sourceAccount ||
                !Schema.toEquivalence(Schema.Json)(saved.config, config)
              )
                return yield* new WebhookConflict();
              return row.id;
            }
            const accountIds = [
              ...new Set(
                Object.values(state.accounts).flatMap((selected) =>
                  typeof selected === "string" ? [selected] : [...selected],
                ),
              ),
            ].sort();
            for (const account of accountIds) {
              const currentAccount = yield* storedAccount(db, account);
              yield* query(() =>
                db.updateMany("accounts", {
                  where: (b) => b("id", "=", account),
                  set: { createdAt: currentAccount.createdAt },
                }),
              );
              yield* storedAccount(db, account);
            }
            yield* query(() =>
              db.create("webhooks", {
                id,
                app: parsed.app,
                owner: state.app.owner,
                profile: parsed.profile ?? null,
                profileRevision: state.profile?.revision ?? null,
                key: parsed.key,
                deployment: state.deployment.id,
                name: parsed.name,
                sourceAccount,
                callbackUrl,
                accounts: state.accounts,
                status: hook.setup === undefined ? "pending" : "setup-required",
                revision,
                leaseUntil: new Date(0),
                failure: null,
                encrypted,
                createdAt,
              }),
            );
            for (const account of accountIds)
              yield* query(() =>
                db.create("webhookAccounts", { id: `${id}/${account}`, account, subscription: id }),
              );
            return id;
          }),
        );
        return yield* reconcile({ app: parsed.app, subscription: target });
      }).pipe(Effect.withSpan("sdk.webhooks.create")),
    reconcile: (input: typeof WebhookTarget.Type) => reconcile(input),
    remove: (input: typeof WebhookTarget.Type) => reconcile(input, true),
    deliver: (input: typeof DeliverWebhook.Type) =>
      Effect.gen(function* () {
        yield* outsideTransaction;
        const parsed = yield* Schema.decodeUnknownEffect(DeliverWebhook)(input).pipe(
          Effect.mapError(() => new RequestInvalid()),
        );
        const row = yield* read(parsed);
        if (row.status === "stopping" || row.status === "disabled" || row.status === "stopped")
          return yield* new WebhookFailed({ reason: "inactive" });
        if (row.profile !== null) {
          const profile = yield* storedProfile(db, {
            app: row.app,
            profile: row.profile,
          });
          if (
            !profile.enabled ||
            profile.status === "removing" ||
            profile.status === "removed" ||
            profile.revision !== row.profileRevision
          )
            return yield* new WebhookFailed({ reason: "inactive" });
        }
        const saved = yield* decrypt(row);
        const url = new URL(row.callbackUrl);
        url.search = new URL(parsed.request.url).search;
        const value = yield* invoke(row, {
          operation: "webhook-handle",
          name: row.name,
          subscriptionId: row.id,
          sourceAccount: row.sourceAccount,
          config: saved.config,
          state: saved.state,
          secret: saved.secret,
          callbackUrl: row.callbackUrl,
          request: { ...parsed.request, url: url.href },
        });
        return yield* Schema.decodeUnknownEffect(WebhookResponseData)(value).pipe(
          Effect.mapError(() => new WebhookFailed({ reason: "delivery" })),
        );
      }).pipe(
        Effect.timeout(defaultWebhookLifecycleLimits.deliveryTimeoutMs),
        Effect.catchTag("TimeoutError", () => new WebhookFailed({ reason: "delivery" })),
        Effect.withSpan("sdk.webhooks.deliver"),
      ),
  };
  return {
    webhooks,
    webhookSetup: {
      read: (input: typeof WebhookTarget.Type) =>
        Effect.gen(function* () {
          const row = yield* read(input);
          const saved = yield* decrypt(row);
          if (saved.setup === undefined) return yield* new WebhookFailed({ reason: "input" });
          const subscription = yield* metadata(row);
          return yield* Schema.decodeUnknownEffect(Schema.toType(WebhookSetupView))(
            row.status === "setup-required"
              ? {
                  step: "configure",
                  subscription,
                  revision: row.revision,
                  instructions: saved.setup.instructions,
                  stateSchema: saved.setup.stateSchema,
                  signingSecret:
                    saved.setup.signingSecret === "executor"
                      ? { source: "executor", value: Redacted.make(saved.secret) }
                      : { source: "provider" },
                }
              : row.status === "disabled"
                ? { step: "remove", subscription, instructions: saved.setup.instructions }
                : { step: "done", subscription },
          ).pipe(Effect.mapError(() => new StorageError()));
        }),
      complete: (input: typeof CompleteWebhookSetup.Type) =>
        Effect.gen(function* () {
          yield* outsideTransaction;
          const parsed = yield* Schema.decodeUnknownEffect(Schema.toType(CompleteWebhookSetup))(
            input,
          ).pipe(Effect.mapError(() => new RequestInvalid()));
          const row = yield* read(parsed);
          const saved = yield* decrypt(row);
          if (saved.setup === undefined) return yield* new WebhookFailed({ reason: "input" });
          if (row.status === "active") return yield* metadata(row);
          if (row.status !== "setup-required" || row.revision !== parsed.revision)
            return yield* new WebhookConflict();
          if (saved.setup.signingSecret === "provider" && parsed.secret === undefined)
            return yield* new WebhookFailed({ reason: "input" });
          if (saved.setup.signingSecret === "executor" && parsed.secret !== undefined)
            return yield* new WebhookFailed({ reason: "input" });
          const secret = parsed.secret === undefined ? saved.secret : Redacted.value(parsed.secret);
          const state = yield* invoke(row, {
            operation: "webhook-complete",
            name: row.name,
            config: saved.config,
            subscriptionId: row.id,
            sourceAccount: row.sourceAccount,
            callbackUrl: row.callbackUrl,
            secret,
            state: Redacted.value(parsed.state),
          });
          const encrypted = yield* credentials.encrypt(
            row.id,
            Redacted.make({ config: saved.config, secret, state, setup: saved.setup }),
          );
          const revision = yield* next;
          return yield* transaction(db, () =>
            Effect.gen(function* () {
              yield* query(() =>
                db.updateMany("webhooks", {
                  where: (b) =>
                    b.and(
                      b("id", "=", row.id),
                      b("revision", "=", row.revision),
                      b("status", "=", "setup-required"),
                    ),
                  set: { status: "active", encrypted, revision },
                }),
              );
              const current = yield* read(parsed);
              if (current.revision !== revision) return yield* new WebhookConflict();
              return yield* metadata(current);
            }),
          );
        }),
    },
  };
};
