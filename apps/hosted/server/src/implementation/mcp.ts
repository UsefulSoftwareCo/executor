import { CurrentAuthorization } from "../contracts/authorization.ts";
import { CurrentUsage, observeProductOperation } from "../contracts/product-analytics.ts";
import { McpSchema } from "effect/unstable/ai";
import { authorizeTool, authorizeApp } from "./authorization.ts";
import { permittedAppIds } from "@executor-js/authorization";
import { GroupDatabase } from "../contracts/groups.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import {
  visibleApps,
  visibleAccounts,
  currentResourceAuthority,
  requireAppAccess,
} from "./resource-policy.ts";
/** Hosted catalog and execution policy for the shared MCP engine; no HTTP transport or credentials. */
import { appTargets, type McpBackend } from "@executor-js/mcp";
import { ElicitationFailed, type ToolInvocationOptions } from "@executor-js/sdk/core";
import { Context, Effect, Option } from "effect";
import { currentOwner, selectedApp, ownProfile, checkInvocationAccounts } from "./access.ts";
import { OrganizationDefaults } from "../contracts/organization-defaults.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { CurrentOrganization } from "../contracts/organization.ts";
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
  const initialize = yield* OrganizationDefaults;
  const context = Context.make(CurrentOrganization, organization).pipe(
    Context.add(HostedExecutor, sdk),
    Context.add(CurrentAuthorization, policy),
    Context.add(GroupDatabase, database),
    Context.add(CurrentUserId, user),
  );
  const observe = <A, E, R>(operation: string, work: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const current = yield* CurrentUsage;
      const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
      return yield* observeProductOperation({ area: "mcp", operation }, work).pipe(
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
  const backend = {
    listSkills: (input) => observe("listSkills", listAppSkills(input)),
    readSkill: (input) => observe("readSkill", readAppSkill(input)),
    authorizeElicitation: (input) =>
      Effect.gen(function* () {
        yield* authorizeTool(input.app, input.tool);
        const owner = yield* currentOwner;
        yield* requireAppAccess(input.app, "use");
        const executor = yield* sdk;
        yield* selectedApp(executor, owner, input.app, input.profile);
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
      (policy.tools.kind === "all" ? initialize(organization.organization) : Effect.void).pipe(
        Effect.andThen(
          Effect.flatMap(sdk, (executor) =>
            executor.apps
              .list({ ids: permittedAppIds(policy, input.ids), owner: organization.owner })
              .pipe(Effect.flatMap(visibleApps), Effect.provideContext(context)),
          ),
        ),
        (work) => observe("listApps", work),
      ),
    listTargets: (input) =>
      Effect.gen(function* () {
        yield* authorizeApp(input.app);
        yield* requireAppAccess(input.app, "use");
        const actor = yield* currentResourceAuthority,
          owner = yield* currentOwner,
          executor = yield* sdk;
        const app = yield* executor.apps.get({ ...input, owner });
        const profiles = yield* executor.apps.profiles.list({
          ...input,
          owner,
          subject: actor.user,
        });
        const accounts = yield* executor.accounts
          .list({ owner })
          .pipe(Effect.flatMap(visibleAccounts));
        return appTargets(app, profiles, accounts);
      }).pipe((work) => observe("listTargets", work)),
    listTools: (input) => observe("listTools", listTools(input)),
    callTool: (input, options?: ToolInvocationOptions) =>
      Effect.gen(function* () {
        yield* authorizeTool(input.app, input.tool);
        const owner = yield* currentOwner;
        yield* requireAppAccess(input.app, "use");
        const executor = yield* sdk;
        yield* selectedApp(executor, owner, input.app, input.profile);
        return yield* executor.tools.call(input, options);
      }).pipe((work) => observe("callTool", work)),
    resumeInvocation: (request, response, options?: ToolInvocationOptions) =>
      Effect.gen(function* () {
        yield* authorizeTool(request.invocation.app, request.invocation.tool);
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
