import { authorizeApp, authorizeTool } from "./authorization.ts";
import { permitsTool } from "@executor-js/authorization";
import { ExecutionAdmission } from "../contracts/execution-admission.ts";
import { CurrentOrganization } from "../contracts/organization.ts";
import { ToolApprovalRequired, type Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { currentOwner, selectedApp } from "./access.ts";

/** Discover the current account-dependent catalog after checking its saved selection. */
export const listTools = (input: Parameters<Executor["tools"]["list"]>[0]) =>
  Effect.gen(function* () {
    const policy = yield* authorizeApp(input.app);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* selectedApp(executor, owner, input.app, input.profile);
    const page = yield* executor.tools.list({ ...input, limit: 2000 });
    return {
      ...page,
      items: page.items.filter((tool) => permitsTool(policy, input.app, tool.name, "discover")),
    };
  });
/** Execute only after this organization has passed the same account checks as discovery. */
export const callTool = (input: Parameters<Executor["tools"]["call"]>[0]) =>
  Effect.flatMap(currentOwner, (owner) =>
    Effect.gen(function* () {
      yield* authorizeTool(input.app, input.tool);
      const executor = yield* Effect.flatten(HostedExecutor);
      yield* selectedApp(executor, owner, input.app, input.profile);
      yield* (yield* ExecutionAdmission)((yield* CurrentOrganization).organization);
      const result = yield* executor.tools.call(input);
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
    .handle("call", ({ params, payload }) => callTool({ app: params.app, ...payload })),
);
