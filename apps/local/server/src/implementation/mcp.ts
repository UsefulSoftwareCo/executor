import {
  GrantId,
  GrantForbidden,
  permitsDelivery,
  restrictMcpBackend,
  requestedMcpMode,
} from "@executor-js/mcp-auth";
import { localRequest } from "./auth.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { LocalMcpUnauthorized, type LocalMcpOAuth } from "./mcp-oauth.ts";
/** Local access and documentation I/O for the shared MCP implementation. */
import { makeMcp, appTargets, type McpBackend, type McpLimits } from "@executor-js/mcp";
import {
  ElicitationFailed,
  type Executor,
  type ToolInvocationOptions,
} from "@executor-js/sdk/core";
import { Context, Effect, Redacted } from "effect";
import { McpProtocol } from "effect/unstable/ai";
import { HttpServerResponse } from "effect/unstable/http";

/** The local bearer key authorizes the whole instance. No hosted owner or role model is imposed. */
export const localMcpBackend = (executor: Executor) =>
  ({
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
    listTools: (input) => executor.tools.list(input),
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
      }),
    });
    const Caller = Context.Reference<string>("local/McpCaller", {
      defaultValue: () => "unavailable",
    });
    const host = yield* makeMcp({
      browser: {
        url: (address) =>
          Effect.map(Caller, (caller) => {
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
        listTools: (input) => Effect.flatMap(RequestBackend, (b) => b.listTools(input)),
        callTool: (input, options) =>
          Effect.flatMap(RequestBackend, (b) => b.callTool(input, options)),
        resumeInvocation: (request, response, options) =>
          Effect.flatMap(RequestBackend, (b) => b.resumeInvocation(request, response, options)),
        authorizeElicitation: (input) =>
          Effect.flatMap(RequestBackend, (b) => b.authorizeElicitation(input)),
      },
      caller: Caller,
      limits,
      protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25],
    });
    const http = Effect.gen(function* () {
      const request = yield* localRequest(config.port, config.browserOrigin);
      const mode = requestedMcpMode(new URL(request.url, oauth.origin));
      if (mode === undefined) return yield* new GrantForbidden();
      const current = Effect.gen(function* () {
        const grant =
          request.headers.authorization === `Bearer ${Redacted.value(config.apiKey)}`
            ? {
                id: GrantId.make("local-administrator"),
                policy: { kind: "all" as const },
                target: { kind: "mcp" as const, mode },
              }
            : (yield* oauth.authenticate(new Headers(request.headers))).grant;
        if (!permitsDelivery(grant, mode)) return yield* new GrantForbidden();
        return grant;
      });
      const grant = yield* current;
      const backend = restrictMcpBackend<Error, Error>(localMcpBackend(executor), current);
      return yield* host.http.pipe(
        Effect.provideService(RequestBackend, backend),
        Effect.provideService(Caller, grant.id),
      );
    }).pipe(
      Effect.catchTags({
        AuthForbidden: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
        GrantForbidden: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
        LocalMcpUnauthorized: () => oauth.challenge,
        LocalMcpAuthUnavailable: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      }),
    );
    return { http, approvals: host.approvals };
  });
