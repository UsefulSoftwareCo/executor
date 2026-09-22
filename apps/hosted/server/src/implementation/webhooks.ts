import { CurrentOrganization } from "../contracts/organization.ts";
/** Shared product policy; local does not acquire organizations to reuse webhook execution. */
import { Authentication, ApiAuthentication } from "../contracts/auth.ts";
import { HttpServerRequest } from "effect/unstable/http";
import { HttpServerResponse } from "effect/unstable/http";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { webhookCallback } from "@executor-js/sdk/core";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import {
  executionManagerOwner,
  ownProfile,
  appReaderOwner,
  selectedApp,
  checkAccounts,
} from "./access.ts";

/** Public callback authentication belongs to the selected app's signature verifier. */
export const hostedWebhookCallback = Effect.flatMap(
  Effect.flatten(HostedExecutor),
  webhookCallback,
).pipe(
  Effect.catchTag("StorageError", () => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
);
/** Management uses current organization authority before any app code runs. */
export const hostedWebhookHandlers = HttpApiBuilder.group(HostedApi, "webhooks", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Authentication;
    const api = yield* ApiAuthentication;
    return handlers
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const owner = yield* appReaderOwner(params.app);
          const executor = yield* Effect.flatten(HostedExecutor);
          yield* executor.apps.get({ owner, app: params.app });
          const subscription = yield* executor.webhooks.get(params);
          if (subscription.profile !== null)
            yield* ownProfile(executor, owner, params.app, subscription.profile);
          yield* checkAccounts(executor, owner, subscription.accounts);
          return subscription;
        }),
      )
      .handle("confirmRemoval", ({ params }) =>
        Effect.gen(function* () {
          const executor = yield* Effect.flatten(HostedExecutor);
          const saved = yield* executor.webhooks.get(params);
          const owner = yield* executionManagerOwner(
            executor,
            params.app,
            saved.profile ?? undefined,
          );
          yield* executor.apps.get({ owner, app: params.app });
          return yield* executor.webhooks.confirmRemoval(params);
        }),
      )
      .handle("setupLink", ({ params }) =>
        Effect.gen(function* () {
          const executor = yield* Effect.flatten(HostedExecutor);
          const saved = yield* executor.webhooks.get(params);
          const owner = yield* executionManagerOwner(
            executor,
            params.app,
            saved.profile ?? undefined,
          );
          yield* executor.apps.get({ owner, app: params.app });
          yield* checkAccounts(executor, owner, (yield* executor.webhooks.get(params)).accounts);
          yield* executor.webhookSetup.read(params);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const headers = new Headers(request.headers);
          const slug = headers.has("authorization")
            ? (yield* api.authenticate(headers, (yield* CurrentOrganization).organization))
                .organizationSlug
            : yield* auth.organizationSlug(headers, (yield* CurrentOrganization).organization);
          return {
            url: `${auth.origin}/org/${encodeURIComponent(slug)}/webhooks/${encodeURIComponent(params.app)}/${encodeURIComponent(params.subscription)}`,
          };
        }),
      )
      .handle("definitions", ({ params, query }) =>
        Effect.gen(function* () {
          const owner = yield* appReaderOwner(params.app);
          const executor = yield* Effect.flatten(HostedExecutor);
          yield* selectedApp(executor, owner, params.app, query.profile);
          return yield* executor.webhooks.definitions({ ...params, ...query });
        }),
      )
      .handle("list", ({ params, query }) =>
        Effect.gen(function* () {
          const owner = yield* appReaderOwner(params.app);
          const executor = yield* Effect.flatten(HostedExecutor);
          yield* executor.apps.get({ owner, app: params.app });
          if (query.profile !== undefined)
            yield* ownProfile(executor, owner, params.app, query.profile);
          const subscriptions = yield* executor.webhooks.list({ ...params, ...query });
          return yield* Effect.filter(subscriptions, (subscription) =>
            Effect.gen(function* () {
              if (subscription.profile !== null)
                yield* ownProfile(executor, owner, params.app, subscription.profile);
              yield* checkAccounts(executor, owner, subscription.accounts);
            }).pipe(
              Effect.as(true),
              Effect.catchTag("OrganizationForbidden", () => Effect.succeed(false)),
            ),
          );
        }),
      )
      .handle("create", ({ params, payload }) =>
        Effect.gen(function* () {
          const executor = yield* Effect.flatten(HostedExecutor);
          const owner = yield* executionManagerOwner(executor, params.app, payload.profile);
          yield* selectedApp(executor, owner, params.app, payload.profile);
          return yield* executor.webhooks.create({ ...params, ...payload });
        }),
      )
      .handle("reconcile", ({ params }) =>
        Effect.gen(function* () {
          const executor = yield* Effect.flatten(HostedExecutor);
          const saved = yield* executor.webhooks.get(params);
          const owner = yield* executionManagerOwner(
            executor,
            params.app,
            saved.profile ?? undefined,
          );
          yield* executor.apps.get({ owner, app: params.app });
          const subscription = yield* executor.webhooks.get(params);
          if (subscription.profile !== null)
            yield* ownProfile(executor, owner, params.app, subscription.profile);
          yield* checkAccounts(executor, owner, subscription.accounts);
          return yield* executor.webhooks.reconcile(params);
        }),
      )
      .handle("remove", ({ params }) =>
        Effect.gen(function* () {
          const executor = yield* Effect.flatten(HostedExecutor);
          const saved = yield* executor.webhooks.get(params);
          const owner = yield* executionManagerOwner(
            executor,
            params.app,
            saved.profile ?? undefined,
          );
          yield* executor.apps.get({ owner, app: params.app });
          const subscription = yield* executor.webhooks.get(params);
          if (subscription.profile !== null)
            yield* ownProfile(executor, owner, params.app, subscription.profile);
          yield* checkAccounts(executor, owner, subscription.accounts);
          return yield* executor.webhooks.remove(params);
        }),
      );
  }),
);
