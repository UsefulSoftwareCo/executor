import type { McpBackend } from "@executor-js/mcp";
import {
  ElicitationFailed,
  invocationAccounts,
  type AccountId,
  type AppAccounts,
  type AppId,
  type Cursor,
  type VersionId,
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
import type { Grant } from "../contracts/grant.ts";
import {
  GrantForbidden,
  grantAuthorization,
  targetedLinks,
  type GrantRefusal,
} from "../contracts/grant-enforcement.ts";

interface Invocation {
  readonly app: AppId;
  readonly tool: ToolName;
  readonly accounts?: AppAccounts | undefined;
  readonly version?: VersionId | undefined;
  readonly kind?: ToolKind | undefined;
}
type ToolListInput = Parameters<McpBackend<never>["listTools"]>[0];
const named = (accounts: AppAccounts | undefined) =>
  accounts === undefined ? [] : [...new Set(Object.values(accounts.user ?? {}).flat())];

export const restrictMcpBackend = <E extends Error, G extends Error>(
  backend: McpBackend<E>,
  current: Effect.Effect<Grant, G>,
): McpBackend<E | G | GrantForbidden> => {
  const authority = current.pipe(Effect.map((grant) => grantAuthorization(grant.policy)));
  const refuse = (refusal: GrantRefusal | undefined) =>
    refusal === undefined ? Effect.void : Effect.fail(new GrantForbidden({ refusal }));
  const appRefusal = (policy: AuthorizationPolicy, app: AppId): GrantRefusal | undefined =>
    permitsApp(policy, app) ? undefined : { reason: "app", app };
  const targetRefusal = (app: AppId, ids: readonly AccountId[]): GrantRefusal => {
    const [first, ...rest] = ids;
    return first === undefined
      ? { reason: "target", app }
      : { reason: "target", app, accounts: [first, ...rest] };
  };
  const accountsRefusal = (
    policy: AuthorizationPolicy,
    app: AppId,
    ids: readonly AccountId[],
  ): GrantRefusal | undefined =>
    appRefusal(policy, app) ??
    (permitsAccounts(policy, app, ids) ? undefined : targetRefusal(app, ids));
  const appCheck = (policy: AuthorizationPolicy, app: AppId, accounts: AppAccounts | undefined) => {
    const ids = named(accounts);
    return refuse(ids.length === 0 ? appRefusal(policy, app) : accountsRefusal(policy, app, ids));
  };
  const checkApp = (app: AppId, accounts: AppAccounts | undefined) =>
    authority.pipe(Effect.flatMap((policy) => appCheck(policy, app, accounts)));
  const permittedPage = (policy: AuthorizationPolicy, app: AppId, page: ToolPage): ToolPage => ({
    ...page,
    items: page.items.filter((tool) => discoversTool(policy, { app, tool })),
    routers: page.routers.filter((router) =>
      permitsRouter(policy, { app, path: router.path }, page.items),
    ),
  });
  const fullListing = (input: ToolListInput, options: ToolListOptions | undefined) =>
    Effect.gen(function* () {
      let page = yield* backend.listTools(input, options);
      const version = page.version;
      const items = [...page.items];
      while (page.next !== undefined) {
        page = yield* backend.listTools({ ...input, version, cursor: page.next }, options);
        items.push(...page.items);
      }
      return { ...page, items, next: undefined };
    });
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
            { ...input, accounts: part.accounts, version: listed.version },
            options,
          ),
        );
      return {
        version: listed.version,
        accounts: input.accounts,
        items: [...items.values()],
        routers: [...routers.values()],
      } satisfies ToolPage;
    });
  const describe = (input: Invocation) =>
    Effect.gen(function* () {
      let cursor: Cursor | undefined;
      let version = input.version;
      do {
        const page = yield* backend.listTools(
          { app: input.app, accounts: input.accounts, version, cursor },
          { unboundedPages: true },
        );
        version = page.version;
        const tool = page.items.find((item) => item.name === input.tool);
        if (tool !== undefined) return { tool, version };
        cursor = page.next;
      } while (cursor !== undefined);
      return undefined;
    });
  const authorize = (policy: AuthorizationPolicy, input: Invocation) =>
    Effect.gen(function* () {
      const request = {
        app: input.app,
        tool: { name: input.tool },
        accounts: named(input.accounts),
      };
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
        return { version: input.version, kind: input.kind };
      }
      const described = yield* describe(input);
      const permission =
        described === undefined
          ? undefined
          : runPermission(policy, { ...request, tool: described.tool });
      yield* refuse(
        toolRefusal(permission === "any" || (permission === "query" && input.kind !== "mutation")),
      );
      return {
        version: described?.version,
        kind: permission === "query" ? ("query" as const) : input.kind,
      };
    });
  const check = (input: Invocation) =>
    Effect.flatMap(authority, (policy) => authorize(policy, input));
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
  const checkSelectedApp = (app: AppId) =>
    authority.pipe(
      Effect.flatMap((policy) =>
        refuse(permitsApp(policy, app) ? undefined : { reason: "app", app }),
      ),
    );
  return {
    findEventSubscription: (key) => backend.findEventSubscription(key),
    subscribeEvent: (input) =>
      (input.target.app === null
        ? authority
        : input.target.event === null
          ? checkSelectedApp(input.target.app)
          : checkEvent(input.target.app, input.target.event)
      ).pipe(Effect.andThen(() => backend.subscribeEvent(input))),
    unsubscribeEvent: (input) =>
      authority.pipe(
        Effect.flatMap((policy) =>
          refuse(
            input.app === null || permitsApp(policy, input.app)
              ? undefined
              : { reason: "app", app: input.app },
          ),
        ),
        Effect.andThen(() => backend.unsubscribeEvent(input)),
      ),
    listSkills: (input, options) =>
      checkApp(input.app, input.accounts).pipe(
        Effect.andThen(() => backend.listSkills(input, options)),
      ),
    bundleSkills: (input, options) =>
      checkApp(input.app, input.accounts).pipe(
        Effect.andThen(() => backend.bundleSkills(input, options)),
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
          yield* refuse(accountsRefusal(policy, input.app, named(page.accounts)));
          return permittedPage(policy, input.app, page);
        }
        if (input.cursor !== undefined)
          return yield* new GrantForbidden({ refusal: targetRefusal(input.app, ids) });
        return yield* entryCatalogs(policy, { ...input, accounts: input.accounts }, options);
      }),
    searchableTools: (input, options) =>
      Effect.gen(function* () {
        const policy = yield* authority;
        yield* appCheck(policy, input.app, input.accounts);
        const searchable = yield* backend.searchableTools(input, options);
        yield* refuse(accountsRefusal(policy, input.app, named(searchable.accounts)));
        return {
          ...searchable,
          routers: searchable.routers.filter((router) =>
            permitsRouter(policy, { app: input.app, path: router.path }, []),
          ),
        };
      }),
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
        const { version, kind } = yield* check(input);
        return yield* backend.callTool(
          { ...input, ...(version === undefined ? {} : { version }), kind },
          options,
        );
      }),
    resumeInvocation: (request, response, options) =>
      Effect.gen(function* () {
        const { invocation } = request;
        const { kind } = yield* check({
          app: invocation.app,
          tool: invocation.tool,
          accounts: invocationAccounts(invocation),
          version: invocation.version,
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
