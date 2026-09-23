/** Product permission policies, independent of credentials, OAuth and approval delivery. */
import { AppId, ToolName } from "@executor-js/sdk/core";
import { Match, Schema } from "effect";

/** Product operations; roles still bound the authority granted by any of these actions. */
export const Action = Schema.Literals(["discover", "read", "run", "manage", "data"]);
export type Action = typeof Action.Type;
/** Explicit app-wide permission includes future tools; selected names never do. */
export const AppPermission = Schema.Struct({
  app: AppId,
  tools: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("all") }),
    Schema.Struct({ kind: Schema.Literal("selected"), names: Schema.Array(ToolName) }),
  ]),
});
/** The same app and tool selection is used by all product transports. */
export const ToolSelection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("tools"), apps: Schema.Array(AppPermission) }),
]);
export type ToolSelection = typeof ToolSelection.Type;
/** Full user authority and explicit delegated actions are distinct; empty selections deny access. */
export const AuthorizationPolicy = Schema.Struct({
  actions: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("all") }),
    Schema.Struct({ kind: Schema.Literal("selected"), names: Schema.Array(Action) }),
  ]),
  tools: ToolSelection,
});
export type AuthorizationPolicy = typeof AuthorizationPolicy.Type;
/** Browser/full-consent policy. It never bypasses live organization or role checks. */
export const fullAuthority: AuthorizationPolicy = {
  actions: { kind: "all" },
  tools: { kind: "all" },
};
/** Missing authority fails closed, including an accidentally dropped request context. */
export const noAuthority: AuthorizationPolicy = {
  actions: { kind: "selected", names: [] },
  tools: { kind: "tools", apps: [] },
};
/** Build an explicit delegation; no protocol or credential type is inferred from the actions. */
export const selectedAuthority = (
  actions: readonly Action[],
  tools: ToolSelection,
): AuthorizationPolicy => ({ actions: { kind: "selected", names: actions }, tools });
/** Unclassified operations are available only under full user authority. */
export const permitsAction = (policy: AuthorizationPolicy, action: Action | undefined) =>
  policy.actions.kind === "all" || (action !== undefined && policy.actions.names.includes(action));
/** A selection exposes an app only when it grants at least one tool. */
export const selectsApp = (selection: ToolSelection, app: AppId) =>
  selection.kind === "all" ||
  selection.apps.some(
    (item) => item.app === app && (item.tools.kind === "all" || item.tools.names.length > 0),
  );
/** Tool names are exact identifiers, never patterns or wildcard expressions. */
export const selectsTool = (selection: ToolSelection, app: AppId, tool: ToolName) =>
  selection.kind === "all" ||
  selection.apps.some(
    (item) => item.app === app && (item.tools.kind === "all" || item.tools.names.includes(tool)),
  );
/** App discovery uses the same selection as execution. */
export const permitsApp = (policy: AuthorizationPolicy, app: AppId) =>
  permitsAction(policy, "discover") && selectsApp(policy.tools, app);
/** Discovery and execution share one tool identity check, with distinct operation authority. */
export const permitsTool = (
  policy: AuthorizationPolicy,
  app: AppId,
  tool: ToolName,
  action: "discover" | "run" = "run",
) => permitsAction(policy, action) && selectsTool(policy.tools, app, tool);
/** Narrowing cannot add future-tool access or names absent from the previous selection. */
export const isToolSelectionSubset = (previous: ToolSelection, next: ToolSelection): boolean => {
  if (previous.kind === "all") return true;
  if (next.kind === "all") return false;
  return next.apps.every((item) =>
    item.tools.kind === "all"
      ? previous.apps.some((before) => before.app === item.app && before.tools.kind === "all")
      : item.tools.names.every((name) => selectsTool(previous, item.app, name)),
  );
};
/** Apply an app filter before fetching inventory; an empty result stays an explicit empty list. */
export const permittedAppIds = (
  policy: AuthorizationPolicy,
  requested?: readonly AppId[],
): readonly AppId[] | undefined => {
  if (!permitsAction(policy, "discover")) return [];
  return Match.value(policy.tools).pipe(
    Match.when({ kind: "all" }, () => requested),
    Match.when({ kind: "tools" }, ({ apps }) => [
      ...new Set(
        apps
          .filter(
            (item) =>
              selectsApp(policy.tools, item.app) &&
              (requested === undefined || requested.includes(item.app)),
          )
          .map((item) => item.app),
      ),
    ]),
    Match.exhaustive,
  );
};
