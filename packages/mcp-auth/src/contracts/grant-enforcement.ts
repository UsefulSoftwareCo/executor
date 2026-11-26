import {
  fullAuthority,
  selectedAuthority,
  type AuthorizationPolicy,
  permitsApp,
  permittedTargets,
  eventAccess,
} from "@executor-js/authorization";
import { AccountId, AppId, ToolName, type LinkedAccounts } from "@executor-js/sdk/core";
import { UserFacingError, type ErrorPresentation } from "@executor-js/utils/user-facing-error";
import { Match, Schema } from "effect";
import {
  ApprovalMode,
  ConnectionId,
  type Grant,
  type GrantPolicy,
  type GrantTarget,
  type McpAddress,
} from "./grant.ts";

export const GrantRefusal = Schema.Union([
  Schema.Struct({ reason: Schema.Literal("api") }),
  Schema.Struct({ reason: Schema.Literal("connection"), connection: ConnectionId }),
  Schema.Struct({ reason: Schema.Literal("approval"), mode: ApprovalMode }),
  Schema.Struct({ reason: Schema.Literal("app"), app: AppId }),
  Schema.Struct({
    reason: Schema.Literal("target"),
    app: AppId,
    accounts: Schema.optionalKey(Schema.NonEmptyArray(AccountId)),
  }),
  Schema.Struct({ reason: Schema.Literal("tool"), app: AppId, tool: ToolName }),
  Schema.Struct({ reason: Schema.Literal("events"), app: AppId }),
]);
export type GrantRefusal = typeof GrantRefusal.Type;

export const grantAuthorization = (policy: GrantPolicy): AuthorizationPolicy =>
  policy.kind === "all"
    ? fullAuthority
    : selectedAuthority(["discover", "run"], { kind: "tools", apps: policy.apps });
export const approvalRefusal = (
  policy: GrantPolicy,
  target: GrantTarget,
): GrantRefusal | undefined =>
  target.kind === "mcp" &&
  policy.kind === "tools" &&
  policy.approval === "browser" &&
  target.mode !== "browser"
    ? { reason: "approval", mode: target.mode }
    : undefined;
export const targetedLinks = <A extends LinkedAccounts[string]["accounts"][number]>(
  authority: AuthorizationPolicy,
  app: AppId,
  linked: LinkedAccounts<A>,
): LinkedAccounts<A> => {
  const targets = permittedTargets(authority.tools, app);
  if (targets === undefined) return linked;
  return Object.fromEntries(
    Object.entries(linked).map(([requirement, linked]) => [
      requirement,
      {
        ...linked,
        accounts: linked.accounts.filter((account) => targets.accounts.has(account.id)),
      },
    ]),
  );
};
export const untargetedLinkRefusal = (
  authority: AuthorizationPolicy,
  app: AppId,
  linked: LinkedAccounts,
): GrantRefusal | undefined => {
  const targets = permittedTargets(authority.tools, app);
  if (targets === undefined) return undefined;
  for (const requirement of Object.values(linked)) {
    const used = requirement.accounts.at(-1);
    if (
      requirement.cardinality === "one" &&
      used !== undefined &&
      !requirement.accounts.some((account) => targets.accounts.has(account.id))
    )
      return { reason: "target", app, accounts: [used.id] };
  }
  return undefined;
};
export const grantEventAccess = (policy: GrantPolicy, app: AppId, event: string) => {
  const authority = grantAuthorization(policy);
  return permitsApp(authority, app) ? eventAccess(authority, app, event) : undefined;
};
export const grantRefusal = (grant: Grant): GrantRefusal | undefined =>
  grant.target.kind !== "mcp" ? { reason: "api" } : approvalRefusal(grant.policy, grant.target);
export const unrecordedRefusal = (address: McpAddress): GrantRefusal | undefined =>
  address.connection === undefined
    ? undefined
    : { reason: "connection", connection: address.connection };
export const permitsBrowserApproval = (grant: Grant) =>
  grant.target.kind === "mcp" &&
  grant.target.mode === "browser" &&
  grantRefusal(grant) === undefined;

const notBypassed = "Do not bypass authorization.";
const refusalPresentation = (refusal: GrantRefusal): ErrorPresentation =>
  Match.value(refusal).pipe(
    Match.discriminatorsExhaustive("reason")({
      api: () => ({
        title: "API credential",
        description: "This credential was issued for the Executor API, not for MCP.",
        recovery: {
          action: "Connect at the MCP URL to get a credential for it, then retry.",
          instructions: `A credential serves the one resource it was issued for. Connect the MCP client at the MCP URL so it receives its own credential, and verify that tools are listed. ${notBypassed}`,
        },
      }),
      connection: ({ connection }) => ({
        title: "Connection needs sign-in",
        description: `This credential has full access and no sign-in record, so it cannot be limited to the connection ${connection} that this MCP URL names.`,
        recovery: {
          action:
            "Use the MCP URL without the connection parameter, or sign the client in through OAuth and choose the connection, then retry.",
          instructions: `Personal access tokens and the local administrative key are not limited to a connection, so Executor refuses them at a connection URL instead of granting more than the connection allows. Remove the connection parameter to use the credential's full access, or connect the MCP client through OAuth and choose the connection on the sign-in page, then verify that tools are listed. ${notBypassed}`,
        },
      }),
      approval: ({ mode }) => ({
        title: "Browser approval unavailable",
        description: `This credential’s grant needs its tool calls approved in the browser, but its approval mode is ${mode}, which cannot ask for that approval.`,
        recovery: {
          action: "Connect again and choose browser approval when signing in, then retry.",
          instructions: `The grant was narrowed to selected tools with browser approval while its approval mode was another one, which Executor no longer allows. The approval mode is chosen when signing in and kept by the grant. Connect again, choose browser approval and the tools, and verify that tools are listed. ${notBypassed}`,
        },
      }),
      app: ({ app }) => ({
        title: "App not included",
        description: `This credential’s grant does not include the app ${app}.`,
        recovery: {
          action:
            "Use an app the grant includes, or add this app to its connection or grant, then retry.",
          instructions: `An MCP grant, or the connection it was issued through, lists the apps its client may discover and run. Check whether this app should be available to the client. If so, add it to the connection, or connect again and include it when approving access, then verify that the app's tools are listed. ${notBypassed}`,
        },
      }),
      target: ({ app, accounts }) => ({
        title: "Runs-as target not included",
        description: `This credential’s grant includes the app ${app}, but not running it ${accounts === undefined ? "without an account" : `with the account${accounts.length === 1 ? "" : "s"} ${accounts.join(", ")}`}.`,
        recovery: {
          action:
            "Run the app with accounts the grant allows, or add this target to its connection, then retry.",
          instructions: `For each app, an MCP grant or its connection lists how the app may run: with specific accounts, or without an account. One entry must permit every account a call uses. Check the runs-as choices for this app. Choose accounts the grant includes, or add these to the connection, then verify that the call succeeds. ${notBypassed}`,
        },
      }),
      tool: ({ app, tool }) => ({
        title: "Tool not included",
        description: `This credential’s grant does not include the tool “${tool}” of the app ${app}.`,
        recovery: {
          action:
            "Use a tool the grant includes, or add this tool to its connection or grant, then retry.",
          instructions: `An MCP grant, or its connection, selects each app's tools by exact name, as all tools, or as read-only tools only; a read-only selection excludes every tool not marked read-only. Check whether this tool should be available to the client. If so, change the connection's tool selection, or connect again and include the tool, then verify that the call succeeds. ${notBypassed}`,
        },
      }),
      events: ({ app }) => ({
        title: "Events not included",
        description: `This credential’s grant does not include this event of the app ${app}.`,
        recovery: {
          action:
            "Add this event to the app's event selection in this connection or grant, then retry.",
          instructions: `An MCP grant, or its connection, selects each app's events as all events or by exact name, beside its tools. Check whether this client should receive the event. If so, change the connection's event selection for the app, or connect again with it, then verify that events/list includes it. ${notBypassed}`,
        },
      }),
    }),
  );
export const GrantForbidden = UserFacingError.define({
  tag: "GrantForbidden",
  status: 403,
  fields: { refusal: GrantRefusal },
  recorded: ({ refusal }) => `The grant does not authorize this request (${refusal.reason})`,
  presentation: ({ refusal }) => refusalPresentation(refusal),
});
export type GrantForbidden = typeof GrantForbidden.Type;
