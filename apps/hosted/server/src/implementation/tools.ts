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
import { HostedExecutor } from "../contracts/executor.ts";
import { CurrentUserId, Forbidden } from "../contracts/auth.ts";
import { CurrentAuthorization } from "../contracts/authorization.ts";
import {
  browserOnly,
  checkedToolCall,
  checkInvocationAccounts,
  currentOwner,
  selectedActiveDeployment,
  usableApp,
} from "./access.ts";

/** Discover the current account-dependent catalog with the caller's resolved accounts. */
export const listTools = (
  input: Parameters<Executor["tools"]["list"]>[0],
  options?: ToolListOptions,
) =>
  Effect.gen(function* () {
    const policy = yield* authorizeApp(input.app);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const { deployment, accounts } = yield* selectedActiveDeployment(executor, owner, input);
    const page = yield* executor.tools.list(
      { ...input, deployment, accounts, limit: 2000 },
      options,
    );
    return {
      ...page,
      items: page.items.filter((tool) => discoversTool(policy, { app: input.app, tool })),
      routers: page.routers.filter((router) =>
        permitsRouter(policy, { app: input.app, path: router.path }, page.items),
      ),
    };
  });
/** Keep the target's current catalog as search rows after the same checks as discovery. */
export const searchableTools = (
  input: Parameters<Executor["tools"]["searchable"]>[0],
  options?: ToolListOptions,
) =>
  Effect.gen(function* () {
    const policy = yield* authorizeApp(input.app);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const { deployment, accounts } = yield* selectedActiveDeployment(executor, owner, input);
    const searchable = yield* executor.tools.searchable(
      { ...input, deployment, accounts },
      options,
    );
    // Failed routers list no tools, so the policy decides them without the catalog.
    return {
      ...searchable,
      routers: searchable.routers.filter((router) =>
        permitsRouter(policy, { app: input.app, path: router.path }, []),
      ),
    };
  });
/**
 * Rank the tools of listings `searchableTools` kept for this request's caller, with each target
 * narrowed to the tools discovery would list. A target the policy no longer permits has none.
 */
export const searchTools = (input: Parameters<Executor["tools"]["search"]>[0]) =>
  Effect.gen(function* () {
    const policy = yield* CurrentAuthorization;
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
/** Names and descriptions for browsing; schemas are read per tool. */
export const indexTools = (input: Parameters<Executor["tools"]["index"]>[0]) =>
  Effect.gen(function* () {
    const policy = yield* authorizeApp(input.app);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const { deployment, accounts } = yield* selectedActiveDeployment(executor, owner, input);
    const index = yield* executor.tools.index({ ...input, deployment, accounts });
    return {
      ...index,
      items: index.items.filter((tool) => discoversTool(policy, { app: input.app, tool })),
      routers: index.routers.filter((router) =>
        permitsRouter(policy, { app: input.app, path: router.path }, index.items),
      ),
    };
  });
/** One tool's schemas, hidden exactly like the tools discovery omits. */
export const getTool = (input: Parameters<Executor["tools"]["get"]>[0]) =>
  Effect.gen(function* () {
    const policy = yield* authorizeApp(input.app);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const { deployment, accounts } = yield* selectedActiveDeployment(executor, owner, input);
    // When names decide, check before evaluating, so a hidden tool's source failure is not
    // reported either. A read-only rule needs the catalog's flag, so it is checked after.
    if (
      !requiresToolMetadata(policy.tools, input.app) &&
      !discoversTool(policy, { app: input.app, tool: { name: input.tool } })
    )
      return yield* new ToolNotFound({ app: input.app, deployment, tool: input.tool });
    const tool = yield* executor.tools.get({ ...input, deployment, accounts });
    if (!discoversTool(policy, { app: input.app, tool }))
      return yield* new ToolNotFound({
        app: tool.app,
        deployment: tool.deployment,
        tool: tool.name,
      });
    return tool;
  });
/** Execute with the caller's resolved accounts after the same checks as discovery. */
const startTool = (
  input: Parameters<Executor["tools"]["call"]>[0],
  options?: ToolInvocationOptions,
) =>
  Effect.flatMap(currentOwner, (owner) =>
    Effect.gen(function* () {
      const executor = yield* Effect.flatten(HostedExecutor);
      const { deployment, accounts, kind } = yield* checkedToolCall(
        executor,
        owner,
        input,
        (selected, described) => authorizeTool({ ...input, ...selected }, described),
      );
      return yield* executor.tools.call({ ...input, deployment, accounts, kind }, options);
    }),
  );
/** API credentials cannot present an approval, so a call that needs one fails without running. */
export const callTool = (input: Parameters<Executor["tools"]["call"]>[0]) =>
  Effect.flatMap(startTool(input), (result) =>
    result.status === "approval-required"
      ? Effect.fail(approvalRequired(result))
      : Effect.succeed(result.value),
  );
/**
 * The signed-in person's own run from the dashboard. Its approval is saved with this issuer, so only
 * that person's dashboard can read or answer it. MCP, schedules and API calls save no issuer.
 */
const dashboardRun = Effect.gen(function* () {
  yield* browserOnly;
  const user = yield* CurrentUserId;
  if (user === undefined) return yield* new Forbidden();
  return ToolApprovalIssuer.make(`dashboard:${user}`);
});
/** The signed-in person is the runner, so a call that needs approval waits for their review. */
const runTool = (input: Parameters<Executor["tools"]["call"]>[0]) =>
  Effect.flatMap(dashboardRun, (issuer) => startTool(input, { issuer })).pipe(
    Effect.map((result): BrowserToolRun =>
      result.status === "approval-required"
        ? { status: result.status, requestId: result.requestId }
        : { status: result.status, value: result.value },
    ),
  );
/**
 * Read the saved call, check this person's dashboard run issued it, and check they may still run
 * it with the same checks as a new call. The arguments shown and resumed are the saved invocation's.
 */
const reviewedTool = (app: AppId, requestId: ApprovalRequestId) =>
  Effect.gen(function* () {
    const issuer = yield* dashboardRun;
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const pending = yield* executor.tools.approval({ requestId, owner });
    // MCP, scheduled and API approvals, and other people's runs, are answered only in their own flow.
    if (pending.issuer !== issuer)
      return yield* new ToolRunApprovalRefused({
        reason: pending.issuer === undefined ? "unrecorded" : "another-person",
      });
    const { invocation } = pending;
    if (invocation.app !== app) return yield* new ToolApprovalNotFound({ requestId });
    // The saved call keeps its accounts; the caller must still be able to use the app and each.
    const found = yield* usableApp(executor, owner, app);
    yield* authorizeSavedTool(invocation);
    yield* checkInvocationAccounts(executor, owner, invocation);
    return { ...pending, issuer, appName: found.name };
  });

/** Current app and account grants authorize both discovery and execution. */
export const hostedToolHandlers = HttpApiBuilder.group(HostedApi, "tools", (handlers) =>
  handlers
    .handle("list", ({ params, query }) => listTools({ app: params.app, ...query }))
    .handle("index", ({ params, query }) => indexTools({ app: params.app, ...query }))
    .handle("get", ({ params, query }) => getTool({ app: params.app, tool: params.tool, ...query }))
    .handle("call", ({ params, payload }) => callTool({ app: params.app, ...payload }))
    .handle("run", ({ params, payload }) => runTool({ app: params.app, ...payload }))
    .handle("approval", ({ params }) =>
      reviewedTool(params.app, params.requestId).pipe(
        Effect.map(({ invocation, expiresAt, appName }): BrowserApprovalView => ({
          status: "pending",
          appName,
          request: {
            status: "approval-required",
            requestId: params.requestId,
            invocation,
            // Built from the saved call, so it describes what approval resumes; the review card
            // shows the exact arguments from the invocation.
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
        // The SDK checks the issuer again before it consumes the request.
        const result = yield* executor.tools.resume(
          { requestId: params.requestId, owner: yield* currentOwner, response },
          { issuer },
        );
        return result.status === "already-consumed" ||
          (result.status === "failed" && result.reason === "expired")
          ? { status: "unavailable" as const }
          : { status: "answered" as const, result };
      }).pipe(
        Effect.catchTag("ToolApprovalNotFound", () =>
          Effect.succeed({ status: "unavailable" as const }),
        ),
      ),
    ),
);
