/** Profiles belong to the caller; sharing an app never shares somebody else's setup. */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import { currentResourceAuthority, requireAppAccess } from "./resource-policy.ts";
import { checkAccounts, currentOwner, ownProfile } from "./access.ts";

/** Writes wake durable setup after the saved intent commits. */
export const hostedProfileHandlers = HttpApiBuilder.group(HostedApi, "profiles", (handlers) =>
  handlers
    .handle("list", ({ params }) =>
      Effect.gen(function* () {
        yield* requireAppAccess(params.app, "use");
        const owner = yield* currentOwner,
          actor = yield* currentResourceAuthority;
        return yield* (yield* Effect.flatten(HostedExecutor)).apps.profiles.list({
          app: params.app,
          owner,
          subject: actor.user,
        });
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        return yield* ownProfile(
          yield* Effect.flatten(HostedExecutor),
          yield* currentOwner,
          params.app,
          params.profile,
        );
      }),
    )
    .handle("create", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* requireAppAccess(params.app, "use");
        const executor = yield* Effect.flatten(HostedExecutor),
          owner = yield* currentOwner,
          actor = yield* currentResourceAuthority;
        const app = yield* executor.apps.get({ app: params.app, owner });
        yield* checkAccounts(executor, owner, app.accounts);
        yield* checkAccounts(executor, owner, payload.accounts);
        const result = yield* executor.apps.profiles.create({
          ...payload,
          app: app.id,
          owner,
          subject: actor.user,
        });
        yield* Effect.flatten(ScheduleWakeup);
        return result;
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* requireAppAccess(params.app, "use");
        const executor = yield* Effect.flatten(HostedExecutor),
          owner = yield* currentOwner;
        yield* ownProfile(executor, owner, params.app, params.profile);
        yield* checkAccounts(
          executor,
          owner,
          (yield* executor.apps.get({ app: params.app, owner })).accounts,
        );
        yield* checkAccounts(executor, owner, payload.accounts);
        const result = yield* executor.apps.profiles.update({ ...params, ...payload });
        yield* Effect.flatten(ScheduleWakeup);
        return result;
      }),
    )
    .handle("setEnabled", ({ params, payload }) =>
      Effect.gen(function* () {
        const executor = yield* Effect.flatten(HostedExecutor),
          owner = yield* currentOwner;
        const current = yield* ownProfile(executor, owner, params.app, params.profile);
        if (payload.enabled) {
          yield* requireAppAccess(params.app, "use");
          const app = yield* executor.apps.get({ app: params.app, owner });
          yield* checkAccounts(executor, owner, app.accounts);
          yield* checkAccounts(executor, owner, current.accounts);
        }
        const result = yield* executor.apps.profiles.setEnabled({ ...params, ...payload });
        yield* Effect.flatten(ScheduleWakeup);
        return result;
      }),
    )
    .handle("reconcile", ({ params }) =>
      Effect.gen(function* () {
        const executor = yield* Effect.flatten(HostedExecutor);
        yield* ownProfile(executor, yield* currentOwner, params.app, params.profile);
        const result = yield* executor.apps.profiles.reconcile(params);
        yield* Effect.flatten(ScheduleWakeup);
        return result;
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        const executor = yield* Effect.flatten(HostedExecutor);
        yield* ownProfile(executor, yield* currentOwner, params.app, params.profile);
        const result = yield* executor.apps.profiles.remove(params);
        yield* Effect.flatten(ScheduleWakeup);
        return result;
      }),
    ),
);
