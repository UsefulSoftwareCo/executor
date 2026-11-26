import {
  permitsApp,
  permitsTool,
  requiresToolMetadata,
  runPermission,
  type ToolIdentity,
} from "@executor-js/authorization";
import {
  invocationAccounts,
  type AppAccounts,
  type AppId,
  type VersionId,
  type ToolInvocation,
  type ToolKind,
  type ToolName,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import { CurrentPolicy } from "../contracts/authorization.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { OrganizationForbidden } from "../contracts/organization.ts";
import { refuse } from "./auth-telemetry.ts";

export const authorizeApp = (app: AppId) =>
  Effect.gen(function* () {
    const policy = yield* CurrentPolicy;
    if (!permitsApp(policy, app))
      return yield* refuse("insufficient_scope", new OrganizationForbidden());
    return policy;
  });
export const userAccountIds = (accounts: AppAccounts) => [
  ...new Set(Object.values(accounts.user ?? {}).flat()),
];
export interface ToolAuthorization {
  readonly tool: ToolIdentity | undefined;
  readonly kind: ToolKind | undefined;
}
export const authorizeTool = (
  input: {
    readonly app: AppId;
    readonly tool: ToolName;
    readonly accounts: AppAccounts;
    readonly version?: VersionId | undefined;
    readonly kind?: ToolKind | undefined;
  },
  described?: ToolIdentity,
) =>
  Effect.gen(function* () {
    const policy = yield* CurrentPolicy;
    const request = {
      app: input.app,
      tool: { name: input.tool },
      accounts: userAccountIds(input.accounts),
    };
    if (!requiresToolMetadata(policy.tools, input.app)) {
      if (!permitsTool(policy, request))
        return yield* refuse("insufficient_scope", new OrganizationForbidden());
      return { tool: undefined, kind: input.kind } satisfies ToolAuthorization;
    }
    const executor = yield* Effect.flatten(HostedExecutor);
    const tool: ToolIdentity =
      described ??
      (yield* executor.tools
        .get(input)
        .pipe(Effect.catchTag("ToolNotFound", () => Effect.fail(new OrganizationForbidden()))));
    const permission = runPermission(policy, { ...request, tool });
    if (permission === undefined)
      return yield* refuse("insufficient_scope", new OrganizationForbidden());
    if (permission === "any") return { tool, kind: input.kind } satisfies ToolAuthorization;
    if (input.kind === "mutation")
      return yield* refuse("insufficient_scope", new OrganizationForbidden());
    return { tool, kind: "query" } satisfies ToolAuthorization;
  });
export const authorizeSavedTool = (invocation: ToolInvocation) =>
  authorizeTool({
    app: invocation.app,
    tool: invocation.tool,
    version: invocation.version,
    accounts: invocationAccounts(invocation),
    kind: invocation.kind,
  }).pipe(
    Effect.flatMap(({ kind }) =>
      kind === invocation.kind ? Effect.void : Effect.fail(new OrganizationForbidden()),
    ),
  );
