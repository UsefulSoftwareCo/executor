/** Apply one grant at every shared MCP operation; hosts retain their existing resource checks. */
import type { McpBackend } from "@executor-js/mcp";
import {
  ElicitationFailed,
  invocationAccounts,
  type AccountId,
  type AppAccounts,
  type AppId,
  type Cursor,
  type DeploymentId,
  type ToolKind,
  type ToolName,
  type ToolListOptions,
  type ToolPage,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import {
  appEntryPolicies,
  permitsApp,
  permitsEvent,
  permitsAccounts,
  permittedTargets,
  permitsRouter,
  discoverableTools,
  permitsTool,
  runPermission,
  discoversTool,
  permittedAppIds,
  permittedToolAppIds,
  requiresToolMetadata,
  type AuthorizationPolicy,
} from "@executor-js/authorization";
import {
  GrantForbidden,
  grantAuthorization,
  targetedLinks,
  type Grant,
  type GrantRefusal,
} from "../contracts/grant.ts";

/** The exact tool an operation would run, before its live read-only flag is known. */
interface Invocation {
  readonly app: AppId;
  readonly tool: ToolName;
  readonly accounts?: AppAccounts | undefined;
  readonly deployment?: DeploymentId | undefined;
  readonly kind?: ToolKind | undefined;
}
type ToolListInput = Parameters<McpBackend<never>["listTools"]>[0];
/**
 * Every user account an operation names: the caller's own accounts, which a grant's targets list.
 * App accounts are bound to the app and authorized by app access, so grants never list them.
 */
const named = (accounts: AppAccounts | undefined) =>
  accounts === undefined ? [] : [...new Set(Object.values(accounts.user ?? {}).flat())];

/**
 * Re-read authority per operation, including while an execution resumes within one HTTP call.
 * User accounts an operation names must be grant targets; the host checks the accounts it resolves
 * for the rest, narrowing the caller's linked accounts to the targets. App accounts are never
 * targets: app access authorizes them.
 */
export const restrictMcpBackend = <E extends Error, G extends Error>(
  backend: McpBackend<E>,
  current: Effect.Effect<Grant, G>,
): McpBackend<E | G | GrantForbidden> => {
  const authority = current.pipe(Effect.map((grant) => grantAuthorization(grant.policy)));
  const refuse = (refusal: GrantRefusal | undefined) =>
    refusal === undefined ? Effect.void : Effect.fail(new GrantForbidden({ refusal }));
  const appRefusal = (policy: AuthorizationPolicy, app: AppId): GrantRefusal | undefined =>
    permitsApp(policy, app) ? undefined : { reason: "app", app };
  /** The grant includes the app, but no entry permits these accounts, or none when empty. */
  const targetRefusal = (app: AppId, ids: readonly AccountId[]): GrantRefusal => {
    const [first, ...rest] = ids;
    return first === undefined
      ? { reason: "target", app }
      : { reason: "target", app, accounts: [first, ...rest] };
  };
  /** The app, then the accounts: the first one the grant excludes, if either is. */
  const accountsRefusal = (
    policy: AuthorizationPolicy,
    app: AppId,
    ids: readonly AccountId[],
  ): GrantRefusal | undefined =>
    appRefusal(policy, app) ??
    (permitsAccounts(policy, app, ids) ? undefined : targetRefusal(app, ids));
  const checkApp = (app: AppId, accounts: AppAccounts | undefined) =>
    authority.pipe(
      Effect.flatMap((policy) => {
        const ids = named(accounts);
        return refuse(
          ids.length === 0 ? appRefusal(policy, app) : accountsRefusal(policy, app, ids),
        );
      }),
    );
  /** The page's tools and routers this policy lets the caller discover. */
  const permittedPage = (policy: AuthorizationPolicy, app: AppId, page: ToolPage): ToolPage => ({
    ...page,
    items: page.items.filter((tool) => discoversTool(policy, { app, tool })),
    routers: page.routers.filter((router) =>
      permitsRouter(policy, { app, path: router.path }, page.items),
    ),
  });
  /** Every page of one listing, pinned to the first page's deployment. */
  const fullListing = (input: ToolListInput, options: ToolListOptions | undefined) =>
    Effect.gen(function* () {
      let page = yield* backend.listTools(input, options);
      const deployment = page.deployment;
      const items = [...page.items];
      while (page.next !== undefined) {
        page = yield* backend.listTools({ ...input, deployment, cursor: page.next }, options);
        items.push(...page.items);
      }
      return { ...page, items, next: undefined };
    });
  /**
   * The catalog an app's grant entries permit together, when no single entry permits every named
   * account. Each entry lists the catalog with the named accounts it targets, on one deployment,
   * and contributes the tools and routers it permits; a tool keeps the first entry's description.
   * A plain requirement whose account an entry does not target leaves that entry out. The page
   * names the requested accounts: calls choose theirs, and one entry must permit each call.
   */
  const entryCatalogs = (
    policy: AuthorizationPolicy,
    input: ToolListInput & { readonly accounts: AppAccounts },
    options: ToolListOptions | undefined,
  ) =>
    Effect.gen(function* () {
      const linked = yield* backend.listAccounts({ app: input.app });
      const parts: Array<{ readonly entry: AuthorizationPolicy; readonly accounts: AppAccounts }> =
        [];
      for (const entry of appEntryPolicies(policy, input.app) ?? []) {
        const targets = permittedTargets(entry.tools, input.app);
        const user: Record<string, ReadonlyArray<AccountId>> = {};
        let usable = true;
        // Targets narrow the caller's own accounts only; the app's accounts are kept.
        for (const [slot, ids] of Object.entries(input.accounts.user ?? {})) {
          const kept = targets === undefined ? ids : ids.filter((id) => targets.accounts.has(id));
          const many = Object.hasOwn(linked, slot) && linked[slot]?.cardinality === "many";
          if (kept.length === 0 && ids.length > 0 && !many) usable = false;
          user[slot] = kept;
        }
        const accounts: AppAccounts =
          input.accounts.user === undefined
            ? { app: input.accounts.app }
            : { app: input.accounts.app, user };
        if (usable && permitsAccounts(entry, input.app, named(accounts)))
          parts.push({ entry, accounts });
      }
      const [first, ...rest] = parts;
      if (first === undefined)
        return yield* new GrantForbidden({
          refusal: targetRefusal(input.app, named(input.accounts)),
        });
      const listed = yield* fullListing({ ...input, accounts: first.accounts }, options);
      const items = new Map<string, ToolPage["items"][number]>();
      const routers = new Map<string, ToolPage["routers"][number]>();
      const merge = (entry: AuthorizationPolicy, page: ToolPage) => {
        const permitted = permittedPage(entry, input.app, page);
        for (const tool of permitted.items) if (!items.has(tool.name)) items.set(tool.name, tool);
        for (const router of permitted.routers)
          if (!routers.has(router.path)) routers.set(router.path, router);
      };
      merge(first.entry, listed);
      for (const part of rest)
        merge(
          part.entry,
          yield* fullListing(
            { ...input, accounts: part.accounts, deployment: listed.deployment },
            options,
          ),
        );
      return {
        deployment: listed.deployment,
        accounts: input.accounts,
        items: [...items.values()],
        routers: [...routers.values()],
      } satisfies ToolPage;
    });
  /** Find one tool in the live catalog this invocation would use, pinned to its deployment. */
  const describe = (input: Invocation) =>
    Effect.gen(function* () {
      let cursor: Cursor | undefined;
      let deployment = input.deployment;
      do {
        const page = yield* backend.listTools({
          app: input.app,
          accounts: input.accounts,
          deployment,
          cursor,
        });
        deployment = page.deployment;
        const tool = page.items.find((item) => item.name === input.tool);
        if (tool !== undefined) return { tool, deployment };
        cursor = page.next;
      } while (cursor !== undefined);
      return undefined;
    });
  /**
   * Check the invocation against the grant. Exact names and all-tools decide from the name;
   * a read-only rule reads the live catalog, and the call then runs on that same deployment, as a
   * query: the app refuses it when the tool it resolves when called is a mutation. An invocation
   * that names a mutation is refused when only a read-only rule permits it. Succeeds with the
   * deployment and kind the call runs with.
   */
  const authorize = (policy: AuthorizationPolicy, input: Invocation) =>
    Effect.gen(function* () {
      // The invocation names every account it runs with; one entry must permit them and the tool.
      const request = {
        app: input.app,
        tool: { name: input.tool },
        accounts: named(input.accounts),
      };
      // A refused tool names its app or accounts instead when the grant excludes those.
      const toolRefusal = (allowed: boolean): GrantRefusal | undefined =>
        allowed
          ? undefined
          : (accountsRefusal(policy, input.app, request.accounts) ?? {
              reason: "tool",
              app: input.app,
              tool: input.tool,
            });
      if (!requiresToolMetadata(policy.tools, input.app)) {
        yield* refuse(toolRefusal(permitsTool(policy, request)));
        return { deployment: input.deployment, kind: input.kind };
      }
      // An unknown tool or a missing flag is never read-only.
      const described = yield* describe(input);
      const permission =
        described === undefined
          ? undefined
          : runPermission(policy, { ...request, tool: described.tool });
      yield* refuse(
        toolRefusal(permission === "any" || (permission === "query" && input.kind !== "mutation")),
      );
      return {
        deployment: described?.deployment,
        kind: permission === "query" ? ("query" as const) : input.kind,
      };
    });
  const check = (input: Invocation) =>
    Effect.flatMap(authority, (policy) => authorize(policy, input));
  /** An event needs the app and a grant that names it, or all of the app's events. */
  const checkEvent = (app: AppId, event: string) =>
    authority.pipe(
      Effect.flatMap((policy) =>
        refuse(
          !permitsApp(policy, app)
            ? { reason: "app", app }
            : !permitsEvent(policy, app, event)
              ? { reason: "events", app }
              : undefined,
        ),
      ),
    );
  return {
    eventDefinitions: (input) =>
      Effect.gen(function* () {
        const policy = yield* authority;
        yield* refuse(
          permitsApp(policy, input.app) ? undefined : { reason: "app", app: input.app },
        );
        const definitions = yield* backend.eventDefinitions(input);
        return definitions.filter((definition) => permitsEvent(policy, input.app, definition.name));
      }),
    findEventSubscription: (key) => backend.findEventSubscription(key),
    subscribeEvent: (input) =>
      checkEvent(input.target.app, input.target.event).pipe(
        Effect.andThen(() => backend.subscribeEvent(input)),
      ),
    // Stopping a subscription needs only the app; a grant narrowed since may still clean up.
    unsubscribeEvent: (input) =>
      authority.pipe(
        Effect.flatMap((policy) =>
          refuse(permitsApp(policy, input.app) ? undefined : { reason: "app", app: input.app }),
        ),
        Effect.andThen(() => backend.unsubscribeEvent(input)),
      ),
    listSkills: (input, options) =>
      checkApp(input.app, input.accounts).pipe(
        Effect.andThen(() => backend.listSkills(input, options)),
      ),
    readSkill: (input) =>
      checkApp(input.app, input.accounts).pipe(Effect.andThen(() => backend.readSkill(input))),
    listApps: (input) =>
      Effect.gen(function* () {
        const grant = yield* authority;
        const ids = input?.toolsOnly
          ? permittedToolAppIds(grant, input?.ids)
          : permittedAppIds(grant, input?.ids);
        return yield* backend.listApps({
          ids,
          ...(input?.toolsOnly === undefined ? {} : { toolsOnly: input.toolsOnly }),
        });
      }),
    listAccounts: (input) =>
      Effect.gen(function* () {
        const policy = yield* authority;
        yield* refuse(appRefusal(policy, input.app));
        return targetedLinks(policy, input.app, yield* backend.listAccounts(input));
      }),
    listTools: (input, options) =>
      Effect.gen(function* () {
        const policy = yield* authority;
        yield* refuse(appRefusal(policy, input.app));
        const ids = named(input.accounts);
        if (
          input.accounts === undefined ||
          ids.length === 0 ||
          permitsAccounts(policy, input.app, ids)
        ) {
          const page = yield* backend.listTools(input, options);
          // The page names the accounts the host resolved; one entry must permit all of them.
          yield* refuse(accountsRefusal(policy, input.app, named(page.accounts)));
          return permittedPage(policy, input.app, page);
        }
        // No entry permits every named account, such as all of a many() requirement's linked
        // accounts when entries target different ones. List each entry's catalog with the named
        // accounts it permits, and merge what each entry permits. Each call is still checked
        // against one entry.
        if (input.cursor !== undefined)
          return yield* new GrantForbidden({ refusal: targetRefusal(input.app, ids) });
        return yield* entryCatalogs(policy, { ...input, accounts: input.accounts }, options);
      }),
    searchableTools: (input, options) =>
      Effect.gen(function* () {
        yield* checkApp(input.app, input.accounts);
        const searchable = yield* backend.searchableTools(input, options);
        const policy = yield* authority;
        // The listing names the accounts the host resolved; one entry must permit all of them.
        yield* refuse(accountsRefusal(policy, input.app, named(searchable.accounts)));
        // Failed routers list no tools, so the grant decides them without the catalog.
        return {
          ...searchable,
          routers: searchable.routers.filter((router) =>
            permitsRouter(policy, { app: input.app, path: router.path }, []),
          ),
        };
      }),
    // A target the grant no longer permits keeps its place with no tools, so result indexes hold.
    searchTools: (input) =>
      Effect.gen(function* () {
        const policy = yield* authority;
        const page = yield* backend.searchTools({
          ...input,
          targets: input.targets.map((target) => {
            const scope =
              appRefusal(policy, target.app) === undefined
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
      }),
    callTool: (input, options) =>
      Effect.gen(function* () {
        const { deployment, kind } = yield* check(input);
        return yield* backend.callTool(
          { ...input, ...(deployment === undefined ? {} : { deployment }), kind },
          options,
        );
      }),
    // A resumed call keeps the kind it was saved with, so a read-only rule permits it only as a
    // query.
    resumeInvocation: (request, response, options) =>
      Effect.gen(function* () {
        const { invocation } = request;
        const { kind } = yield* check({
          app: invocation.app,
          tool: invocation.tool,
          accounts: invocationAccounts(invocation),
          deployment: invocation.deployment,
          kind: invocation.kind,
        });
        if (kind !== invocation.kind)
          yield* refuse({ reason: "tool", app: invocation.app, tool: invocation.tool });
        return yield* backend.resumeInvocation(request, response, options);
      }),
    authorizeElicitation: (input) =>
      check(input).pipe(
        Effect.mapError(() => new ElicitationFailed({ reason: "forbidden" })),
        Effect.andThen(() => backend.authorizeElicitation(input)),
      ),
  };
};
