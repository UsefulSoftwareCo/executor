import { CurrentPolicy } from "../contracts/authorization.ts";
import {
  CurrentUsage,
  observeProductOperation,
  traceProductRead,
} from "../contracts/product-analytics.ts";
import { McpSchema } from "effect/ai";
import { authorizeApp, authorizeSavedTool, authorizeTool } from "./authorization.ts";
import { callerLinkedAccounts, linkedAccounts, requireConnectionAccounts } from "./app-accounts.ts";
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
  visibleAppAccesses,
  requireAppAccess,
} from "./resource-policy.ts";
/** Hosted catalog and execution policy for the shared MCP engine; no HTTP transport or credentials. */
import {
  CurrentMcpExecution,
  ToolCallRecorded,
  type McpBackend,
  type McpTargetInput,
} from "@executor-js/mcp";

import {
  AccountRequired,
  AppNotFound,
  ElicitationFailed,
  EventNotFound,
  InvocationSelection,
  CurrentCaller,
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
import { listTools, searchableKept, searchableTools, searchTools } from "./tools.ts";

import { listAppSkills, readAppSkill } from "./skills.ts";

/**
 * Bind one request's verified membership and lazy SDK. The host must authenticate
 * and check membership before supplying CurrentOrganization, on every request.
 * Do not retain this adapter in an MCP session or a process-global layer.
 */
export const hostedMcpBackend = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  const policy = yield* CurrentPolicy;
  const sdk = yield* HostedExecutor;
  const database = yield* GroupDatabase;
  const user = yield* CurrentUserId;
  const verifiedCaller = yield* CurrentCaller;
  const grant = yield* CurrentMcpGrant;
  const session = yield* CurrentMcpSession;
  const background = yield* HostedBackground;
  /**
   * The log's caller for a call in `execution`: an API key's synthetic grant names its key, any
   * other grant is the agent's. The session is recorded only when the call runs in an initialized
   * session, which the protocol server found by the ID it issued, and the ID has this server's form.
   */
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
    Context.add(CurrentCaller, verifiedCaller),
    Context.add(HostedBackground, background),
  );
  // Discovery reads are traced only; clients repeat them on every session and poll.
  const observe = <A, E, R>(
    operation: string,
    work: Effect.Effect<A, E, R>,
    kind: "read" | "operation" = "operation",
  ) =>
    Effect.gen(function* () {
      const current = yield* CurrentUsage;
      const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
      const properties = { area: "mcp", operation };
      return yield* (
        kind === "read"
          ? traceProductRead(properties, work)
          : observeProductOperation(properties, work)
      ).pipe(
        Effect.provideService(CurrentUsage, {
          ...current,
          source: "mcp",
          ...(Option.isSome(client)
            ? { client_name: client.value.clientInfo.name.slice(0, 100) }
            : {}),
        }),
        Effect.provideContext(context),
      );
    });
  // A single metadata snapshot feeds this request's catalog: the apps, with the caller's membership
  // and access to each read in the same statement. Discovery's listings check each app with that
  // access instead of reading it again; each call still checks the app and resolves the caller's
  // accounts again. Never retained beyond this request.
  const discoveryChecked = yield* Effect.cached(
    Effect.flatMap(sdk, (executor) =>
      executor.apps
        .list({ ids: permittedAppIds(policy), owner: organization.owner })
        .pipe(Effect.flatMap(visibleAppAccesses)),
    ).pipe(Effect.provideContext(context)),
  );
  const discoveryApps = Effect.map(discoveryChecked, (checked) => checked.map(({ app }) => app));
  // A tool permission is an app permission, so the tool apps are among the apps.
  const toolAppIds = permittedToolAppIds(policy);
  const discoveryToolApps = Effect.map(discoveryApps, (apps) =>
    toolAppIds === undefined ? apps : apps.filter((app) => toolAppIds.includes(app.id)),
  );
  /** The app and the caller's access, as this request's discovery read them. */
  const checkedApp = (app: AppId) =>
    Effect.map(discoveryChecked, (checked) => checked.find((entry) => entry.app.id === app));
  /** {@link checkedApp} for a listing, which reads the app itself when discovery could not. */
  const listedApp = (app: AppId) => Effect.orElseSucceed(checkedApp(app), () => undefined);
  // Resolve linked account labels once per request, even when discovery fans out over apps.
  const discoveryAccounts = yield* Effect.cached(
    Effect.flatMap(discoveryApps, (apps) => callerLinkedAccounts(apps.map((app) => app.id))).pipe(
      Effect.provideContext(context),
    ),
  );
  /**
   * The caller's access to every app the request lists for discovery, their links to them and
   * the apps' links, read in one statement once per request, when discovery first needs it, so
   * discovery does not check each app in a statement of its own. Each app is still decided on its
   * own from it, as its own reads would decide it. Undefined when the read did not answer: each
   * app then reads for itself.
   */
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
  /**
   * What search needs for the apps of one search batch: each app's selection decided from
   * {@link discoveryAccess}, then the SDK's reads for the target of every app that selected
   * (`PrefetchHost.searchable`), a fixed number of statements however many apps the batch has.
   * Only the batch's apps are read: a search must not wait on another app's rows, which a slow or
   * locked listing can hold. Undefined when the access read did not answer.
   */
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
  /**
   * Each app's search batch reads, made once per batch, when the first of its apps needs them. An
   * app belongs to the first batch that names it; a later batch naming it again reads the rest.
   */
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
      // Another read of the same batch may have claimed this app while the reads were made.
      return yield* searchBatches.get(app) ?? reads;
    });
  /**
   * An operation resolves the caller's links narrowed to the grant's targets, so a plain user
   * requirement whose links the grant does not target fails as `AccountRequired`. When the caller
   * did link an account for it, the grant refused that account: report that instead.
   */
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
  /** Event subscriptions belong to the request's grant and act for its user. */
  const subscriber = Effect.gen(function* () {
    if (grant === undefined || user === undefined) return yield* new OrganizationForbidden();
    return { principal: grant, subject: user };
  });
  /** The app is this organization's, visible to the caller, and theirs to use. */
  const eventApp = (app: AppId) =>
    Effect.gen(function* () {
      yield* authorizeApp(app);
      if (!(yield* discoveryApps).some((candidate) => candidate.id === app))
        return yield* new AppNotFound({ app });
      yield* requireAppAccess(app, "use");
    });
  /** The caller's linked accounts for one app, as `listAccounts` lists them. */
  const accountsOf = (input: McpTargetInput) =>
    Effect.gen(function* () {
      yield* authorizeApp(input.app);
      // Discovery lists only apps the caller may use, read with their membership in this
      // request; an app it does not list is checked again, so a refusal precedes not found.
      const app = (yield* checkedApp(input.app))?.app;
      if (app === undefined) {
        yield* requireAppAccess(input.app, "use");
        return yield* new AppNotFound({ app: input.app });
      }
      // A read pinned to a retained version resolves that version's requirements.
      const requirements =
        input.version === undefined || input.version === app.activeVersion
          ? app.requirements
          : (yield* (yield* sdk).apps.version({
              owner: organization.owner,
              app: app.id,
              version: input.version,
            })).requirements;
      // Only user requirements take the caller's links; without one, none are read.
      const linked = Object.values(requirements.accounts).some(
        (required) => required.scope === "user",
      )
        ? yield* discoveryAccounts
        : [];
      const accounts = linkedRequirements(
        requirements.accounts,
        "user",
        linked
          .filter((account) => account.app === app.id)
          .map((link) => ({ requirement: link.requirement, account: link })),
      );
      yield* requireConnectionAccounts(app.id, accounts);
      return accounts;
    });

  /** Check the call as discovery would, then make it with the caller's resolved accounts. */
  const startCall = (
    input: Parameters<McpBackend<Error>["callTool"]>[0],
    options?: ToolInvocationOptions,
  ) =>
    Effect.gen(function* () {
      const owner = yield* currentOwner;
      const executor = yield* sdk;
      // Under a read-only rule the grant check evaluates the app before the call reaches here,
      // so an app read made beside authentication would be older than that evaluation.
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
      // The check has finished: the call may read its state and recheck its accounts at once.
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
        // A saved subscription can name an app the caller no longer sees; to them it has no event.
        // A selection of every app is the organization's; each delivery checks its app.
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
    readSkill: (input) => observe("readSkill", grantRefusal(readAppSkill(input)), "read"),
    authorizeElicitation: (input) =>
      Effect.gen(function* () {
        const owner = yield* currentOwner;
        const executor = yield* sdk;
        const { version, accounts } = yield* selectedActiveVersion(executor, owner, input);
        // A tool whose permission cannot be confirmed cannot receive input.
        yield* authorizeTool({ ...input, version, accounts }).pipe(
          Effect.mapError(() => new ElicitationFailed({ reason: "forbidden" })),
        );
      }).pipe(
        (work) => observe("authorizeElicitation", work),
        Effect.catchTags({
          OrganizationForbidden: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          AppNotFound: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          AccountRequired: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          ConnectionAccountUnlinked: () =>
            Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
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
    listAccounts: (input) => observe("listAccounts", accountsOf(input), "read"),
    listAccountsEach: (input) =>
      observe(
        "listAccountsEach",
        Effect.forEach(input.apps, (app) => Effect.result(accountsOf({ app })), {
          concurrency: "unbounded",
        }),
        "read",
      ),
    listTools: (input, options) =>
      observe(
        "listTools",
        grantRefusal(
          Effect.flatMap(listedApp(input.app), (checked) => listTools(input, options, checked)),
        ),
        "read",
      ),
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
    searchableKept: (inputs) =>
      observe(
        "searchableKept",
        Effect.gen(function* () {
          const first = inputs[0];
          if (first === undefined) return [];
          const reads = yield* searchReads(
            first.app,
            inputs.map((input) => input.app),
          );
          if (reads === undefined) return inputs.map(() => undefined);
          const selections = new Map(
            [...reads.selections].flatMap(([app, selected]) =>
              Exit.isSuccess(selected) ? [[app, selected.value] as const] : [],
            ),
          );
          return yield* searchableKept(inputs, selections).pipe(
            Effect.provideService(SearchablePrefetch, reads.prefetched),
          );
        }),
        "read",
      ),
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
        // The agent is told the call's reference beside its outcome.
        if (logged.reference !== undefined) (yield* ToolCallRecorded)?.(logged.reference);
        return yield* logged.exit;
      }).pipe((work) => observe("callTool", work)),
    // The call's reference was given when the call paused; the resume reports its outcome only.
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
