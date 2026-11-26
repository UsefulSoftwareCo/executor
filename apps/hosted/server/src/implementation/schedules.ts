import { requireAppAccess } from "./resource-policy.ts";
import { GroupDatabase } from "../contracts/groups.ts";
import { CurrentOrganization } from "../contracts/organization.ts";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { HttpApiBuilder } from "effect/http-api";
import {
  RequestInvalid,
  StorageError,
  type AppId,
  type Executor,
  type OwnerId,
  ScheduleNotFound,
  type ScheduleAuthority,
  type ScheduleId,
  type ScheduleSettings,
} from "@executor-js/sdk/core";
import { ApprovalResponse, approvalElicitation } from "apps/contracts";
import { BrowserApprovalView } from "@executor-js/mcp/browser";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import { CurrentUserId, Forbidden } from "../contracts/auth.ts";
import {
  OrganizationForbidden,
  OrganizationRole,
  OrganizationId,
} from "../contracts/organization.ts";
import {
  browserOnly,
  currentOwner,
  actorManagerOwner,
  appManagerOwner,
  appReaderOwner,
  usableApp,
  selectedApp,
  checkInvocationAccounts,
} from "./access.ts";
import { callerAccounts } from "./app-accounts.ts";
import { actorUsesApp } from "./resource-lifecycle.ts";
import { policyDatabase } from "./resource-policy.ts";

export const makeScheduledAuthority = (executor: Executor) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (target: ScheduleAuthority) =>
      Effect.gen(function* () {
        if (!target.owner.startsWith("organization:")) return yield* new OrganizationForbidden();
        const organization = yield* Schema.decodeUnknownEffect(OrganizationId)(
          target.owner.slice("organization:".length),
        ).pipe(Effect.mapError(() => new OrganizationForbidden()));
        if (target.actor === null) {
          const apps = yield* sql`select id from hosted_app_access
            where id = ${target.app} and organization_id = ${organization}`.pipe(
            Effect.mapError(() => new StorageError()),
          );
          if (apps.length !== 1) return yield* new OrganizationForbidden();
          return;
        }
        const rows =
          yield* sql`select role from member where "organizationId" = ${organization} and "userId" = ${target.actor}`.pipe(
            Effect.mapError(() => new StorageError()),
          );
        const members = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ role: OrganizationRole })),
        )(rows).pipe(Effect.mapError(() => new StorageError()));
        if (members.length !== 1 || members[0] === undefined)
          return yield* new OrganizationForbidden();
        const actor = target.actor;
        yield* usableApp(executor, target.owner, target.app).pipe(
          Effect.provideService(GroupDatabase, Effect.succeed(sql)),
          Effect.provideService(CurrentUserId, actor),
          Effect.provideService(CurrentOrganization, {
            organization,
            owner: target.owner,
            role: members[0].role,
          }),
        );
      });
  });
const wake = Effect.flatten(ScheduleWakeup);
const perApp = <A, E, R>(check: (app: AppId) => Effect.Effect<A, E, R>) => {
  const outcomes = new Map<AppId, Result.Result<A, E>>();
  return (app: AppId) =>
    Effect.gen(function* () {
      const known = outcomes.get(app);
      if (known !== undefined) return yield* Effect.fromResult(known);
      const outcome = yield* Effect.result(check(app));
      outcomes.set(app, outcome);
      return yield* Effect.fromResult(outcome);
    });
};
const scheduleActors = (executor: Executor, owner: OwnerId, app: AppId) =>
  executor.schedules
    .list({ app, owner })
    .pipe(
      Effect.map(
        (settings) =>
          new Map<ScheduleId, string | null>(settings.map((item) => [item.id, item.actor])),
      ),
    );
const scheduleCopy = (
  executor: Executor,
  owner: OwnerId,
  params: { readonly app: AppId; readonly name: string; readonly copy: ScheduleId },
) =>
  executor.schedules.list({ app: params.app, owner }).pipe(
    Effect.flatMap((settings) => {
      const found = settings.find((item) => item.id === params.copy && item.name === params.name);
      return found === undefined ? Effect.fail(new ScheduleNotFound()) : Effect.succeed(found);
    }),
  );
const runCopy = (executor: Executor, owner: OwnerId, copy: ScheduleSettings) =>
  Effect.gen(function* () {
    if (copy.actor !== null) {
      const app = yield* usableApp(executor, owner, copy.app);
      if (!(yield* actorUsesApp(yield* policyDatabase, { ...app, actor: copy.actor })))
        return yield* new OrganizationForbidden();
    }
    const result = yield* executor.schedules.runNow({
      app: copy.app,
      name: copy.name,
      copy: copy.id,
      owner,
    });
    yield* wake;
    return result;
  });
export const hostedScheduleHandlers = HttpApiBuilder.group(HostedApi, "schedules", (handlers) =>
  handlers
    .handle("list", ({ params }) =>
      Effect.gen(function* () {
        const owner = yield* appReaderOwner(params.app);
        const executor = yield* Effect.flatten(HostedExecutor);
        return yield* executor.schedules.list({ app: params.app, owner });
      }),
    )
    .handle("definitions", ({ params }) =>
      Effect.gen(function* () {
        const actor = yield* CurrentUserId;
        if (actor === undefined) return yield* new Forbidden();
        const owner = yield* currentOwner;
        const executor = yield* Effect.flatten(HostedExecutor);
        const { accounts } = yield* selectedApp(executor, owner, params.app);
        return yield* executor.schedules.definitions({ app: params.app, owner, accounts, actor });
      }),
    )
    .handle("configure", ({ params, payload }) =>
      Effect.gen(function* () {
        const executor = yield* Effect.flatten(HostedExecutor);
        const actor = yield* CurrentUserId;
        if (actor === undefined) return yield* new Forbidden();
        const { scope, ...settings } = payload;
        if (scope === "app") {
          const owner = yield* appManagerOwner(params.app);
          const result = yield* executor.schedules.configure({
            app: params.app,
            name: params.name,
            owner,
            ...settings,
          });
          yield* wake;
          return result;
        }
        const owner = yield* currentOwner;
        if (payload.enabled) yield* callerAccounts(yield* usableApp(executor, owner, params.app));
        const result = yield* executor.schedules.configure({
          app: params.app,
          name: params.name,
          owner,
          actor,
          ...settings,
        });
        yield* wake;
        return result;
      }),
    )
    .handle("runNow", ({ params }) =>
      Effect.gen(function* () {
        const executor = yield* Effect.flatten(HostedExecutor);
        const actor = yield* CurrentUserId;
        if (actor === undefined) return yield* new Forbidden();
        const owner = yield* currentOwner;
        yield* usableApp(executor, owner, params.app);
        const copy = yield* executor.schedules.copy({
          app: params.app,
          name: params.name,
          owner,
          actor,
        });
        return yield* runCopy(executor, owner, copy);
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const executor = yield* Effect.flatten(HostedExecutor);
        const copy = yield* scheduleCopy(executor, yield* currentOwner, params);
        const owner = yield* actorManagerOwner(params.app, copy.actor);
        if (payload.enabled && copy.actor !== null) {
          if (copy.actor !== (yield* CurrentUserId)) return yield* new Forbidden();
          yield* usableApp(executor, owner, params.app);
        }
        const result = yield* executor.schedules.update({
          app: params.app,
          name: params.name,
          copy: copy.id,
          owner,
          ...payload,
        });
        yield* wake;
        return result;
      }),
    )
    .handle("runCopy", ({ params }) =>
      Effect.gen(function* () {
        const executor = yield* Effect.flatten(HostedExecutor);
        const copy = yield* scheduleCopy(executor, yield* currentOwner, params);
        const owner = yield* actorManagerOwner(params.app, copy.actor);
        return yield* runCopy(executor, owner, copy);
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        const executor = yield* Effect.flatten(HostedExecutor);
        const copy = yield* scheduleCopy(executor, yield* currentOwner, params);
        const owner = yield* actorManagerOwner(params.app, copy.actor);
        const result = yield* executor.schedules.remove({
          app: params.app,
          name: params.name,
          copy: copy.id,
          owner,
        });
        yield* wake;
        return result;
      }),
    )
    .handle("runs", ({ query }) =>
      Effect.gen(function* () {
        const owner = yield* currentOwner;
        const executor = yield* Effect.flatten(HostedExecutor);
        if (query.app !== undefined) yield* requireAppAccess(query.app, "read");
        const runs = yield* executor.schedules.runs({ ...query, owner });
        const actors = new Map(
          query.pending
            ? yield* Effect.forEach([...new Set(runs.map((run) => run.app))], (app) =>
                scheduleActors(executor, owner, app).pipe(
                  Effect.map((byId) => [app, byId] as const),
                  Effect.catchTag("AppNotFound", () => Effect.succeed([app, new Map()] as const)),
                ),
              )
            : [],
        );
        const caller = yield* CurrentUserId;
        const usable = perApp((app) => usableApp(executor, owner, app));
        const manages = perApp((app) => requireAppAccess(app, "manage"));
        return yield* Effect.filter(runs, (run) =>
          Effect.gen(function* () {
            yield* usable(run.app);
            if (query.pending) {
              const actor = actors.get(run.app)?.get(run.scheduleId) ?? null;
              if (actor === null || actor !== caller) yield* manages(run.app);
            }
            return true;
          }).pipe(
            Effect.catchTags({
              OrganizationForbidden: () => Effect.succeed(false),
              AppNotFound: () => Effect.succeed(false),
            }),
          ),
        );
      }),
    )
    .handle("approval", ({ params }) =>
      Effect.gen(function* () {
        yield* browserOnly;
        const owner = yield* currentOwner;
        const executor = yield* Effect.flatten(HostedExecutor);
        const pending = yield* executor.schedules.approval({ run: params.run, owner });
        yield* actorManagerOwner(
          pending.run.app,
          (yield* scheduleActors(executor, owner, pending.run.app)).get(pending.run.scheduleId) ??
            null,
        );
        yield* checkInvocationAccounts(executor, owner, pending.invocation);
        const app = yield* usableApp(executor, owner, pending.run.app);
        return yield* Schema.decodeUnknownEffect(BrowserApprovalView)({
          status: "pending",
          appName: app.name,
          request: {
            status: "approval-required",
            requestId: pending.run.requestId,
            invocation: pending.invocation,
            elicitation: approvalElicitation(pending.invocation.tool, pending.invocation.input),
            expiresAt: pending.expiresAt,
          },
        }).pipe(Effect.mapError(() => new StorageError()));
      }).pipe(
        Effect.catchTag("ScheduleNotFound", () =>
          Effect.succeed({ status: "unavailable" as const }),
        ),
      ),
    )
    .handle("answer", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* browserOnly;
        const owner = yield* currentOwner;
        const executor = yield* Effect.flatten(HostedExecutor);
        const pending = yield* executor.schedules.approval({ run: params.run, owner });
        yield* actorManagerOwner(
          pending.run.app,
          (yield* scheduleActors(executor, owner, pending.run.app)).get(pending.run.scheduleId) ??
            null,
        );
        yield* checkInvocationAccounts(executor, owner, pending.invocation);
        yield* usableApp(executor, owner, pending.run.app);
        const response = yield* Schema.decodeUnknownEffect(ApprovalResponse)(payload.response).pipe(
          Effect.mapError(() => new RequestInvalid()),
        );
        yield* executor.schedules.answer({
          run: params.run,
          owner,
          action: response.action === "accept" ? "accept" : "decline",
        });
        yield* wake;
        return { status: "answered" as const };
      }).pipe(
        Effect.catchTag("ScheduleNotFound", () =>
          Effect.succeed({ status: "unavailable" as const }),
        ),
      ),
    ),
);
