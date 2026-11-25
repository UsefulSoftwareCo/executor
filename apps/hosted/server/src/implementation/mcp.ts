import { CurrentPolicy } from "../contracts/authorization.ts";
import {
  CurrentUsage,
  observeProductOperation,
  traceProductRead,
} from "../contracts/product-analytics.ts";
import { McpSchema } from "effect/ai";
import { authorizeApp, authorizeSavedTool, authorizeTool } from "./authorization.ts";
import { callerLinkedAccounts, linkedAccounts } from "./app-accounts.ts";
import { GrantForbidden, untargetedLinkRefusal } from "@executor-js/mcp-auth";
import {
  permitsApp,
  permittedAppIds,
  permittedToolAppIds,
  requiresToolMetadata,
} from "@executor-js/authorization";
import { GroupDatabase } from "../contracts/groups.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import {
  policyDatabase,
  resourceAuthorityForAppsWithLinks,
  visibleApps,
  requireAppAccess,
} from "./resource-policy.ts";
import { CurrentMcpExecution, ToolCallRecorded, type McpBackend } from "@executor-js/mcp";
import {
  AccountRequired,
  AppNotFound,
  ElicitationFailed,
  EventNotFound,
  InvocationSelection,
  linkedRequirements,
  PrefetchHost,
  SearchablePrefetch,
  type AppId,
  type ToolInvocationOptions,
} from "@executor-js/sdk/core";
import { Array as Arr, Context, Effect, Exit, Option, Schema } from "effect";
import {
  checkedToolCall,
  currentOwner,
  selectedActiveVersion,
  checkInvocationAccounts,
  selectedAppFrom,
  SelectionReadAhead,
} from "./access.ts";
import { ConcurrentStatements, HostedBackground, HostedExecutor } from "../contracts/executor.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import { CurrentMcpGrant, CurrentMcpSession, IssuedMcpSessionId } from "../contracts/mcp.ts";
import type { ToolCallCaller } from "../contracts/tool-call-log.ts";
import { loggedToolCall, loggedToolResume, recordCallDetails } from "./tool-call-log.ts";
import { patGrantOf } from "./mcp-oauth.ts";
import { listTools, searchableTools, searchTools } from "./tools.ts";
import { bundleAppSkills, listAppSkills, readAppSkill } from "./skills.ts";

const requestClient = Effect.map(Effect.serviceOption(McpSchema.McpRequestContext), (request) =>
  Option.flatMapNullishOr(request, (context) => context.clientInfo),
);

export const hostedMcpBackend = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  const policy = yield* CurrentPolicy;
  const sdk = yield* HostedExecutor;
  const database = yield* GroupDatabase;
  const user = yield* CurrentUserId;
  const grant = yield* CurrentMcpGrant;
  const session = yield* CurrentMcpSession;
  const background = yield* HostedBackground;
  const caller = Effect.fn(function* (execution: string | undefined) {
    if (grant === undefined) return undefined;
    const pat = patGrantOf(grant);
    const initialized = Option.isSome(yield* Effect.serviceOption(McpSchema.McpServerClient));
    const issued = initialized && Schema.is(IssuedMcpSessionId)(session) ? session : undefined;
    const logged: ToolCallCaller = {
      ...(Option.isSome(pat)
        ? { source: "api-key", sourceId: pat.value.token }
        : { source: "agent", sourceId: grant }),
      session: issued,
      execution,
    };
    return logged;
  });
  const context = Context.make(CurrentOrganization, organization).pipe(
    Context.add(HostedExecutor, sdk),
    Context.add(CurrentPolicy, policy),
    Context.add(GroupDatabase, database),
    Context.add(CurrentUserId, user),
    Context.add(HostedBackground, background),
  );
  const observe = <A, E, R>(
    operation: string,
    work: Effect.Effect<A, E, R>,
    kind: "read" | "operation" = "operation",
  ) =>
    Effect.gen(function* () {
      const current = yield* CurrentUsage;
      const client = yield* requestClient;
      const properties = { area: "mcp", operation };
      return yield* (
        kind === "read"
          ? traceProductRead(properties, work)
          : observeProductOperation(properties, work)
      ).pipe(
        Effect.provideService(CurrentUsage, {
          ...current,
          source: "mcp",
          ...(Option.isSome(client) ? { client_name: client.value.name.slice(0, 100) } : {}),
        }),
        Effect.provideContext(context),
      );
    });
  const discoveryApps = yield* Effect.cached(
    Effect.flatMap(sdk, (executor) =>
      executor.apps
        .list({ ids: permittedAppIds(policy), owner: organization.owner })
        .pipe(Effect.flatMap(visibleApps)),
    ).pipe(Effect.provideContext(context)),
  );
  const discoveryToolApps = yield* Effect.cached(
    Effect.flatMap(sdk, (executor) =>
      executor.apps
        .list({ ids: permittedToolAppIds(policy), owner: organization.owner })
        .pipe(Effect.flatMap(visibleApps)),
    ).pipe(Effect.provideContext(context)),
  );
  const discoveryAccounts = yield* Effect.cached(
    Effect.flatMap(discoveryApps, (apps) => callerLinkedAccounts(apps.map((app) => app.id))).pipe(
      Effect.provideContext(context),
    ),
  );
  const discoveryAccess = yield* Effect.cached(
    Effect.gen(function* () {
      const apps = (yield* discoveryApps).filter((app) => permitsApp(policy, app.id));
      const ids = apps.map((app) => app.id);
      if (!Arr.isReadonlyArrayNonEmpty(ids)) return undefined;
      const read = yield* resourceAuthorityForAppsWithLinks(organization.organization, user, ids);
      return { ...read, apps };
    }).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.provideContext(context),
    ),
  );
  const accessFromDiscovery = (app: AppId) =>
    Effect.map(discoveryAccess, (read) =>
      read === undefined || !read.apps.some((listed) => listed.id === app)
        ? undefined
        : { access: read.access.find((policy) => policy.app === app) },
    );
  const searchReadsFor = (batch: ReadonlySet<AppId>) =>
    Effect.gen(function* () {
      const read = yield* discoveryAccess;
      if (read === undefined) return undefined;
      const selections = new Map(
        yield* Effect.forEach(
          read.apps.filter((app) => batch.has(app.id)),
          (app) =>
            Effect.map(
              Effect.exit(
                selectedAppFrom(
                  app,
                  read.access.find((policy) => policy.app === app.id),
                  read.links,
                ),
              ),
              (selected) => [app.id, selected] as const,
            ),
        ),
      );
      const targets = [...selections.values()].flatMap((selected) =>
        Exit.isSuccess(selected) && selected.value.app.activeVersion !== null
          ? [
              {
                app: selected.value.app.id,
                version: selected.value.app.activeVersion,
                accounts: selected.value.accounts,
              },
            ]
          : [],
      );
      const prefetched = yield* (yield* sdk)[PrefetchHost].searchable({
        owner: organization.owner,
        targets,
      });
      return { selections, prefetched };
    }).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.provideContext(context),
    );
  type SearchReads = Effect.Success<ReturnType<typeof searchReadsFor>>;
  const searchBatches = new Map<AppId, Effect.Effect<SearchReads>>();
  const searchReads = (app: AppId, batch: ReadonlyArray<AppId> | undefined) =>
    Effect.gen(function* () {
      if (batch === undefined || !batch.includes(app)) return undefined;
      const claimed = searchBatches.get(app);
      if (claimed !== undefined) return yield* claimed;
      const members = new Set<AppId>();
      const reads = yield* Effect.cached(Effect.suspend(() => searchReadsFor(members)));
      for (const member of batch)
        if (!searchBatches.has(member)) {
          members.add(member);
          searchBatches.set(member, reads);
        }
      return yield* searchBatches.get(app) ?? reads;
    });
  const explained = (error: AccountRequired) =>
    Effect.gen(function* () {
      if (error.scope !== "user" || user === undefined) return error;
      const { requirements } = yield* (yield* sdk).apps.version({
        owner: organization.owner,
        app: error.app,
        version: error.version,
      });
      const linked = linkedRequirements(
        requirements.accounts,
        "user",
        (yield* linkedAccounts(yield* policyDatabase, { subject: user, apps: [error.app] })).map(
          (link) => ({ requirement: link.requirement, account: link }),
        ),
      );
      const requirement = linked[error.slot];
      const refusal =
        requirement === undefined
          ? undefined
          : untargetedLinkRefusal(policy, error.app, { [error.slot]: requirement });
      return refusal === undefined ? error : new GrantForbidden({ refusal });
    }).pipe(Effect.provideContext(context));
  const grantRefusal = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(
      Effect.catchIf(
        (error: E) => Schema.is(AccountRequired)(error),
        (error) => Effect.flatMap(explained(error), Effect.fail),
      ),
    );
  const subscriber = Effect.gen(function* () {
    if (grant === undefined || user === undefined) return yield* new OrganizationForbidden();
    return { principal: grant, subject: user };
  });
  const eventApp = (app: AppId) =>
    Effect.gen(function* () {
      yield* authorizeApp(app);
      if (!(yield* discoveryApps).some((candidate) => candidate.id === app))
        return yield* new AppNotFound({ app });
      yield* requireAppAccess(app, "use");
    });
  const startCall = (
    input: Parameters<McpBackend<Error>["callTool"]>[0],
    options?: ToolInvocationOptions,
  ) =>
    Effect.gen(function* () {
      const owner = yield* currentOwner;
      const executor = yield* sdk;
      const ahead = yield* SelectionReadAhead;
      const read =
        ahead !== undefined && !requiresToolMetadata(policy.tools, input.app) ? ahead : undefined;
      const { version, accounts, kind } = yield* checkedToolCall(
        executor,
        owner,
        input,
        (selected, described) => authorizeTool({ ...input, ...selected }, described),
        read,
      );
      yield* recordCallDetails({ version, accounts, ...(kind === undefined ? {} : { kind }) });
      const call = executor.tools.call({ ...input, version, accounts, kind }, options);
      return yield* (yield* ConcurrentStatements) !== undefined
        ? call.pipe(Effect.provideService(InvocationSelection, { app: input.app, owner, accounts }))
        : call;
    });
  const backend = {
    findEventSubscription: (key) =>
      Effect.gen(function* () {
        const { principal } = yield* subscriber;
        const found = yield* (yield* sdk).events.find({ ...key, principal });
        return found !== null && found.owner === organization.owner ? found : null;
      }).pipe((work) => observe("findEventSubscription", work, "read")),
    subscribeEvent: ({ key, ...input }) =>
      Effect.gen(function* () {
        const { principal, subject } = yield* subscriber;
        const { target } = input;
        if (target.app !== null)
          yield* eventApp(target.app).pipe(
            Effect.catchTag("AppNotFound", () => Effect.fail(new EventNotFound({ kind: "event" }))),
          );
        return yield* (yield* sdk).events.subscribe({
          ...input,
          target:
            target.app === null
              ? { owner: organization.owner, app: null, event: null }
              : { app: target.app, event: target.event },
          key: { ...key, principal },
          subject,
        });
      }).pipe((work) => observe("subscribeEvent", work)),
    unsubscribeEvent: ({ key }) =>
      Effect.gen(function* () {
        const { principal } = yield* subscriber;
        yield* (yield* sdk).events.unsubscribe({ ...key, principal });
      }).pipe((work) => observe("unsubscribeEvent", work)),
    listSkills: (input, options) =>
      observe("listSkills", grantRefusal(listAppSkills(input, options)), "read"),
    bundleSkills: (input, options) =>
      observe("bundleSkills", grantRefusal(bundleAppSkills(input, options)), "read"),
    readSkill: (input) => observe("readSkill", grantRefusal(readAppSkill(input)), "read"),
    authorizeElicitation: (input) =>
      Effect.gen(function* () {
        const owner = yield* currentOwner;
        const executor = yield* sdk;
        const { version, accounts } = yield* selectedActiveVersion(executor, owner, input);
        yield* authorizeTool({ ...input, version, accounts }).pipe(
          Effect.mapError(() => new ElicitationFailed({ reason: "forbidden" })),
        );
      }).pipe(
        (work) => observe("authorizeElicitation", work),
        Effect.catchTags({
          OrganizationForbidden: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          AppNotFound: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          AccountRequired: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          AppNotDeployed: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          VersionNotFound: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          StorageError: () => Effect.fail(new ElicitationFailed({ reason: "transport" })),
        }),
      ),
    listApps: (input = {}) =>
      (input.toolsOnly ? discoveryToolApps : discoveryApps).pipe(
        Effect.map((apps) => {
          if (input.ids === undefined) return apps;
          const requested = new Set(input.ids);
          return apps.filter((app) => requested.has(app.id));
        }),
        (work) => observe("listApps", work, "read"),
      ),
    listAccounts: (input) =>
      Effect.gen(function* () {
        yield* authorizeApp(input.app);
        const discovered = yield* accessFromDiscovery(input.app);
        if (discovered === undefined) yield* requireAppAccess(input.app, "use");
        else if (discovered.access === undefined || !discovered.access.canUse)
          return yield* new OrganizationForbidden();
        const app = (yield* discoveryApps).find((app) => app.id === input.app);
        if (app === undefined) return yield* new AppNotFound({ app: input.app });
        const requirements =
          input.version === undefined || input.version === app.activeVersion
            ? app.requirements
            : (yield* (yield* sdk).apps.version({
                owner: organization.owner,
                app: app.id,
                version: input.version,
              })).requirements;
        return linkedRequirements(
          requirements.accounts,
          "user",
          (yield* discoveryAccounts)
            .filter((account) => account.app === app.id)
            .map((link) => ({ requirement: link.requirement, account: link })),
        );
      }).pipe((work) => observe("listAccounts", work, "read")),
    listTools: (input, options) =>
      observe("listTools", grantRefusal(listTools(input, options)), "read"),
    searchableTools: (input, options) =>
      Effect.gen(function* () {
        const reads = yield* searchReads(input.app, options?.searchBatch);
        const selected = reads?.selections.get(input.app);
        return yield* reads === undefined || selected === undefined
          ? searchableTools(input, options)
          : searchableTools(input, options, selected).pipe(
              Effect.provideService(SearchablePrefetch, reads.prefetched),
            );
      }).pipe((work) => observe("searchableTools", grantRefusal(work), "read")),
    searchTools: (input) => observe("searchTools", searchTools(input), "read"),
    callTool: (input, options?: ToolInvocationOptions) =>
      Effect.gen(function* () {
        const execution = yield* CurrentMcpExecution;
        const logged = yield* loggedToolCall(
          yield* caller(execution),
          input,
          true,
          grantRefusal(startCall(input, options)),
        );
        if (logged.reference !== undefined) (yield* ToolCallRecorded)?.(logged.reference);
        return yield* logged.exit;
      }).pipe((work) => observe("callTool", work)),
    resumeInvocation: (request, response, options?: ToolInvocationOptions) =>
      loggedToolResume(
        request.requestId,
        Effect.gen(function* () {
          yield* authorizeSavedTool(request.invocation);
          const owner = yield* currentOwner;
          yield* requireAppAccess(request.invocation.app, "use");
          const executor = yield* sdk;
          yield* checkInvocationAccounts(executor, owner, request.invocation);
          const usage = yield* CurrentUsage;
          return yield* executor.tools
            .resume({ requestId: request.requestId, owner, response }, options)
            .pipe(
              Effect.provideService(CurrentUsage, {
                ...usage,
                app_id: request.invocation.app,
                tool_name: request.invocation.tool,
              }),
            );
        }),
      ).pipe(
        Effect.flatMap(({ exit }) => exit),
        (work) => observe("resumeInvocation", work),
      ),
  } satisfies McpBackend<Error>;
  return backend;
});
