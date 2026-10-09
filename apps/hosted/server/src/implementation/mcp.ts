import { CurrentAuthorization } from "../contracts/authorization.ts";
import {
  CurrentUsage,
  observeProductOperation,
  traceProductRead,
} from "../contracts/product-analytics.ts";
import { McpSchema } from "effect/ai";
import { authorizeTool, authorizeApp } from "./authorization.ts";
import { permittedAppIds } from "@executor-js/authorization";
import { GroupDatabase } from "../contracts/groups.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import { visibleApps, visibleAccounts, requireAppAccess } from "./resource-policy.ts";
/** Hosted catalog and execution policy for the shared MCP engine; no HTTP transport or credentials. */
import { appTargets, type McpBackend } from "@executor-js/mcp";
import {
  AppNotFound,
  ElicitationFailed,
  type AppId,
  type ToolInvocationOptions,
} from "@executor-js/sdk/core";
import { Context, Effect, Option } from "effect";
import {
  currentOwner,
  selectedApp,
  selectedActiveDeployment,
  ownProfile,
  checkInvocationAccounts,
} from "./access.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import { CurrentMcpGrant } from "../contracts/mcp.ts";
import { listTools } from "./tools.ts";
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
  // Resolve account labels once per request, even when target discovery fans out.
  // These records never authorize a tool call; selectedApp and SDK lifecycle checks do.
  const discoveryAccounts = yield* Effect.cached(
    Effect.flatMap(sdk, (executor) =>
      executor.accounts.list({ owner: organization.owner }).pipe(Effect.flatMap(visibleAccounts)),
    ).pipe(Effect.provideContext(context)),
  );
  // A single metadata snapshot feeds this request's catalog. Inspection still
  // verifies the selected profile revision and current app/account permissions.
  const discoveryApps = yield* Effect.cached(
    Effect.flatMap(sdk, (executor) =>
      executor.apps
        .list({ ids: permittedAppIds(policy), owner: organization.owner })
        .pipe(Effect.flatMap(visibleApps)),
    ).pipe(Effect.provideContext(context)),
  );
  const discoveryProfiles = yield* Effect.cached(
    Effect.gen(function* () {
      if (user === undefined) return yield* new OrganizationForbidden();
      const apps = yield* discoveryApps;
      const executor = yield* sdk;
      return yield* executor.apps.profiles.listMany({
        apps: apps.map((app) => app.id),
        owner: organization.owner,
        subject: user,
      });
    }).pipe(Effect.provideContext(context)),
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
        yield* eventApp(input.target.app);
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
    listSkills: (input) => observe("listSkills", listAppSkills(input), "read"),
    readSkill: (input) => observe("readSkill", readAppSkill(input), "read"),
    authorizeElicitation: (input) =>
      Effect.gen(function* () {
        const owner = yield* currentOwner;
        const executor = yield* sdk;
        yield* selectedApp(executor, owner, input.app, input.profile);
        // A tool whose permission cannot be confirmed cannot receive input.
        yield* authorizeTool(input).pipe(
          Effect.mapError(() => new ElicitationFailed({ reason: "forbidden" })),
        );
        if (input.profile !== undefined && input.expectedProfileRevision !== undefined) {
          const profile = yield* ownProfile(executor, owner, input.app, input.profile);
          if (profile.revision !== input.expectedProfileRevision)
            return yield* new ElicitationFailed({ reason: "forbidden" });
        }
      }).pipe(
        (work) => observe("authorizeElicitation", work),
        Effect.catchTags({
          OrganizationForbidden: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          AppNotFound: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          AccountNotFound: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
          StorageError: () => Effect.fail(new ElicitationFailed({ reason: "transport" })),
        }),
      ),
    listApps: (input = {}) =>
      discoveryApps.pipe(
        Effect.map((apps) => {
          if (input.ids === undefined) return apps;
          const requested = new Set(input.ids);
          return apps.filter((app) => requested.has(app.id));
        }),
        (work) => observe("listApps", work, "read"),
      ),
    listTargets: (input) =>
      Effect.gen(function* () {
        yield* authorizeApp(input.app);
        yield* requireAppAccess(input.app, "use");
        const app = (yield* discoveryApps).find((app) => app.id === input.app);
        if (app === undefined) return yield* new AppNotFound({ app: input.app });
        const profiles = (yield* discoveryProfiles).filter((profile) => profile.app === input.app);
        const accounts = yield* discoveryAccounts;
        return appTargets(app, profiles, accounts);
      }).pipe((work) => observe("listTargets", work, "read")),
    listTools: (input, options) => observe("listTools", listTools(input, options), "read"),
    callTool: (input, options?: ToolInvocationOptions) =>
      Effect.gen(function* () {
        const owner = yield* currentOwner;
        const executor = yield* sdk;
        const deployment = yield* selectedActiveDeployment(executor, owner, input);
        yield* authorizeTool({ ...input, deployment });
        return yield* executor.tools.call({ ...input, deployment }, options);
      }).pipe((work) => observe("callTool", work)),
    resumeInvocation: (request, response, options?: ToolInvocationOptions) =>
      Effect.gen(function* () {
        yield* authorizeTool({
          ...request.invocation,
          expectedProfileRevision: request.invocation.profileRevision,
        });
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
