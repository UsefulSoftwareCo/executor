/** Product permission policies, independent of credentials, OAuth and approval delivery. */
import { AccountId, AppId, ToolName, type ToolSearchScope } from "@executor-js/sdk/core";
import { Match, Schema } from "effect";

/** Product operations; roles still bound the authority granted by any of these actions. */
export const Action = Schema.Literals(["discover", "read", "run", "manage", "data"]);
export type Action = typeof Action.Type;
/**
 * Which of an app's tools are permitted. `all` and `readOnly` are rules that include
 * future tools; `readOnly` requires the live catalog's `readOnly === true`. Selected
 * names are exact and never expand.
 */
export const ToolScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("readOnly") }),
  Schema.Struct({ kind: Schema.Literal("selected"), names: Schema.Array(ToolName) }),
]);
export type ToolScope = typeof ToolScope.Type;
/**
 * Which of an app's events are permitted, alongside its tools. `all` includes events added later;
 * selected names are exact and never expand. A permission that omits it permits every event.
 */
export const EventScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("selected"), names: Schema.Array(Schema.NonEmptyString) }),
]);
export type EventScope = typeof EventScope.Type;
/**
 * How an app may run: without the caller's accounts (`app`), or with one of them. An account target
 * permits operations that use that account; it never grants use of the account. Accounts bound to
 * the app are never targets: app access authorizes them, so an operation that uses only the app's
 * accounts needs the `app` target.
 */
export const RunTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("app") }),
  Schema.Struct({ kind: Schema.Literal("account"), id: AccountId }),
]);
export type RunTarget = typeof RunTarget.Type;
/**
 * Explicit app-wide permission includes future tools; selected names never do.
 * Omitted targets leave the caller's own accounts unrestricted; listed targets are exact.
 */
export const AppPermission = Schema.Struct({
  app: AppId,
  tools: ToolScope,
  events: Schema.optionalKey(EventScope),
  targets: Schema.optionalKey(Schema.Array(RunTarget)),
});
export type AppPermission = typeof AppPermission.Type;
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
/**
 * A tool as the live catalog describes it. Callers that only know a name pass no flag;
 * a read-only rule then denies it rather than guessing.
 */
export interface ToolIdentity {
  readonly name: ToolName;
  readonly readOnly?: boolean | undefined;
}
/**
 * One invocation: the app, the tool and every one of the caller's accounts the operation uses, not
 * the accounts bound to the app. One permission entry must permit both the tool and that whole
 * account set.
 */
export interface ToolRequest {
  readonly app: AppId;
  readonly tool: ToolIdentity;
  readonly accounts: readonly AccountId[];
}
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
const scopeGrantsAny = (tools: ToolScope) => tools.kind !== "selected" || tools.names.length > 0;
const permissionTargets = (item: AppPermission) =>
  item.targets === undefined || item.targets.length > 0;
const eventsGrantAny = (events: EventScope | undefined) =>
  events === undefined || events.kind === "all" || events.names.length > 0;
/**
 * A selection exposes an app only when it grants at least one tool or event through at least one
 * target.
 */
export const selectsApp = (selection: ToolSelection, app: AppId) =>
  selection.kind === "all" ||
  selection.apps.some(
    (item) =>
      item.app === app &&
      (scopeGrantsAny(item.tools) || eventsGrantAny(item.events)) &&
      permissionTargets(item),
  );
/** An app is in the tool inventory only when its permission grants at least one tool. */
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
/** App discovery uses the same selection as execution. */
export const permitsApp = (policy: AuthorizationPolicy, app: AppId) =>
  permitsAction(policy, "discover") && selectsApp(policy.tools, app);
const sameTarget = (a: RunTarget, b: RunTarget) =>
  a.kind === "app" ? b.kind === "app" : b.kind === "account" && a.id === b.id;
/**
 * The targets the selection permits for an app: undefined when an entry leaves them unrestricted,
 * otherwise every entry's listed targets together. Use it only to narrow which accounts a caller
 * sees; an operation's accounts are checked against one entry by {@link permitsAccounts} and
 * {@link permitsTool}.
 */
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
/**
 * Each entry for an app that grants a tool through a target, as a policy of its own with the same
 * actions, so what each entry permits can be read separately. Undefined when the selection grants
 * every app, which no entry narrows.
 */
export const appEntryPolicies = (
  policy: AuthorizationPolicy,
  app: AppId,
): readonly AuthorizationPolicy[] | undefined =>
  policy.tools.kind === "all"
    ? undefined
    : policy.tools.apps
        .filter((item) => item.app === app && scopeGrantsAny(item.tools) && permissionTargets(item))
        .map((item) => ({ actions: policy.actions, tools: { kind: "tools", apps: [item] } }));
/**
 * One entry permits an operation using exactly these of the caller's accounts: none needs the `app`
 * target, otherwise every account must be listed. Omitted targets permit any accounts.
 */
const entryPermitsAccounts = (item: AppPermission, accounts: readonly AccountId[]) => {
  if (item.targets === undefined) return true;
  const targets = item.targets;
  return accounts.length === 0
    ? targets.some((target) => target.kind === "app")
    : accounts.every((account) =>
        targets.some((target) => target.kind === "account" && target.id === account),
      );
};
/**
 * An operation using these of the caller's accounts may run when one entry for the app grants a
 * tool and permits the whole account set. Entries are never combined. Pass only the caller's own
 * accounts; accounts bound to the app follow app access.
 */
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
/**
 * How a selection permits one invocation, or undefined when it does not: one entry must select the
 * tool and permit every account the operation uses. Tool names are exact identifiers, never
 * patterns; read-only rules need the live flag. `any` when an entry selects the tool by name or
 * selects all the app's tools; `query` when only a read-only rule does, which permits the call
 * only as a query, so a tool whose kind differs when it runs is refused there.
 */
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
/** Whether one entry selects the tool and permits every account; see {@link toolPermission}. */
export const selectsTool = (selection: ToolSelection, request: ToolRequest) =>
  toolPermission(selection, request) !== undefined;
/**
 * Discovery lists a tool when some entry for its app selects it through at least one target. The
 * listing's accounts do not narrow it: a call chooses its accounts, and {@link permitsTool} checks
 * them with the tool against one entry.
 */
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
/**
 * The tools of one app a policy lets the caller discover, as a search scope, or undefined when it
 * permits every tool. A tool is in the scope exactly when {@link discoversTool} lists it: some
 * entry for the app permits it through at least one target, read-only or by name. Like discovery,
 * the listing's accounts do not narrow it.
 */
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
/** Only a read-only rule needs the live catalog to decide; exact names and all-tools do not. */
export const requiresToolMetadata = (selection: ToolSelection, app: AppId) =>
  selection.kind === "tools" &&
  selection.apps.some((item) => item.app === app && item.tools.kind === "readOnly");
/**
 * Where one of an app's events may reach a grant, or undefined when it may not. `{}` reaches it
 * from any of the app's occurrences; `accounts` limits it to occurrences whose accounts are all
 * among the listed account targets, as a grant that runs the app only with them. An account-free
 * target adds none.
 */
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
/** Whether a grant may list and subscribe to one of an app's events. */
export const permitsEvent = (policy: AuthorizationPolicy, app: AppId, event: string) =>
  eventAccess(policy, app, event) !== undefined;
/** Running a tool needs the run action and one entry permitting the tool and its accounts. */
export const permitsTool = (policy: AuthorizationPolicy, request: ToolRequest) =>
  runPermission(policy, request) !== undefined;
/**
 * How a policy permits running a tool, as {@link toolPermission} decides, or undefined when it
 * does not. Under `query` the call must run as a query.
 */
export const runPermission = (policy: AuthorizationPolicy, request: ToolRequest) =>
  permitsAction(policy, "run") ? toolPermission(policy.tools, request) : undefined;
/**
 * A router is visible when one entry for its app and target permits every tool of the app, or
 * permits a tool inside it: one the selection names, or, under a read-only rule, a read-only tool
 * the catalog lists under it. A router that failed to list its tools therefore stays hidden unless
 * the selection names a tool under its path. Like {@link discoversTool}, accounts do not narrow it.
 */
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
    // Exact names cannot be proven read-only without a live catalog, so only the rule narrows it.
    Match.when({ kind: "readOnly" }, () => next.kind === "readOnly"),
    Match.when(
      { kind: "selected" },
      ({ names }) => next.kind === "selected" && next.names.every((name) => names.includes(name)),
    ),
    Match.exhaustive,
  );
/** An omitted event scope is every event, so only an explicit selection is narrower than it. */
const eventsSubset = (previous: EventScope | undefined, next: EventScope | undefined) =>
  previous === undefined ||
  previous.kind === "all" ||
  (next !== undefined &&
    next.kind === "selected" &&
    next.names.every((name) => previous.names.includes(name)));
/**
 * Narrowing cannot add future-tool or future-event access, names, or targets absent from one
 * previous entry.
 */
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
/** App IDs for tool discovery and execution; event-only grants stay in the event inventory. */
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
