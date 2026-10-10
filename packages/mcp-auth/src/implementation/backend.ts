/** Apply one grant at every shared MCP operation; hosts retain their existing resource checks. */
import type { McpBackend } from "@executor-js/mcp";
import {
  ElicitationFailed,
  type AppId,
  type Cursor,
  type DeploymentId,
  type ProfileId,
  type ToolName,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import {
  permitsApp,
  permitsEvent,
  permitsTarget,
  permitsRouter,
  permitsTool,
  permittedAppIds,
  requiresToolMetadata,
  type AuthorizationPolicy,
} from "@executor-js/authorization";
import {
  GrantForbidden,
  grantAuthorization,
  type Grant,
  type GrantRefusal,
} from "../contracts/grant.ts";

/** The exact tool an operation would run, before its live read-only flag is known. */
interface Invocation {
  readonly app: AppId;
  readonly tool: ToolName;
  readonly profile?: ProfileId | undefined;
  readonly expectedProfileRevision?: number | undefined;
  readonly deployment?: DeploymentId | undefined;
}

/** Re-read authority per operation, including while an execution resumes within one HTTP call. */
export const restrictMcpBackend = <E extends Error, G extends Error>(
  backend: McpBackend<E>,
  current: Effect.Effect<Grant, G>,
): McpBackend<E | G | GrantForbidden> => {
  const authority = current.pipe(Effect.map((grant) => grantAuthorization(grant.policy)));
  const refuse = (refusal: GrantRefusal | undefined) =>
    refusal === undefined ? Effect.void : Effect.fail(new GrantForbidden({ refusal }));
  /** The app, then how it runs: the first one the grant excludes, if either is. */
  const appRefusal = (
    policy: AuthorizationPolicy,
    app: AppId,
    profile: ProfileId | undefined,
  ): GrantRefusal | undefined =>
    !permitsApp(policy, app)
      ? { reason: "app", app }
      : !permitsTarget(policy, app, profile)
        ? { reason: "target", app, ...(profile === undefined ? {} : { profile }) }
        : undefined;
  const checkApp = (app: AppId, profile: ProfileId | undefined) =>
    authority.pipe(Effect.flatMap((policy) => refuse(appRefusal(policy, app, profile))));
  /** Find one tool in the live catalog this invocation would use, pinned to its deployment. */
  const describe = (input: Invocation) =>
    Effect.gen(function* () {
      let cursor: Cursor | undefined;
      let deployment = input.deployment;
      do {
        const page = yield* backend.listTools({
          app: input.app,
          profile: input.profile,
          expectedProfileRevision: input.expectedProfileRevision,
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
   * a read-only rule reads the live catalog, and the call then runs on that same deployment.
   */
  const authorize = (policy: AuthorizationPolicy, input: Invocation) =>
    Effect.gen(function* () {
      const request = { app: input.app, profile: input.profile, tool: { name: input.tool } };
      // A refused tool names its app or runs-as target instead when the grant excludes those.
      const toolRefusal = (allowed: boolean): GrantRefusal | undefined => {
        if (allowed) return undefined;
        const excluded = appRefusal(policy, input.app, input.profile);
        return excluded === undefined
          ? { reason: "tool", app: input.app, tool: input.tool }
          : excluded;
      };
      if (!requiresToolMetadata(policy.tools, input.app)) {
        yield* refuse(toolRefusal(permitsTool(policy, request)));
        return input.deployment;
      }
      // An unknown tool or a missing flag is never read-only.
      const described = yield* describe(input);
      yield* refuse(
        toolRefusal(
          described !== undefined && permitsTool(policy, { ...request, tool: described.tool }),
        ),
      );
      return described?.deployment;
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
      checkApp(input.app, input.profile).pipe(
        Effect.andThen(() => backend.listSkills(input, options)),
      ),
    readSkill: (input) =>
      checkApp(input.app, input.profile).pipe(Effect.andThen(() => backend.readSkill(input))),
    listApps: (input) =>
      Effect.gen(function* () {
        const grant = yield* authority;
        const ids = permittedAppIds(grant, input?.ids);
        return yield* backend.listApps({ ids });
      }),
    listTargets: (input) =>
      Effect.gen(function* () {
        const policy = yield* authority;
        yield* refuse(
          permitsApp(policy, input.app) ? undefined : { reason: "app", app: input.app },
        );
        const targets = yield* backend.listTargets(input);
        return targets.filter((target) =>
          permitsTarget(policy, input.app, target.kind === "app" ? undefined : target.id),
        );
      }),
    listTools: (input, options) =>
      Effect.gen(function* () {
        yield* checkApp(input.app, input.profile);
        const page = yield* backend.listTools(input, options);
        const policy = yield* authority;
        return {
          ...page,
          items: page.items.filter((tool) =>
            permitsTool(policy, { app: input.app, profile: input.profile, tool }, "discover"),
          ),
          routers: page.routers.filter((router) =>
            permitsRouter(
              policy,
              { app: input.app, profile: input.profile, path: router.path },
              page.items,
            ),
          ),
        };
      }),
    callTool: (input, options) =>
      Effect.gen(function* () {
        const deployment = yield* check(input);
        return yield* backend.callTool(
          deployment === undefined ? input : { ...input, deployment },
          options,
        );
      }),
    resumeInvocation: (request, response, options) =>
      check({
        app: request.invocation.app,
        tool: request.invocation.tool,
        profile: request.invocation.profile,
        expectedProfileRevision: request.invocation.profileRevision,
        deployment: request.invocation.deployment,
      }).pipe(Effect.andThen(() => backend.resumeInvocation(request, response, options))),
    authorizeElicitation: (input) =>
      check(input).pipe(
        Effect.mapError(() => new ElicitationFailed({ reason: "forbidden" })),
        Effect.andThen(() => backend.authorizeElicitation(input)),
      ),
  };
};
