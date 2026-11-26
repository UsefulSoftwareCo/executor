import { AccountId, AppId, ToolName, type ToolSearchScope } from "@executor-js/sdk/core";
import { Match, Schema } from "effect";

export const Action = Schema.Literals(["discover", "read", "run", "manage", "data"]);
export type Action = typeof Action.Type;
export const ToolScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("readOnly") }),
  Schema.Struct({ kind: Schema.Literal("selected"), names: Schema.Array(ToolName) }),
]);
export type ToolScope = typeof ToolScope.Type;
export const EventScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("selected"), names: Schema.Array(Schema.NonEmptyString) }),
]);
export type EventScope = typeof EventScope.Type;
export const RunTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("app") }),
  Schema.Struct({ kind: Schema.Literal("account"), id: AccountId }),
]);
export type RunTarget = typeof RunTarget.Type;
export const AppPermission = Schema.Struct({
  app: AppId,
  tools: ToolScope,
  events: Schema.optionalKey(EventScope),
  targets: Schema.optionalKey(Schema.Array(RunTarget)),
});
export type AppPermission = typeof AppPermission.Type;
export const ToolSelection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("tools"), apps: Schema.Array(AppPermission) }),
]);
export type ToolSelection = typeof ToolSelection.Type;
export const AuthorizationPolicy = Schema.Struct({
  actions: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("all") }),
    Schema.Struct({ kind: Schema.Literal("selected"), names: Schema.Array(Action) }),
  ]),
  tools: ToolSelection,
});
export type AuthorizationPolicy = typeof AuthorizationPolicy.Type;
export interface ToolIdentity {
  readonly name: ToolName;
  readonly readOnly?: boolean | undefined;
}
export interface ToolRequest {
  readonly app: AppId;
  readonly tool: ToolIdentity;
  readonly accounts: readonly AccountId[];
}
export const fullAuthority: AuthorizationPolicy = {
  actions: { kind: "all" },
  tools: { kind: "all" },
};
export const noAuthority: AuthorizationPolicy = {
  actions: { kind: "selected", names: [] },
  tools: { kind: "tools", apps: [] },
};
export const selectedAuthority = (
  actions: readonly Action[],
  tools: ToolSelection,
): AuthorizationPolicy => ({ actions: { kind: "selected", names: actions }, tools });
export const permitsAction = (policy: AuthorizationPolicy, action: Action | undefined) =>
  policy.actions.kind === "all" || (action !== undefined && policy.actions.names.includes(action));
const scopeGrantsAny = (tools: ToolScope) => tools.kind !== "selected" || tools.names.length > 0;
const permissionTargets = (item: AppPermission) =>
  item.targets === undefined || item.targets.length > 0;
const eventsGrantAny = (events: EventScope | undefined) =>
  events === undefined || events.kind === "all" || events.names.length > 0;
export const selectsApp = (selection: ToolSelection, app: AppId) =>
  selection.kind === "all" ||
  selection.apps.some(
    (item) =>
      item.app === app &&
      (scopeGrantsAny(item.tools) || eventsGrantAny(item.events)) &&
      permissionTargets(item),
  );
export const selectsToolApp = (selection: ToolSelection, app: AppId) =>
  selection.kind === "all" ||
  selection.apps.some(
    (item) => item.app === app && scopeGrantsAny(item.tools) && permissionTargets(item),
  );
const scopeSelects = (tools: ToolScope, tool: ToolIdentity) =>
  Match.value(tools).pipe(
    Match.when({ kind: "all" }, () => true),
    Match.when({ kind: "readOnly" }, () => tool.readOnly === true),
    Match.when({ kind: "selected" }, ({ names }) => names.includes(tool.name)),
    Match.exhaustive,
  );
export const permitsApp = (policy: AuthorizationPolicy, app: AppId) =>
  permitsAction(policy, "discover") && selectsApp(policy.tools, app);
const sameTarget = (a: RunTarget, b: RunTarget) =>
  a.kind === "app" ? b.kind === "app" : b.kind === "account" && a.id === b.id;
export const permittedTargets = (
  selection: ToolSelection,
  app: AppId,
): { readonly app: boolean; readonly accounts: ReadonlySet<AccountId> } | undefined => {
  if (selection.kind === "all") return undefined;
  const entries = selection.apps.filter((item) => item.app === app && scopeGrantsAny(item.tools));
  if (entries.some((item) => item.targets === undefined)) return undefined;
  const targets = entries.flatMap((item) => item.targets ?? []);
  return {
    app: targets.some((target) => target.kind === "app"),
    accounts: new Set(targets.flatMap((target) => (target.kind === "account" ? [target.id] : []))),
  };
};
export const appEntryPolicies = (
  policy: AuthorizationPolicy,
  app: AppId,
): readonly AuthorizationPolicy[] | undefined =>
  policy.tools.kind === "all"
    ? undefined
    : policy.tools.apps
        .filter((item) => item.app === app && scopeGrantsAny(item.tools) && permissionTargets(item))
        .map((item) => ({ actions: policy.actions, tools: { kind: "tools", apps: [item] } }));
const entryPermitsAccounts = (item: AppPermission, accounts: readonly AccountId[]) => {
  if (item.targets === undefined) return true;
  const targets = item.targets;
  return accounts.length === 0
    ? targets.some((target) => target.kind === "app")
    : accounts.every((account) =>
        targets.some((target) => target.kind === "account" && target.id === account),
      );
};
export const permitsAccounts = (
  policy: AuthorizationPolicy,
  app: AppId,
  accounts: readonly AccountId[],
) =>
  permitsApp(policy, app) &&
  (policy.tools.kind === "all" ||
    policy.tools.apps.some(
      (item) =>
        item.app === app && scopeGrantsAny(item.tools) && entryPermitsAccounts(item, accounts),
    ));
export const toolPermission = (
  selection: ToolSelection,
  request: ToolRequest,
): "any" | "query" | undefined => {
  if (selection.kind === "all") return "any";
  const entries = selection.apps.filter(
    (item) =>
      item.app === request.app &&
      entryPermitsAccounts(item, request.accounts) &&
      scopeSelects(item.tools, request.tool),
  );
  if (entries.length === 0) return undefined;
  return entries.some((item) => item.tools.kind !== "readOnly") ? "any" : "query";
};
export const selectsTool = (selection: ToolSelection, request: ToolRequest) =>
  toolPermission(selection, request) !== undefined;
export const discoversTool = (
  policy: AuthorizationPolicy,
  request: { readonly app: AppId; readonly tool: ToolIdentity },
) =>
  permitsAction(policy, "discover") &&
  (policy.tools.kind === "all" ||
    policy.tools.apps.some(
      (item) =>
        item.app === request.app &&
        permissionTargets(item) &&
        scopeSelects(item.tools, request.tool),
    ));
export const discoverableTools = (
  policy: AuthorizationPolicy,
  app: AppId,
): ToolSearchScope | undefined => {
  if (!permitsAction(policy, "discover")) return { readOnly: false, names: [] };
  if (policy.tools.kind === "all") return undefined;
  const entries = policy.tools.apps.filter((item) => item.app === app && permissionTargets(item));
  if (entries.some((item) => item.tools.kind === "all")) return undefined;
  return {
    readOnly: entries.some((item) => item.tools.kind === "readOnly"),
    names: [
      ...new Set(
        entries.flatMap((item) => (item.tools.kind === "selected" ? item.tools.names : [])),
      ),
    ],
  };
};
export const requiresToolMetadata = (selection: ToolSelection, app: AppId) =>
  selection.kind === "tools" &&
  selection.apps.some((item) => item.app === app && item.tools.kind === "readOnly");
export const eventAccess = (
  policy: AuthorizationPolicy,
  app: AppId,
  event: string,
): { readonly accounts?: readonly AccountId[] } | undefined => {
  if (!permitsAction(policy, "run")) return undefined;
  if (policy.tools.kind === "all") return {};
  const entries = policy.tools.apps.filter(
    (item) =>
      item.app === app &&
      permissionTargets(item) &&
      (item.events === undefined ||
        item.events.kind === "all" ||
        item.events.names.includes(event)),
  );
  if (entries.length === 0) return undefined;
  if (entries.some((item) => item.targets === undefined)) return {};
  return {
    accounts: [
      ...new Set(
        entries.flatMap((item) =>
          (item.targets ?? []).flatMap((target) => (target.kind === "account" ? [target.id] : [])),
        ),
      ),
    ],
  };
};
export const permitsEvent = (policy: AuthorizationPolicy, app: AppId, event: string) =>
  eventAccess(policy, app, event) !== undefined;
export const permitsTool = (policy: AuthorizationPolicy, request: ToolRequest) =>
  runPermission(policy, request) !== undefined;
export const runPermission = (policy: AuthorizationPolicy, request: ToolRequest) =>
  permitsAction(policy, "run") ? toolPermission(policy.tools, request) : undefined;
export const permitsRouter = (
  policy: AuthorizationPolicy,
  request: { readonly app: AppId; readonly path: string },
  tools: readonly ToolIdentity[],
  action: "discover" | "run" = "discover",
) => {
  const inside = (name: string) => request.path === "" || name.startsWith(`${request.path}.`);
  return (
    permitsAction(policy, action) &&
    (policy.tools.kind === "all" ||
      policy.tools.apps.some(
        (item) =>
          item.app === request.app &&
          permissionTargets(item) &&
          Match.value(item.tools).pipe(
            Match.when({ kind: "all" }, () => true),
            Match.when({ kind: "readOnly" }, () =>
              tools.some((tool) => tool.readOnly === true && inside(tool.name)),
            ),
            Match.when({ kind: "selected" }, ({ names }) => names.some(inside)),
            Match.exhaustive,
          ),
      ))
  );
};
const targetsSubset = (
  previous: readonly RunTarget[] | undefined,
  next: readonly RunTarget[] | undefined,
) =>
  previous === undefined ||
  (next !== undefined && next.every((target) => previous.some((item) => sameTarget(item, target))));
const scopeSubset = (previous: ToolScope, next: ToolScope) =>
  Match.value(previous).pipe(
    Match.when({ kind: "all" }, () => true),
    Match.when({ kind: "readOnly" }, () => next.kind === "readOnly"),
    Match.when(
      { kind: "selected" },
      ({ names }) => next.kind === "selected" && next.names.every((name) => names.includes(name)),
    ),
    Match.exhaustive,
  );
const eventsSubset = (previous: EventScope | undefined, next: EventScope | undefined) =>
  previous === undefined ||
  previous.kind === "all" ||
  (next !== undefined &&
    next.kind === "selected" &&
    next.names.every((name) => previous.names.includes(name)));
export const isToolSelectionSubset = (previous: ToolSelection, next: ToolSelection): boolean => {
  if (previous.kind === "all") return true;
  if (next.kind === "all") return false;
  return next.apps.every((item) =>
    previous.apps.some(
      (before) =>
        before.app === item.app &&
        targetsSubset(before.targets, item.targets) &&
        scopeSubset(before.tools, item.tools) &&
        eventsSubset(before.events, item.events),
    ),
  );
};
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
export const permittedToolAppIds = (
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
              selectsToolApp(policy.tools, item.app) &&
              (requested === undefined || requested.includes(item.app)),
          )
          .map((item) => item.app),
      ),
    ]),
    Match.exhaustive,
  );
};
