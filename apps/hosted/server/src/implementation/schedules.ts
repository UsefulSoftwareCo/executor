import { requireAppAccess } from "./resource-policy.ts";
import { GroupDatabase } from "../contracts/groups.ts";
import { CurrentOrganization } from "../contracts/organization.ts";
/** Scheduled work has a saved actor, not a retained browser session or an invented service account. */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest } from "effect/unstable/http";
import {
  RequestInvalid,
  StorageError,
  type Executor,
  type ScheduleAuthority,
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
  currentOwner,
  executionManagerOwner,
  ownProfile,
  appReaderOwner,
  selectedApp,
  checkInvocationAccounts,
} from "./access.ts";

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
        const rows =
          yield* sql`select role from member where "organizationId" = ${organization} and "userId" = ${target.actor}`.pipe(
            Effect.mapError(() => new StorageError()),
          );
        const members = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ role: OrganizationRole })),
        )(rows).pipe(Effect.mapError(() => new StorageError()));
        if (members.length !== 1 || members[0] === undefined)
          return yield* new OrganizationForbidden();
        yield* selectedApp(executor, target.owner, target.app, target.profile ?? undefined).pipe(
          Effect.provideService(GroupDatabase, Effect.succeed(sql)),
          Effect.provideService(CurrentUserId, target.actor),
          Effect.provideService(CurrentOrganization, {
            organization,
            owner: target.owner,
            role: members[0].role,
          }),
        );
      });
  });
const browserOnly = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers.authorization !== undefined) return yield* new Forbidden();
});
const wake = Effect.flatten(ScheduleWakeup);
/** Shared handlers retain product ownership and reuse the existing browser approval contract. */
export const hostedScheduleHandlers = HttpApiBuilder.group(HostedApi, "schedules", (handlers) =>
  handlers
    .handle("list", ({ params, query }) =>
      Effect.gen(function* () {
        const owner = yield* appReaderOwner(params.app);
        const executor = yield* Effect.flatten(HostedExecutor);
        if (query.profile !== undefined)
          yield* ownProfile(executor, owner, params.app, query.profile);
        return yield* executor.schedules.list({ app: params.app, owner, ...query });
      }),
    )
    .handle("definitions", ({ params, query }) =>
      Effect.gen(function* () {
        const owner = yield* currentOwner;
        const executor = yield* Effect.flatten(HostedExecutor);
        yield* selectedApp(executor, owner, params.app, query.profile);
        return yield* executor.schedules.definitions({ app: params.app, owner, ...query });
      }),
    )
    .handle("configure", ({ params, payload }) =>
      Effect.gen(function* () {
        const executor = yield* Effect.flatten(HostedExecutor);
        const owner = yield* executionManagerOwner(executor, params.app, payload.profile);
        const actor = yield* CurrentUserId;
        if (actor === undefined) return yield* new Forbidden();
        if (payload.enabled) yield* selectedApp(executor, owner, params.app, payload.profile);
        const result = yield* executor.schedules.configure({
          app: params.app,
          name: params.name,
          owner,
          actor,
          ...payload,
        });
        yield* wake;
        return result;
      }),
    )
    .handle("runNow", ({ params, query }) =>
      Effect.gen(function* () {
        const executor = yield* Effect.flatten(HostedExecutor);
        const owner = yield* executionManagerOwner(executor, params.app, query.profile);
        yield* selectedApp(executor, owner, params.app, query.profile);
        const result = yield* executor.schedules.runNow({
          ...query,
          app: params.app,
          name: params.name,
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
        return yield* Effect.filter(runs, (run) =>
          Effect.gen(function* () {
            yield* selectedApp(executor, owner, run.app, run.profile ?? undefined);
            if (query.pending)
              yield* executionManagerOwner(executor, run.app, run.profile ?? undefined);
            return true;
          }).pipe(
            Effect.catchTags({
              OrganizationForbidden: () => Effect.succeed(false),
              AccountNotFound: () => Effect.succeed(false),
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
        yield* executionManagerOwner(executor, pending.run.app, pending.run.profile ?? undefined);
        yield* checkInvocationAccounts(executor, owner, pending.invocation);
        const app = yield* selectedApp(
          executor,
          owner,
          pending.run.app,
          pending.run.profile ?? undefined,
        );
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
        yield* executionManagerOwner(executor, pending.run.app, pending.run.profile ?? undefined);
        yield* checkInvocationAccounts(executor, owner, pending.invocation);
        yield* selectedApp(executor, owner, pending.run.app, pending.run.profile ?? undefined);
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
