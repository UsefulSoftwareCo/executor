import { authorizeApp, authorizeSavedTool, authorizeTool } from "./authorization.ts";
import {
  discoverableTools,
  discoversTool,
  permitsApp,
  permitsRouter,
  requiresToolMetadata,
} from "@executor-js/authorization";
import {
  approvalRequired,
  RequestInvalid,
  ToolApprovalIssuer,
  ToolApprovalNotFound,
  ToolNotFound,
  type App,
  type AppAccounts,
  type AppId,
  type ApprovalRequestId,
  type Executor,
  type ToolInvocationOptions,
  type ToolListOptions,
} from "@executor-js/sdk/core";
import { ApprovalResponse, approvalElicitation } from "apps/contracts";
import {
  ToolRunApprovalRefused,
  type BrowserApprovalView,
  type BrowserToolRun,
} from "@executor-js/mcp/browser";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import { CallFailures, RunFailures } from "../contracts/tools.ts";
import { CurrentToolCallCaller } from "../contracts/tool-call-log.ts";
import {
  dashboardRunReference,
  loggedToolCall,
  loggedToolResume,
  recordCallDetails,
} from "./tool-call-log.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { CurrentUserId, Forbidden } from "../contracts/auth.ts";
import { CurrentPolicy } from "../contracts/authorization.ts";
import {
  browserOnly,
  checkedToolCall,
  checkInvocationAccounts,
  currentOwner,
  pinnedActiveVersion,
  selectedActiveVersion,
  usableApp,
} from "./access.ts";

export const listTools = (
  input: Parameters<Executor["tools"]["list"]>[0],
  options?: ToolListOptions,
) =>
  Effect.gen(function* () {
    const policy = yield* authorizeApp(input.app);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const { version, accounts } = yield* selectedActiveVersion(executor, owner, input);
    const page = yield* executor.tools.list({ ...input, version, accounts, limit: 2000 }, options);
    return {
      ...page,
      items: page.items.filter((tool) => discoversTool(policy, { app: input.app, tool })),
      routers: page.routers.filter((router) =>
        permitsRouter(policy, { app: input.app, path: router.path }, page.items),
      ),
    };
  });
export const searchableTools = <E = never>(
  input: Parameters<Executor["tools"]["searchable"]>[0],
  options?: ToolListOptions,
  selected?: Effect.Effect<{ readonly app: App; readonly accounts: AppAccounts }, E>,
) =>
  Effect.gen(function* () {
    const policy = yield* authorizeApp(input.app);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const { version, accounts } =
      selected === undefined
        ? yield* selectedActiveVersion(executor, owner, input)
        : yield* Effect.flatMap(selected, (found) => pinnedActiveVersion(found, input.version));
    const searchable = yield* executor.tools.searchable({ ...input, version, accounts }, options);
    return {
      ...searchable,
      routers: searchable.routers.filter((router) =>
        permitsRouter(policy, { app: input.app, path: router.path }, []),
      ),
    };
  });
export const searchTools = (input: Parameters<Executor["tools"]["search"]>[0]) =>
  Effect.gen(function* () {
    const policy = yield* CurrentPolicy;
    const executor = yield* Effect.flatten(HostedExecutor);
    const page = yield* executor.tools.search({
      ...input,
      targets: input.targets.map((target) => {
        const scope = permitsApp(policy, target.app)
          ? discoverableTools(policy, target.app)
          : { readOnly: false, names: [] };
        return scope === undefined ? target : { ...target, scopes: [...target.scopes, scope] };
      }),
    });
    return {
      ...page,
      items: page.items.map(({ router, ...item }) => {
        const target = input.targets[item.target];
        return router !== undefined &&
          target !== undefined &&
          permitsRouter(policy, { app: target.app, path: router.path }, [item.tool])
          ? { ...item, router }
          : item;
      }),
    };
  });
export const indexTools = (input: Parameters<Executor["tools"]["index"]>[0]) =>
  Effect.gen(function* () {
    const policy = yield* authorizeApp(input.app);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const { version, accounts } = yield* selectedActiveVersion(executor, owner, input);
    const index = yield* executor.tools.index({ ...input, version, accounts });
    return {
      ...index,
      items: index.items.filter((tool) => discoversTool(policy, { app: input.app, tool })),
      routers: index.routers.filter((router) =>
        permitsRouter(policy, { app: input.app, path: router.path }, index.items),
      ),
    };
  });
export const getTool = (input: Parameters<Executor["tools"]["get"]>[0]) =>
  Effect.gen(function* () {
    const policy = yield* authorizeApp(input.app);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const { version, accounts } = yield* selectedActiveVersion(executor, owner, input);
    if (
      !requiresToolMetadata(policy.tools, input.app) &&
      !discoversTool(policy, { app: input.app, tool: { name: input.tool } })
    )
      return yield* new ToolNotFound({ app: input.app, version, tool: input.tool });
    const tool = yield* executor.tools.get({ ...input, version, accounts });
    if (!discoversTool(policy, { app: input.app, tool }))
      return yield* new ToolNotFound({
        app: tool.app,
        version: tool.version,
        tool: tool.name,
      });
    return tool;
  });
const startTool = (
  input: Parameters<Executor["tools"]["call"]>[0],
  options?: ToolInvocationOptions,
) =>
  Effect.flatMap(currentOwner, (owner) =>
    Effect.gen(function* () {
      const executor = yield* Effect.flatten(HostedExecutor);
      const { version, accounts, kind } = yield* checkedToolCall(
        executor,
        owner,
        input,
        (selected, described) => authorizeTool({ ...input, ...selected }, described),
      );
      yield* recordCallDetails({ version, accounts, ...(kind === undefined ? {} : { kind }) });
      return yield* executor.tools.call({ ...input, version, accounts, kind }, options);
    }),
  );
export const callTool = (input: Parameters<Executor["tools"]["call"]>[0]) =>
  Effect.gen(function* () {
    const { exit, reference } = yield* loggedToolCall(
      yield* CurrentToolCallCaller,
      input,
      false,
      startTool(input),
    );
    return yield* exit.pipe(
      Effect.flatMap((result) =>
        result.status === "approval-required"
          ? Effect.fail(approvalRequired(result))
          : Effect.succeed(result.value),
      ),
      Effect.mapError((error) => CallFailures.withReference(error, reference)),
    );
  });
const dashboardRun = Effect.gen(function* () {
  yield* browserOnly;
  const user = yield* CurrentUserId;
  if (user === undefined) return yield* new Forbidden();
  return ToolApprovalIssuer.make(`dashboard:${user}`);
});
const runTool = (input: Parameters<Executor["tools"]["call"]>[0]) =>
  Effect.gen(function* () {
    const { exit, reference } = yield* loggedToolCall(
      { source: "dashboard" },
      input,
      true,
      Effect.flatMap(dashboardRun, (issuer) => startTool(input, { issuer })),
    );
    return yield* exit.pipe(
      Effect.map((result): BrowserToolRun =>
        result.status === "approval-required"
          ? { status: result.status, requestId: result.requestId }
          : {
              status: result.status,
              value: result.value,
              ...(result.toolError === true && reference !== undefined ? { reference } : {}),
            },
      ),
      Effect.mapError((error) => RunFailures.withReference(error, reference)),
    );
  });
const reviewedTool = (app: AppId, requestId: ApprovalRequestId) =>
  Effect.gen(function* () {
    const issuer = yield* dashboardRun;
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const pending = yield* executor.tools.approval({ requestId, owner });
    if (pending.issuer !== issuer)
      return yield* new ToolRunApprovalRefused({
        reason: pending.issuer === undefined ? "unrecorded" : "another-person",
      });
    const { invocation } = pending;
    if (invocation.app !== app) return yield* new ToolApprovalNotFound({ requestId });
    const found = yield* usableApp(executor, owner, app);
    yield* authorizeSavedTool(invocation);
    yield* checkInvocationAccounts(executor, owner, invocation);
    return { ...pending, issuer, appName: found.name };
  });

export const hostedToolHandlers = HttpApiBuilder.group(HostedApi, "tools", (handlers) =>
  handlers
    .handle("list", ({ params, query }) => listTools({ app: params.app, ...query }))
    .handle("index", ({ params, query }) => indexTools({ app: params.app, ...query }))
    .handle("get", ({ params, query }) => getTool({ app: params.app, tool: params.tool, ...query }))
    .handle("call", ({ params, payload }) =>
      CallFailures.referenced(callTool({ app: params.app, ...payload })),
    )
    .handle("run", ({ params, payload }) =>
      RunFailures.referenced(runTool({ app: params.app, ...payload })),
    )
    .handle("approval", ({ params }) =>
      reviewedTool(params.app, params.requestId).pipe(
        Effect.map(({ invocation, expiresAt, appName }): BrowserApprovalView => ({
          status: "pending",
          appName,
          request: {
            status: "approval-required",
            requestId: params.requestId,
            invocation,
            elicitation: approvalElicitation(invocation.tool, invocation.input),
            expiresAt,
          },
        })),
        Effect.catchTag("ToolApprovalNotFound", () =>
          Effect.succeed({ status: "unavailable" as const }),
        ),
      ),
    )
    .handle("answer", ({ params, payload }) =>
      Effect.gen(function* () {
        const { issuer } = yield* reviewedTool(params.app, params.requestId);
        const response = yield* Schema.decodeUnknownEffect(ApprovalResponse)(payload.response).pipe(
          Effect.mapError(() => new RequestInvalid()),
        );
        const executor = yield* Effect.flatten(HostedExecutor);
        const logged = yield* loggedToolResume(
          params.requestId,
          executor.tools.resume(
            { requestId: params.requestId, owner: yield* currentOwner, response },
            { issuer },
          ),
        );
        const result = yield* logged.exit;
        const succeeded = result.status === "completed" && result.toolError !== true;
        if (result.status === "already-consumed") return { status: "unavailable" as const };
        return result.status === "failed" && result.reason === "expired"
          ? {
              status: "unavailable" as const,
              ...(logged.reference === undefined ? {} : { reference: logged.reference }),
            }
          : {
              status: "answered" as const,
              result,
              ...(succeeded || logged.reference === undefined
                ? {}
                : { reference: logged.reference }),
            };
      }).pipe(
        Effect.catchTag("ToolApprovalNotFound", () =>
          Effect.map(dashboardRunReference(params.requestId), (reference) => ({
            status: "unavailable" as const,
            ...(reference === undefined ? {} : { reference }),
          })),
        ),
      ),
    ),
);
