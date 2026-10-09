import {
  GrantId,
  GrantForbidden,
  deliveryRefusal,
  restrictMcpBackend,
  requestedMcpAddress,
} from "@executor-js/mcp-auth";
import { localRequest } from "./auth.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { LocalMcpUnauthorized, type LocalMcpOAuth } from "./mcp-oauth.ts";
/** Local access and documentation I/O for the shared MCP implementation. */
import {
  makeMcp,
  appTargets,
  refusedMcpRequest,
  type McpBackend,
  type McpLimits,
} from "@executor-js/mcp";
import { annotateSkillRead, executorIntro } from "@executor-js/app-templates/executor";
import {
  ElicitationFailed,
  type Executor,
  type ToolInvocationOptions,
} from "@executor-js/sdk/core";
import { Context, Effect, Redacted } from "effect";

/**
 * The local bearer key authorizes the whole instance. No hosted owner or role model is imposed.
 * Event subscriptions belong to `principal`, the grant that made them.
 */
export const localMcpBackend = (executor: Executor, principal: string) =>
  ({
    eventDefinitions: (input) => executor.events.definitions(input),
    findEventSubscription: (key) => executor.events.find({ ...key, principal }),
    subscribeEvent: ({ key, ...input }) =>
      executor.events.subscribe({ ...input, key: { ...key, principal }, subject: principal }),
    unsubscribeEvent: ({ key }) => executor.events.unsubscribe({ ...key, principal }),
    listSkills: (input) => executor.skills.list(input),
    readSkill: (input) => executor.skills.read(input),
    authorizeElicitation: () => Effect.void,
    listApps: (input = {}) => executor.apps.list(input),
    listTargets: (input) =>
      Effect.gen(function* () {
        const app = yield* executor.apps.get(input);
        return appTargets(
          app,
          yield* executor.apps.profiles.list(input),
          yield* executor.accounts.list({ owner: app.owner }),
        );
      }),
    listTools: (input, options) => executor.tools.list(input, options),
    callTool: (input, options?: ToolInvocationOptions) => executor.tools.call(input, options),
    resumeInvocation: (request, response, options?: ToolInvocationOptions) =>
      executor.tools.resume({ requestId: request.requestId, response }, options),
  }) satisfies McpBackend<Error>;

/** Resolve filesystem dependencies at the local edge; keep bearer/Origin checks on the host router. */
export const localMcp = (
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
        listTargets: () => Effect.fail(new LocalMcpUnauthorized()),
        listTools: () => Effect.fail(new LocalMcpUnauthorized()),
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
        listSkills: (input) => Effect.flatMap(RequestBackend, (b) => b.listSkills(input)),
        readSkill: (input) => Effect.flatMap(RequestBackend, (b) => b.readSkill(input)),
        listApps: (input) => Effect.flatMap(RequestBackend, (b) => b.listApps(input)),
        listTargets: (input) => Effect.flatMap(RequestBackend, (b) => b.listTargets(input)),
        listTools: (input, options) =>
          Effect.flatMap(RequestBackend, (b) => b.listTools(input, options)),
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
      const backend = restrictMcpBackend<Error, Error>(
        localMcpBackend(executor, grant.id),
        current,
      );
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
