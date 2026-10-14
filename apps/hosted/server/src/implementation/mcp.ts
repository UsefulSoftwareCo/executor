import { CurrentAuthorization } from "../contracts/authorization.ts";
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
  permittedAppIds,
  permittedToolAppIds,
  requiresToolMetadata,
} from "@executor-js/authorization";
import { GroupDatabase } from "../contracts/groups.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import { policyDatabase, visibleApps, requireAppAccess } from "./resource-policy.ts";
/** Hosted catalog and execution policy for the shared MCP engine; no HTTP transport or credentials. */
import type { McpBackend } from "@executor-js/mcp";
import {
  AccountRequired,
  AppNotFound,
  ElicitationFailed,
  EventNotFound,
  InvocationSelection,
  linkedRequirements,
  type AppId,
  type ToolInvocationOptions,
} from "@executor-js/sdk/core";
import { Context, Effect, Option, Schema } from "effect";
import {
  checkedToolCall,
  currentOwner,
  selectedActiveDeployment,
  checkInvocationAccounts,
  SelectionReadAhead,
} from "./access.ts";
import { ConcurrentStatements, HostedExecutor } from "../contracts/executor.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import { CurrentMcpGrant } from "../contracts/mcp.ts";
import { listTools, searchableTools, searchTools } from "./tools.ts";
import { listAppSkills, readAppSkill } from "./skills.ts";

/**
 * Bind one request's verified membership and lazy SDK. The host must authenticate
 * and check membership before supplying CurrentOrganization, on every request.
 * Do not retain this adapter in an MCP session or a process-global layer.
 */
export const hostedMcpBackend = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  const policy = yield* CurrentAuthorization;
  const sdk = yield* HostedExecutor;
  const database = yield* GroupDatabase;
  const user = yield* CurrentUserId;
  const grant = yield* CurrentMcpGrant;
  const context = Context.make(CurrentOrganization, organization).pipe(
    Context.add(HostedExecutor, sdk),
    Context.add(CurrentAuthorization, policy),
    Context.add(GroupDatabase, database),
    Context.add(CurrentUserId, user),
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
  // A single metadata snapshot feeds this request's catalog. Each call still checks the app and
  // resolves the caller's accounts again.
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
  // Resolve linked account labels once per request, even when discovery fans out over apps.
  const discoveryAccounts = yield* Effect.cached(
    Effect.flatMap(discoveryApps, (apps) => callerLinkedAccounts(apps.map((app) => app.id))).pipe(
      Effect.provideContext(context),
    ),
  );
  /**
   * An operation resolves the caller's links narrowed to the grant's targets, so a plain user
   * requirement whose links the grant does not target fails as `AccountRequired`. When the caller
   * did link an account for it, the grant refused that account: report that instead.
   */
  const explained = (error: AccountRequired) =>
    Effect.gen(function* () {
      if (error.scope !== "user" || user === undefined) return error;
      const { requirements } = yield* (yield* sdk).apps.deployment({
        owner: organization.owner,
        app: error.app,
        deployment: error.deployment,
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
  const backend = {
    eventDefinitions: (input) =>
      Effect.gen(function* () {
        yield* eventApp(input.app);
        return yield* (yield* sdk).events.definitions(input);
      }).pipe((work) => observe("eventDefinitions", work, "read")),
    findEventSubscription: (key) =>
      Effect.gen(function* () {
        const { principal } = yield* subscriber;
        const found = yield* (yield* sdk).events.find({ ...key, principal });
        return found !== null && found.owner === organization.owner ? found : null;
      }).pipe((work) => observe("findEventSubscription", work, "read")),
    subscribeEvent: ({ key, ...input }) =>
      Effect.gen(function* () {
        const { principal, subject } = yield* subscriber;
        // A saved subscription can name an app the caller no longer sees; to them it has no event.
        yield* eventApp(input.target.app).pipe(
          Effect.catchTag("AppNotFound", () => Effect.fail(new EventNotFound({ kind: "event" }))),
        );
        return yield* (yield* sdk).events.subscribe({
          ...input,
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
        const { deployment, accounts } = yield* selectedActiveDeployment(executor, owner, input);
        // A tool whose permission cannot be confirmed cannot receive input.
        yield* authorizeTool({ ...input, deployment, accounts }).pipe(
          Effect.mapError(() => new ElicitationFailed({ reason: "forbidden" })),
        );
      }).pipe(
        (work) => observe("authorizeElicitation", work),
        Effect.catchTags({
          OrganizationForbidden: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          AppNotFound: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          AccountRequired: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          AppNotDeployed: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          DeploymentNotFound: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
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
        yield* requireAppAccess(input.app, "use");
        const app = (yield* discoveryApps).find((app) => app.id === input.app);
        if (app === undefined) return yield* new AppNotFound({ app: input.app });
        // A read pinned to a retained deployment resolves that deployment's requirements.
        const requirements =
          input.deployment === undefined || input.deployment === app.activeDeployment
            ? app.requirements
            : (yield* (yield* sdk).apps.deployment({
                owner: organization.owner,
                app: app.id,
                deployment: input.deployment,
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
      observe("searchableTools", grantRefusal(searchableTools(input, options)), "read"),
    searchTools: (input) => observe("searchTools", searchTools(input), "read"),
    callTool: (input, options?: ToolInvocationOptions) =>
      Effect.gen(function* () {
        const owner = yield* currentOwner;
        const executor = yield* sdk;
        // Under a read-only rule the grant check evaluates the app before the call reaches here,
        // so an app read made beside authentication would be older than that evaluation.
        const ahead = yield* SelectionReadAhead;
        const read =
          ahead !== undefined && !requiresToolMetadata(policy.tools, input.app) ? ahead : undefined;
        const { deployment, accounts, kind } = yield* checkedToolCall(
          executor,
          owner,
          input,
          (selected, described) => authorizeTool({ ...input, ...selected }, described),
          read,
        );
        const call = executor.tools.call({ ...input, deployment, accounts, kind }, options);
        // The check has finished: the call may read its state and recheck its accounts at once.
        return yield* (yield* ConcurrentStatements) !== undefined
          ? call.pipe(
              Effect.provideService(InvocationSelection, { app: input.app, owner, accounts }),
            )
          : call;
      }).pipe(grantRefusal, (work) => observe("callTool", work)),
    resumeInvocation: (request, response, options?: ToolInvocationOptions) =>
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
      }).pipe((work) => observe("resumeInvocation", work)),
  } satisfies McpBackend<Error>;
  return backend;
});
