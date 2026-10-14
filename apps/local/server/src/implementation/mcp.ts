import {
  GrantId,
  GrantForbidden,
  deliveryRefusal,
  grantAuthorization,
  restrictMcpBackend,
  requestedMcpAddress,
  targetedLinks,
  untargetedLinkRefusal,
  type Grant,
} from "@executor-js/mcp-auth";
import { localRequest } from "./auth.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { LocalMcpUnauthorized, type LocalMcpOAuth } from "./mcp-oauth.ts";
/** Local access and documentation I/O for the shared MCP implementation. */
import { makeMcp, refusedMcpRequest, type McpBackend, type McpLimits } from "@executor-js/mcp";
import { annotateSkillRead, executorIntro } from "@executor-js/app-templates/executor";
import {
  ElicitationFailed,
  resolveLinkedAccounts,
  type AppId,
  type DeploymentId,
  type Executor,
  type ToolInvocationOptions,
} from "@executor-js/sdk/core";
import { appVersion, versionRequirementAccounts } from "./app-accounts.ts";
import type { SqlClient } from "effect/sql";
import { Context, Effect, Redacted } from "effect";

/**
 * Operations as the grant checked them: they run with exactly the accounts their input names.
 * Reached only through {@link localMcpBackend}, which fills those accounts first.
 */
const grantedBackend = (sql: SqlClient.SqlClient, executor: Executor, principal: string) =>
  ({
    eventDefinitions: (input) => executor.events.definitions(input),
    findEventSubscription: (key) => executor.events.find({ ...key, principal }),
    subscribeEvent: ({ key, ...input }) =>
      executor.events.subscribe({ ...input, key: { ...key, principal }, subject: principal }),
    unsubscribeEvent: ({ key }) => executor.events.unsubscribe({ ...key, principal }),
    listSkills: (input, options) => executor.skills.list(input, options),
    readSkill: (input) => executor.skills.read(input),
    authorizeElicitation: () => Effect.void,
    listApps: (input = {}) => executor.apps.list(input),
    listAccounts: (input) =>
      executor.apps.get({ app: input.app }).pipe(
        Effect.flatMap((app) => appVersion(executor, app, input.deployment)),
        // Agents see the user requirements' accounts only; the app's are its app links.
        Effect.flatMap((version) => versionRequirementAccounts(sql, executor, version)),
        Effect.map((accounts) => accounts.userLinks),
      ),
    listTools: (input, options) => executor.tools.list(input, options),
    searchableTools: (input, options) => executor.tools.searchable(input, options),
    searchTools: (input) => executor.tools.search(input),
    callTool: (input, options?: ToolInvocationOptions) => executor.tools.call(input, options),
    resumeInvocation: (request, response, options?: ToolInvocationOptions) =>
      executor.tools.resume({ requestId: request.requestId, response }, options),
  }) satisfies McpBackend<Error>;

/**
 * The local bearer key authorizes the whole instance. No hosted owner or role model is imposed.
 * Event subscriptions belong to `principal`, the grant that made them. Operations run with the
 * app links and the user links the current grant targets, resolved again on every call: the
 * accounts an operation names are replaced. The grant then checks the accounts the operation runs
 * with, so a link replaced since discovery is checked, not the one discovered. App accounts are
 * never grant targets: the SDK checks each against its current app link.
 * A resumed call keeps the accounts its approval reviewed.
 */
export const localMcpBackend = <G extends Error>(
  sql: SqlClient.SqlClient,
  executor: Executor,
  principal: string,
  current: Effect.Effect<Grant, G>,
): McpBackend<Error | G | GrantForbidden> => {
  const restricted = restrictMcpBackend<Error, G>(
    grantedBackend(sql, executor, principal),
    current,
  );
  const accounts = (version: Effect.Success<ReturnType<typeof appVersion>>) =>
    Effect.gen(function* () {
      const authority = grantAuthorization((yield* current).policy);
      const { appLinks, userLinks: linked } = yield* versionRequirementAccounts(
        sql,
        executor,
        version,
      );
      // A linked account the grant does not target is refused, not read as no account linked.
      const refusal = untargetedLinkRefusal(authority, version.app.id, linked);
      if (refusal !== undefined) return yield* new GrantForbidden({ refusal });
      return yield* resolveLinkedAccounts({
        app: version.app.id,
        deployment: version.deployment,
        appLinks,
        userLinks: targetedLinks(authority, version.app.id, linked),
      });
    });
  /** Calls and listings run on the active deployment; skill reads on the deployment they pin. */
  const resolved = <
    I extends { readonly app: AppId; readonly deployment?: DeploymentId | undefined },
  >(
    input: I,
    pinned: boolean,
  ) =>
    executor.apps.get({ app: input.app }).pipe(
      Effect.flatMap((app) => appVersion(executor, app, pinned ? input.deployment : undefined)),
      Effect.flatMap(accounts),
      Effect.map((accounts) => ({ ...input, accounts })),
    );
  return {
    ...restricted,
    listSkills: (input, options) =>
      resolved(input, true).pipe(Effect.flatMap((input) => restricted.listSkills(input, options))),
    readSkill: (input) =>
      resolved(input, true).pipe(Effect.flatMap((input) => restricted.readSkill(input))),
    listTools: (input, options) =>
      resolved(input, false).pipe(Effect.flatMap((input) => restricted.listTools(input, options))),
    searchableTools: (input, options) =>
      resolved(input, false).pipe(
        Effect.flatMap((input) => restricted.searchableTools(input, options)),
      ),
    callTool: (input, options) =>
      resolved(input, false).pipe(Effect.flatMap((input) => restricted.callTool(input, options))),
  };
};

/** Resolve filesystem dependencies at the local edge; keep bearer/Origin checks on the host router. */
export const localMcp = (
  sql: SqlClient.SqlClient,
  executor: Executor,
  limits: McpLimits,
  config: ServerConfig,
  oauth: LocalMcpOAuth,
) =>
  Effect.gen(function* () {
    const RequestBackend = Context.Reference<McpBackend<Error>>("local/McpBackend", {
      defaultValue: () => ({
        listSkills: () => Effect.fail(new LocalMcpUnauthorized()),
        readSkill: () => Effect.fail(new LocalMcpUnauthorized()),
        listApps: () => Effect.fail(new LocalMcpUnauthorized()),
        listAccounts: () => Effect.fail(new LocalMcpUnauthorized()),
        listTools: () => Effect.fail(new LocalMcpUnauthorized()),
        searchableTools: () => Effect.fail(new LocalMcpUnauthorized()),
        searchTools: () => Effect.fail(new LocalMcpUnauthorized()),
        callTool: () => Effect.fail(new LocalMcpUnauthorized()),
        resumeInvocation: () => Effect.fail(new LocalMcpUnauthorized()),
        authorizeElicitation: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
        eventDefinitions: () => Effect.fail(new LocalMcpUnauthorized()),
        findEventSubscription: () => Effect.fail(new LocalMcpUnauthorized()),
        subscribeEvent: () => Effect.fail(new LocalMcpUnauthorized()),
        unsubscribeEvent: () => Effect.fail(new LocalMcpUnauthorized()),
      }),
    });
    const Caller = Context.Reference<string | undefined>("local/McpCaller", {
      defaultValue: () => undefined,
    });
    // Programs belong to the caller across MCP sessions, so a request without one must not share a partition.
    const caller = Effect.flatMap(Caller, (grant) =>
      grant === undefined
        ? Effect.die("MCP request has no authenticated grant")
        : Effect.succeed(grant),
    );
    const host = yield* makeMcp({
      browser: {
        url: (address) =>
          Effect.map(caller, (caller) => {
            const url = new URL(`/mcp/approve/${address.requestId}`, oauth.origin);
            url.searchParams.set("sessionId", address.sessionId);
            url.searchParams.set("grantId", caller);
            return url.toString();
          }),
      },
      backend: {
        listSkills: (input, options) =>
          Effect.flatMap(RequestBackend, (b) => b.listSkills(input, options)),
        readSkill: (input) => Effect.flatMap(RequestBackend, (b) => b.readSkill(input)),
        listApps: (input) => Effect.flatMap(RequestBackend, (b) => b.listApps(input)),
        listAccounts: (input) => Effect.flatMap(RequestBackend, (b) => b.listAccounts(input)),
        listTools: (input, options) =>
          Effect.flatMap(RequestBackend, (b) => b.listTools(input, options)),
        searchableTools: (input, options) =>
          Effect.flatMap(RequestBackend, (b) => b.searchableTools(input, options)),
        searchTools: (input) => Effect.flatMap(RequestBackend, (b) => b.searchTools(input)),
        callTool: (input, options) =>
          Effect.flatMap(RequestBackend, (b) => b.callTool(input, options)),
        resumeInvocation: (request, response, options) =>
          Effect.flatMap(RequestBackend, (b) => b.resumeInvocation(request, response, options)),
        authorizeElicitation: (input) =>
          Effect.flatMap(RequestBackend, (b) => b.authorizeElicitation(input)),
        eventDefinitions: (input) =>
          Effect.flatMap(RequestBackend, (b) => b.eventDefinitions(input)),
        findEventSubscription: (key) =>
          Effect.flatMap(RequestBackend, (b) => b.findEventSubscription(key)),
        subscribeEvent: (input) => Effect.flatMap(RequestBackend, (b) => b.subscribeEvent(input)),
        unsubscribeEvent: (input) =>
          Effect.flatMap(RequestBackend, (b) => b.unsubscribeEvent(input)),
      },
      caller,
      instructions: executorIntro,
      limits,
      annotateSkillRead,
    });
    const http = Effect.gen(function* () {
      const request = yield* localRequest(config.port, config.browserOrigin);
      const address = requestedMcpAddress(new URL(request.url, oauth.origin));
      // A malformed URL names no MCP address, so no credential is checked against it.
      if (address === undefined) return oauth.invalidAddress;
      const current = Effect.gen(function* () {
        // The administrative key is full access on the plain URL only; it never enters a connection.
        const grant =
          request.headers.authorization === `Bearer ${Redacted.value(config.apiKey)}`
            ? {
                id: GrantId.make("local-administrator"),
                policy: { kind: "all" as const },
                target: { kind: "mcp" as const, mode: address.mode },
              }
            : (yield* oauth.authenticate(new Headers(request.headers))).grant;
        const refusal = deliveryRefusal(grant, address);
        if (refusal !== undefined) return yield* new GrantForbidden({ refusal });
        return grant;
      });
      const grant = yield* current;
      const backend = localMcpBackend(sql, executor, grant.id, current);
      return yield* host.http.pipe(
        Effect.provideService(RequestBackend, backend),
        Effect.provideService(Caller, grant.id),
      );
    }).pipe(
      Effect.catchTags({
        // Clients print a refusal's body after their own prefix, so typed refusals keep their cause.
        AuthForbidden: refusedMcpRequest,
        GrantForbidden: refusedMcpRequest,
        LocalMcpUnauthorized: () => oauth.challenge,
        LocalMcpAuthUnavailable: refusedMcpRequest,
      }),
    );
    return { http, approvals: host.approvals };
  });
