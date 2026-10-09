import { authorizeTarget, authorizeTool } from "./authorization.ts";
import { permitsRouter, permitsTool, requiresToolMetadata } from "@executor-js/authorization";
import {
  ToolApprovalRequired,
  ToolNotFound,
  type Executor,
  type ToolListOptions,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { currentOwner, selectedActiveDeployment } from "./access.ts";

/** Discover the current account-dependent catalog after checking its saved selection. */
export const listTools = (
  input: Parameters<Executor["tools"]["list"]>[0],
  options?: ToolListOptions,
) =>
  Effect.gen(function* () {
    const policy = yield* authorizeTarget(input.app, input.profile);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const deployment = yield* selectedActiveDeployment(executor, owner, input);
    const page = yield* executor.tools.list({ ...input, deployment, limit: 2000 }, options);
    return {
      ...page,
      items: page.items.filter((tool) =>
        permitsTool(policy, { app: input.app, profile: input.profile, tool }, "discover"),
      ),
      routers: page.routers.filter((router) =>
        permitsRouter(
          policy,
          { app: input.app, profile: input.profile, path: router.path },
          page.items,
        ),
      ),
    };
  });
/** Names and descriptions for browsing; schemas are read per tool. */
export const indexTools = (input: Parameters<Executor["tools"]["index"]>[0]) =>
  Effect.gen(function* () {
    const policy = yield* authorizeTarget(input.app, input.profile);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const deployment = yield* selectedActiveDeployment(executor, owner, input);
    const index = yield* executor.tools.index({ ...input, deployment });
    return {
      ...index,
      items: index.items.filter((tool) =>
        permitsTool(policy, { app: input.app, profile: input.profile, tool }, "discover"),
      ),
      routers: index.routers.filter((router) =>
        permitsRouter(
          policy,
          { app: input.app, profile: input.profile, path: router.path },
          index.items,
        ),
      ),
    };
  });
/** One tool's schemas, hidden exactly like the tools discovery omits. */
export const getTool = (input: Parameters<Executor["tools"]["get"]>[0]) =>
  Effect.gen(function* () {
    const policy = yield* authorizeTarget(input.app, input.profile);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const deployment = yield* selectedActiveDeployment(executor, owner, input);
    // When names decide, check before evaluating, so a hidden tool's source failure is not
    // reported either. A read-only rule needs the catalog's flag, so it is checked after.
    if (
      !requiresToolMetadata(policy.tools, input.app) &&
      !permitsTool(
        policy,
        { app: input.app, profile: input.profile, tool: { name: input.tool } },
        "discover",
      )
    )
      return yield* new ToolNotFound({ app: input.app, deployment, tool: input.tool });
    const tool = yield* executor.tools.get({ ...input, deployment });
    if (!permitsTool(policy, { app: input.app, profile: input.profile, tool }, "discover"))
      return yield* new ToolNotFound({
        app: tool.app,
        deployment: tool.deployment,
        tool: tool.name,
      });
    return tool;
  });
/** Execute only after this organization has passed the same account checks as discovery. */
export const callTool = (input: Parameters<Executor["tools"]["call"]>[0]) =>
  Effect.flatMap(currentOwner, (owner) =>
    Effect.gen(function* () {
      const executor = yield* Effect.flatten(HostedExecutor);
      const deployment = yield* selectedActiveDeployment(executor, owner, input);
      yield* authorizeTool({ ...input, deployment });
      const result = yield* executor.tools.call({ ...input, deployment });
      if (result.status === "approval-required")
        return yield* new ToolApprovalRequired({
          app: result.invocation.app,
          deployment: result.invocation.deployment,
          tool: result.invocation.tool,
        });
      return result.value;
    }),
  );

/** Current app and account grants authorize both discovery and execution. */
export const hostedToolHandlers = HttpApiBuilder.group(HostedApi, "tools", (handlers) =>
  handlers
    .handle("list", ({ params, query }) => listTools({ app: params.app, ...query }))
    .handle("index", ({ params, query }) => indexTools({ app: params.app, ...query }))
    .handle("get", ({ params, query }) => getTool({ app: params.app, tool: params.tool, ...query }))
    .handle("call", ({ params, payload }) => callTool({ app: params.app, ...payload })),
);
