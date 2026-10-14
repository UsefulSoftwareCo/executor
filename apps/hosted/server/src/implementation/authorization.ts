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
  type DeploymentId,
  type ToolInvocation,
  type ToolKind,
  type ToolName,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import { CurrentAuthorization } from "../contracts/authorization.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { OrganizationForbidden } from "../contracts/organization.ts";

/** Check the shared app policy before reading or evaluating an app; ownership is checked separately. */
export const authorizeApp = (app: AppId) =>
  Effect.gen(function* () {
    const policy = yield* CurrentAuthorization;
    if (!permitsApp(policy, app)) return yield* new OrganizationForbidden();
    return policy;
  });
/**
 * Every user account an operation's resolved accounts use: the accounts a grant's targets name.
 * App accounts are linked for everyone and authorized by app access, so grants never list them.
 */
export const userAccountIds = (accounts: AppAccounts) => [
  ...new Set(Object.values(accounts.user ?? {}).flat()),
];
/**
 * What a tool check decided: the tool whose metadata it read, or undefined when its name decided,
 * and the kind the call must run as. A read-only rule permits the call only as a query, so the app
 * refuses it when the tool it resolves with the call's accounts is a mutation.
 */
export interface ToolAuthorization {
  readonly tool: ToolIdentity | undefined;
  readonly kind: ToolKind | undefined;
}
/**
 * Check exact tool identity before executing or resuming work, independent of HTTP/MCP
 * authentication. A read-only rule reads the tool's live flag from the pinned deployment with the
 * call's accounts, unless the caller passes the tool this check read before with the same
 * accounts; an unknown tool or missing flag is forbidden. Callers resolve the deployment and every
 * account first; one grant entry must permit the tool and the whole set of user accounts. When only
 * a read-only rule permits it, the call runs as a query: one that names a mutation is forbidden.
 */
export const authorizeTool = (
  input: {
    readonly app: AppId;
    readonly tool: ToolName;
    readonly accounts: AppAccounts;
    readonly deployment?: DeploymentId | undefined;
    readonly kind?: ToolKind | undefined;
  },
  described?: ToolIdentity,
) =>
  Effect.gen(function* () {
    const policy = yield* CurrentAuthorization;
    const request = {
      app: input.app,
      tool: { name: input.tool },
      accounts: userAccountIds(input.accounts),
    };
    if (!requiresToolMetadata(policy.tools, input.app)) {
      if (!permitsTool(policy, request)) return yield* new OrganizationForbidden();
      return { tool: undefined, kind: input.kind } satisfies ToolAuthorization;
    }
    const executor = yield* Effect.flatten(HostedExecutor);
    const tool: ToolIdentity =
      described ??
      (yield* executor.tools
        .get(input)
        .pipe(Effect.catchTag("ToolNotFound", () => Effect.fail(new OrganizationForbidden()))));
    const permission = runPermission(policy, { ...request, tool });
    if (permission === undefined) return yield* new OrganizationForbidden();
    if (permission === "any") return { tool, kind: input.kind } satisfies ToolAuthorization;
    if (input.kind === "mutation") return yield* new OrganizationForbidden();
    return { tool, kind: "query" } satisfies ToolAuthorization;
  });
/**
 * Check a saved call before it resumes, as {@link authorizeTool} checks a new one. A resumed call
 * keeps the kind it was saved with, so a read-only rule permits it only when that is a query.
 */
export const authorizeSavedTool = (invocation: ToolInvocation) =>
  authorizeTool({
    app: invocation.app,
    tool: invocation.tool,
    deployment: invocation.deployment,
    accounts: invocationAccounts(invocation),
    kind: invocation.kind,
  }).pipe(
    Effect.flatMap(({ kind }) =>
      kind === invocation.kind ? Effect.void : Effect.fail(new OrganizationForbidden()),
    ),
  );
