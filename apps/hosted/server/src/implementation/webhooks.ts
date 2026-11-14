import { OrganizationForbidden } from "../contracts/organization.ts";
/** Shared product policy; local does not acquire organizations to reuse webhook execution. */
import { SessionAuthentication, BearerAuthentication, CurrentUserId } from "../contracts/auth.ts";
import { HttpServerResponse } from "effect/http";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { permitsAction, permitsApp } from "@executor-js/authorization";
import {
  AccountWebhooksActive,
  WebhookNotFound,
  webhookCallback,
  type Executor,
  type AccountId,
  type AppId,
  type OwnerId,
  type StorageError,
  type WebhookSource,
  type WebhookSubscription,
} from "@executor-js/sdk/core";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { CurrentPolicy } from "../contracts/authorization.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import {
  actorManagerOwner,
  appReaderOwner,
  checkAccounts,
  currentOrganizationSlug,
  currentOwner,
  selectedApp,
  usableApp,
} from "./access.ts";

/** Public callback authentication belongs to the selected app's signature verifier. */
export const hostedWebhookCallback = Effect.flatMap(
  Effect.flatten(HostedExecutor),
  webhookCallback,
).pipe(
  Effect.catchTag("StorageError", () => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
);
/**
 * A member's subscription's source account must still be usable by the caller. An app-account
 * subscription has no actor: its source is an app link, which the app's managers manage
 * without use of the account.
 */
const checkSubscriptionAccounts = (owner: OwnerId, subscription: WebhookSubscription) =>
  subscription.actor === null
    ? Effect.void
    : checkAccounts(owner, { source: subscription.sourceAccount });
/** `list` shows a subscription to its actor or an app manager while they can use its accounts. */
const listed = (owner: OwnerId, app: AppId, subscription: WebhookSubscription) =>
  Effect.gen(function* () {
    yield* actorManagerOwner(app, subscription.actor);
    yield* checkSubscriptionAccounts(owner, subscription);
  }).pipe(
    Effect.as(true),
    Effect.catchTags({
      OrganizationForbidden: () => Effect.succeed(false),
      AccountNotFound: () => Effect.succeed(false),
    }),
  );
const failedToRead = <E extends { readonly _tag: string }>(
  error: E,
): error is Exclude<E, StorageError> => error._tag !== "StorageError";
/**
 * The app's subscriptions `list` shows the caller: none unless their API token and access let
 * them read the app. A read refused for any reason but storage shows none.
 */
const listedIn = (executor: Executor, owner: OwnerId, app: AppId) =>
  Effect.gen(function* () {
    const policy = yield* CurrentPolicy;
    if (!permitsAction(policy, "read") || !permitsApp(policy, app)) return [];
    yield* appReaderOwner(app);
    yield* executor.apps.get({ owner, app });
    const subscriptions = yield* executor.webhooks.list({ app });
    return yield* Effect.filter(subscriptions, (subscription) => listed(owner, app, subscription));
  }).pipe(Effect.catchIf(failedToRead, () => Effect.succeed([])));
/**
 * Every subscription holding an account refuses its deletion, but the refusal names only those
 * `list` shows the caller and counts the rest, so it never reveals an app or subscription they
 * cannot read.
 */
export const visibleAccountRefusal = (executor: Executor, refusal: AccountWebhooksActive) =>
  Effect.gen(function* () {
    if (refusal.dependents === undefined) return refusal;
    const owner = yield* currentOwner;
    const holders = refusal.dependents.visible;
    const apps = [...new Set(holders.map((holder) => holder.app))];
    const shown = new Set(
      (yield* Effect.forEach(apps, (app) =>
        Effect.map(listedIn(executor, owner, app), (subscriptions) =>
          subscriptions.map((subscription) => `${app}/${subscription.id}`),
        ),
      )).flat(),
    );
    const visible = holders.filter((holder) => shown.has(`${holder.app}/${holder.subscription}`));
    return new AccountWebhooksActive({
      account: refusal.account,
      dependents: { visible, hidden: refusal.dependents.hidden + holders.length - visible.length },
    });
  });
/** A subscription's actor, or an app manager, may change it once its accounts pass. */
const managedSubscription = (
  executor: Executor,
  params: Parameters<Executor["webhooks"]["get"]>[0],
) =>
  Effect.gen(function* () {
    const subscription = yield* executor.webhooks.get(params);
    const owner = yield* actorManagerOwner(params.app, subscription.actor);
    yield* executor.apps.get({ owner, app: params.app });
    yield* checkSubscriptionAccounts(owner, subscription);
    return subscription;
  });
/**
 * A webhook source's actor, or an app manager, may see and change it while they can use its
 * account. An app link's source has no actor; the app's managers manage it.
 */
const visibleSource = (owner: OwnerId, app: AppId, source: WebhookSource) =>
  Effect.gen(function* () {
    yield* actorManagerOwner(app, source.actor);
    if (source.actor !== null) yield* checkAccounts(owner, { source: source.account });
  });
const managedSource = (executor: Executor, input: { app: AppId; account: AccountId }) =>
  Effect.gen(function* () {
    const owner = yield* currentOwner;
    yield* executor.apps.get({ owner, app: input.app });
    const source = (yield* executor.webhooks.sources({ app: input.app })).find(
      (item) => item.account === input.account,
    );
    if (source === undefined || source.status === "removing") return yield* new WebhookNotFound();
    yield* visibleSource(owner, input.app, source);
    return source;
  });
/** Management uses current organization authority before any app code runs. */
export const hostedWebhookHandlers = HttpApiBuilder.group(HostedApi, "webhooks", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* SessionAuthentication;
    const api = yield* BearerAuthentication;
    return (
      handlers
        .handle("get", ({ params }) =>
          Effect.gen(function* () {
            yield* appReaderOwner(params.app);
            return yield* managedSubscription(yield* Effect.flatten(HostedExecutor), params);
          }),
        )
        .handle("confirmRemoval", ({ params }) =>
          Effect.gen(function* () {
            const executor = yield* Effect.flatten(HostedExecutor);
            const saved = yield* executor.webhooks.get(params);
            const owner = yield* actorManagerOwner(params.app, saved.actor);
            yield* executor.apps.get({ owner, app: params.app });
            return yield* executor.webhooks.confirmRemoval(params);
          }),
        )
        .handle("setupLink", ({ params }) =>
          Effect.gen(function* () {
            const executor = yield* Effect.flatten(HostedExecutor);
            yield* managedSubscription(executor, params);
            yield* executor.webhookSetup.read(params);
            const slug = yield* currentOrganizationSlug(auth, api);
            return {
              url: `${auth.origin}/org/${encodeURIComponent(slug)}/webhooks/${encodeURIComponent(params.app)}/${encodeURIComponent(params.subscription)}`,
            };
          }),
        )
        .handle("definitions", ({ params }) =>
          Effect.gen(function* () {
            const owner = yield* appReaderOwner(params.app);
            const executor = yield* Effect.flatten(HostedExecutor);
            const { accounts } = yield* selectedApp(executor, owner, params.app);
            return yield* executor.webhooks.definitions({ ...params, accounts });
          }),
        )
        .handle("list", ({ params }) =>
          Effect.gen(function* () {
            const owner = yield* appReaderOwner(params.app);
            const executor = yield* Effect.flatten(HostedExecutor);
            yield* executor.apps.get({ owner, app: params.app });
            const subscriptions = yield* executor.webhooks.list(params);
            return yield* Effect.filter(subscriptions, (subscription) =>
              listed(owner, params.app, subscription),
            );
          }),
        )
        .handle("create", ({ params, payload }) =>
          Effect.gen(function* () {
            const executor = yield* Effect.flatten(HostedExecutor);
            const actor = yield* CurrentUserId;
            if (actor === undefined) return yield* new OrganizationForbidden();
            const owner = yield* currentOwner;
            yield* usableApp(executor, owner, params.app);
            yield* checkAccounts(owner, { source: payload.sourceAccount });
            return yield* executor.webhooks.create({ ...params, ...payload, actor });
          }),
        )
        .handle("reconcile", ({ params }) =>
          Effect.gen(function* () {
            const executor = yield* Effect.flatten(HostedExecutor);
            yield* managedSubscription(executor, params);
            return yield* executor.webhooks.reconcile(params);
          }),
        )
        .handle("remove", ({ params }) =>
          Effect.gen(function* () {
            const executor = yield* Effect.flatten(HostedExecutor);
            yield* managedSubscription(executor, params);
            return yield* executor.webhooks.remove(params);
          }),
        )
        .handle("sources", ({ params }) =>
          Effect.gen(function* () {
            const owner = yield* appReaderOwner(params.app);
            const executor = yield* Effect.flatten(HostedExecutor);
            yield* executor.apps.get({ owner, app: params.app });
            const sources = yield* executor.webhooks.sources(params);
            return yield* Effect.filter(sources, (source) =>
              visibleSource(owner, params.app, source).pipe(
                Effect.as(source.status !== "removing"),
                Effect.catchTags({
                  OrganizationForbidden: () => Effect.succeed(false),
                  AccountNotFound: () => Effect.succeed(false),
                }),
              ),
            );
          }),
        )
        // The source keeps its actor; it or an app manager may change the configuration.
        .handle("configureSource", ({ params, payload }) =>
          Effect.gen(function* () {
            const executor = yield* Effect.flatten(HostedExecutor);
            const source = yield* managedSource(executor, params);
            // Saved only while the source is still the one authorized above.
            const saved = yield* executor.webhooks.configureSource({
              app: params.app,
              account: params.account,
              expected: { id: source.id, actor: source.actor, revision: source.revision },
              ...payload,
            });
            // The saved intent re-registers the source's subscriptions in the background.
            yield* Effect.flatten(ScheduleWakeup);
            return saved;
          }),
        )
    );
  }),
);
