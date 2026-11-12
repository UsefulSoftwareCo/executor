import {
  GrantId,
  GrantForbidden,
  McpWhoami,
  grantAuthorization,
  grantRefusal,
  restrictMcpBackend,
  requestedMcpAddress,
  targetedLinks,
  unrecordedRefusal,
  untargetedLinkRefusal,
  type ApprovalMode,
  type Grant,
  type McpAddress,
} from "@executor-js/mcp-auth";
import { Connection } from "@executor-js/mcp-auth/connections";
import { localBearer, localRequest } from "./auth.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { LocalMcpAuthUnavailable, LocalMcpUnauthorized, type LocalMcpOAuth } from "./mcp-oauth.ts";
/** Local access and documentation I/O for the shared MCP implementation. */
import { makeMcp, refusedMcpRequest, type McpBackend, type McpLimits } from "@executor-js/mcp";
import { annotateSkillRead, executorIntro } from "@executor-js/app-templates/executor";
import {
  ElicitationFailed,
  resolveLinkedAccounts,
  type AppId,
  type VersionId,
  type Executor,
  type ToolInvocationOptions,
} from "@executor-js/sdk/core";
import { appVersion, versionRequirementAccounts } from "./app-accounts.ts";
import type { SqlClient } from "effect/sql";
import { Context, Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";

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
        Effect.flatMap((app) => appVersion(executor, app, input.version)),
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
        version: version.version,
        appLinks,
        userLinks: targetedLinks(authority, version.app.id, linked),
      });
    });
  /** Calls and listings run on the active version; skill reads on the version they pin. */
  const resolved = <I extends { readonly app: AppId; readonly version?: VersionId | undefined }>(
    input: I,
    pinned: boolean,
  ) =>
    executor.apps.get({ app: input.app }).pipe(
      Effect.flatMap((app) => appVersion(executor, app, pinned ? input.version : undefined)),
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
    const Mode = Context.Reference<ApprovalMode | undefined>("local/McpMode", {
      defaultValue: () => undefined,
    });
    const mode = Effect.flatMap(Mode, (mode) =>
      mode === undefined
        ? Effect.die("MCP request has no authenticated approval mode")
        : Effect.succeed(mode),
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
      mode,
      instructions: executorIntro,
      limits,
      annotateSkillRead,
    });
    /**
     * The request's current grant. An OAuth grant serves the approval mode and connection its
     * record holds, whatever the URL names. The administrative key has no record: it has full
     * access in the URL's mode and never enters a connection.
     */
    const authorized = (authorization: string | undefined, headers: Headers, address: McpAddress) =>
      Effect.gen(function* () {
        if (localBearer(config, authorization)) {
          const refusal = unrecordedRefusal(address);
          if (refusal !== undefined) return yield* new GrantForbidden({ refusal });
          return {
            id: GrantId.make("local-administrator"),
            policy: { kind: "all" as const },
            target: { kind: "mcp" as const, mode: address.mode },
          } satisfies Grant;
        }
        const grant = (yield* oauth.authenticate(headers)).grant;
        const refusal = grantRefusal(grant);
        if (refusal !== undefined) return yield* new GrantForbidden({ refusal });
        return grant;
      });
    const refusals = {
      // Clients print a refusal's body after their own prefix, so typed refusals keep their cause.
      AuthForbidden: refusedMcpRequest,
      GrantForbidden: refusedMcpRequest,
      LocalMcpUnauthorized: () => oauth.challenge,
      LocalMcpAuthUnavailable: refusedMcpRequest,
    } as const;
    const http = Effect.gen(function* () {
      const request = yield* localRequest(config.port, config.browserOrigin);
      const address = requestedMcpAddress(new URL(request.url, oauth.origin));
      // A malformed URL names no MCP address, so no credential is checked against it.
      if (address === undefined) return oauth.invalidAddress;
      const current = authorized(
        request.headers.authorization,
        new Headers(request.headers),
        address,
      );
      const grant = yield* current;
      const backend = localMcpBackend(sql, executor, grant.id, current);
      return yield* host.http.pipe(
        Effect.provideService(RequestBackend, backend),
        Effect.provideService(Caller, grant.id),
        Effect.provideService(Mode, grant.target.kind === "mcp" ? grant.target.mode : undefined),
      );
    }).pipe(Effect.catchTags(refusals));
    /** `GET /mcp/whoami`: what the credential reaches, authenticated exactly as `/mcp` is. */
    const whoami = Effect.gen(function* () {
      const request = yield* localRequest(config.port, config.browserOrigin);
      const address = requestedMcpAddress(new URL(request.url, oauth.origin));
      if (address === undefined) return oauth.invalidAddress;
      const grant = yield* authorized(
        request.headers.authorization,
        new Headers(request.headers),
        address,
      );
      if (grant.target.kind !== "mcp") return yield* new LocalMcpUnauthorized();
      const target = grant.target;
      const apps = grant.policy.kind === "tools" ? grant.policy.apps.length : 0;
      const connection =
        target.connection === undefined
          ? undefined
          : (yield* oauth.connections.list.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Connection))),
              Effect.mapError(() => new LocalMcpAuthUnavailable()),
            )).find((item) => item.id === target.connection);
      // A connection revoked since authentication grants nothing.
      if (target.connection !== undefined && connection === undefined)
        return yield* new LocalMcpUnauthorized();
      return HttpServerResponse.jsonUnsafe(
        Schema.encodeSync(McpWhoami)({
          organization: null,
          access:
            connection !== undefined
              ? { kind: "connection", id: connection.id, name: connection.name, apps }
              : grant.policy.kind === "tools"
                ? { kind: "tools", apps }
                : { kind: "all" },
          mode: target.mode,
        }),
        { headers: { "cache-control": "no-store" } },
      );
    }).pipe(Effect.catchTags(refusals));
    return { http, whoami, approvals: host.approvals };
  });
