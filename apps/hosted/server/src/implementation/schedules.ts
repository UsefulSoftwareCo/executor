import { requireAppAccess } from "./resource-policy.ts";
import { GroupDatabase } from "../contracts/groups.ts";
import { CurrentOrganization } from "../contracts/organization.ts";
/** Scheduled work has a saved actor, not a retained browser session or an invented service account. */
import { Effect, Schema } from "effect";
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

/** Capture the actual host SQL client and policy while preserving per-run membership checks. */
export const makeScheduledAuthority = (executor: Executor) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (target: ScheduleAuthority) =>
      Effect.gen(function* () {
        if (!target.owner.startsWith("organization:")) return yield* new OrganizationForbidden();
        const organization = yield* Schema.decodeUnknownEffect(OrganizationId)(
          target.owner.slice("organization:".length),
        ).pipe(Effect.mapError(() => new OrganizationForbidden()));
        // An app schedule has no actor: an app manager enabled it for the app, which must still
        // be its organization's. Its runs use the app's linked accounts, which the SDK rechecks.
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
        // Each run resolves the actor's linked accounts; the SDK rechecks each account it uses.
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
/** The saved actor of each schedule copy of an app; null for an app schedule. */
const scheduleActors = (executor: Executor, owner: OwnerId, app: AppId) =>
  executor.schedules
    .list({ app, owner })
    .pipe(
      Effect.map(
        (settings) =>
          new Map<ScheduleId, string | null>(settings.map((item) => [item.id, item.actor])),
      ),
    );
/** One copy of a declaration; a copy of another app or declaration is not found. */
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
/**
 * Start a copy's run now. The run is its actor's: refuse it, rather than start it, when they
 * cannot use the app. An app schedule's run is the app's; the caller already manages the app.
 */
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
/** Shared handlers retain product ownership and reuse the existing browser approval contract. */
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
        // Each declaration carries the caller's own copy.
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
          // The app schedule runs without a caller, with the app's linked accounts; only the app's
          // managers enable or pause it. The SDK refuses a declaration of the other scope.
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
        // The caller's own copy: it runs as them, with the accounts they linked to the app.
        const owner = yield* currentOwner;
        // A run uses only accounts the caller links and their grant permits.
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
        // The caller's own copy.
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
        // The copy's member controls it; someone who manages the app may pause it, but only its
        // member can make it run again. The app's managers control an app schedule.
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
          yield* Effect.forEach([...new Set(runs.map((run) => run.app))], (app) =>
            scheduleActors(executor, owner, app).pipe(
              Effect.map((byId) => [app, byId] as const),
              Effect.catchTag("AppNotFound", () => Effect.succeed([app, new Map()] as const)),
            ),
          ),
        );
        return yield* Effect.filter(runs, (run) =>
          Effect.gen(function* () {
            yield* usableApp(executor, owner, run.app);
            if (query.pending)
              yield* actorManagerOwner(run.app, actors.get(run.app)?.get(run.scheduleId) ?? null);
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
