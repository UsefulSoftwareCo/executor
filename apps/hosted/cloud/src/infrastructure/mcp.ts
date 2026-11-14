/** Native Effect MCP protocol sessions; product data and grants stay in Postgres. */
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { traceHeaders } from "@executor-js/telemetry";
import {
  McpAuthentication,
  authenticatedMcp,
  browserMcpRequest,
  callerSpanAttributes,
  mcpChallenge,
  mcpSessionKey,
} from "@executor-js/hosted-server";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { HttpServerError } from "effect/http/HttpServerError";
import {
  answerMemoryLimit,
  forwardMcpRequest,
  refuseTooDeep,
} from "../implementation/mcp-forward.ts";
import { mcpRequestAttributes, parseMcpBody } from "../implementation/mcp-request-method.ts";
import {
  mcpSessionNotFound,
  sessionOrganizationHeader,
  verifyMcpSessionId,
} from "../implementation/mcp-session-id.ts";
import { timedForward } from "../implementation/mcp-session-timing.ts";
import { observeMcpStream } from "../implementation/mcp-stream-observability.ts";
import type { McpSessionObject } from "./mcp-session.ts";
import { mcpSessionKeys } from "./mcp-session-keys.ts";
import { McpServer } from "./mcp-server-worker.ts";

/**
 * The gateway selects one private object per authenticated user/client/organization. The MCP
 * server Worker hosts them, so a wake never starts the API Worker. An object keeps its MCP
 * sessions' negotiated protocol state in its storage (`mcp-session-store.ts`), so a session
 * continues after the object is evicted or redeployed; programs and connections live in memory.
 */
export class McpSession extends Cloudflare.DurableObject<McpSession, McpSessionObject>()(
  "McpSession",
) {}

/** The namespace's native binding, for addressing an object by the id it issued. */
export const SessionNamespace = Schema.declare(
  (value): value is Pick<DurableObjectNamespace, "get" | "idFromName" | "idFromString"> =>
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function" &&
    "idFromName" in value &&
    typeof value.idFromName === "function" &&
    "idFromString" in value &&
    typeof value.idFromString === "function",
);

/**
 * Resolve the session binding at startup; return a handler for each request.
 *
 * A request without a session id (initialize, the stateless 2026-07-28 protocol, approvals) is
 * authenticated here and sent to the object its user/client/organization/grant names. A request
 * inside a session is sent to the object its signed id names, with no bearer check and no
 * database here: the object checks the bearer and that the bearer's key names it before any work.
 */
export const cloudMcp = Effect.gen(function* () {
  const sessions = yield* McpSession.from(McpServer);
  const environment = yield* Cloudflare.WorkerEnvironment;
  const keys = yield* mcpSessionKeys;
  /**
   * Forward one request to its session object. An authenticated request's forward names its
   * organization and user from the start, so a forward the object never answers still names them;
   * one routed by its session id learns only the organization, from the object's answer.
   */
  const send = (
    route:
      | {
          readonly kind: "authenticated";
          readonly caller: ReturnType<typeof callerSpanAttributes>;
        }
      | { readonly kind: "session" },
    /** An approval page's request carries no JSON-RPC message. */
    carries: "json-rpc" | "approval",
    fetch: (
      attempt: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError>,
  ) =>
    Effect.flatMap(Effect.option(Effect.currentSpan), (server) =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan(
          route.kind === "authenticated"
            ? { "executor.mcp.route": route.kind, ...route.caller }
            : { "executor.mcp.route": route.kind },
        );
        const request = yield* HttpServerRequest.HttpServerRequest;
        // Read from a copy, so the forwarded body is untouched; only a lost response and the
        // method attributes need it.
        const body = parseMcpBody(
          request.method === "POST"
            ? yield* HttpServerRequest.toWeb(request).pipe(
                Effect.flatMap((web) => Effect.tryPromise(() => web.clone().text())),
                Effect.option,
                Effect.map(Option.getOrUndefined),
              )
            : undefined,
        );
        if (carries === "json-rpc" && request.method === "POST") {
          // Both the forward and the gateway's request span, which records the response status.
          const attributes = mcpRequestAttributes(body);
          yield* Effect.annotateCurrentSpan(attributes);
          if (Option.isSome(server))
            for (const [key, value] of Object.entries(attributes))
              server.value.attribute(key, value);
        }
        return yield* Effect.gen(function* () {
          const headers = yield* traceHeaders;
          const traced = request.modify({ headers: { ...request.headers, ...headers } });
          const response = yield* refuseTooDeep(
            forwardMcpRequest(traced, (attempt) => timedForward(fetch(attempt))),
          );
          // A request routed by its session id learns its organization here, from the object,
          // which sets it once the bearer's own key names it. Its user is on the object's spans.
          const organization = response.headers[sessionOrganizationHeader];
          if (organization !== undefined)
            yield* Effect.annotateCurrentSpan("executor.organization.id", organization);
          return HttpServerResponse.removeHeader(response, sessionOrganizationHeader);
        }).pipe(Effect.flatMap(observeMcpStream("gateway")), answerMemoryLimit(body));
      }).pipe(Effect.withSpan("mcp.session.forward")),
    );
  const forward =
    (carries: "json-rpc" | "approval") => (access: Parameters<typeof mcpSessionKey>[0]) => {
      const caller = callerSpanAttributes(access.access.organization, access.userId);
      return Effect.annotateCurrentSpan(caller).pipe(
        Effect.andThen(
          send({ kind: "authenticated", caller }, carries, (attempt) =>
            sessions.getByName(mcpSessionKey(access)).fetch(attempt),
          ),
        ),
      );
    };
  const inSession = (value: string) =>
    Effect.gen(function* () {
      const auth = yield* McpAuthentication;
      const request = yield* HttpServerRequest.HttpServerRequest;
      // Programmatic clients have no Origin. Untrusted browser pages cannot call MCP.
      if (request.headers.origin !== undefined && request.headers.origin !== auth.origin)
        return HttpServerResponse.empty({ status: 403 });
      // A request with no bearer is refused here, as before, so it cannot wake the object.
      if (!/^Bearer \S+$/iu.test(request.headers.authorization ?? "")) {
        yield* Effect.annotateCurrentSpan("executor.mcp.session_id", "unauthenticated");
        return yield* mcpChallenge;
      }
      const address = yield* verifyMcpSessionId(yield* keys, value);
      if (Option.isNone(address)) {
        yield* Effect.annotateCurrentSpan("executor.mcp.session_id", "refused");
        return mcpSessionNotFound();
      }
      const namespace = yield* Schema.decodeUnknownEffect(SessionNamespace)(
        environment.McpSession,
      ).pipe(Effect.orDie);
      // Only ids this namespace generated are signed, so this refuses only an id minted under a
      // namespace the class has since moved from; its sessions are gone with that namespace.
      const id = yield* Effect.try(() => namespace.idFromString(address.value.objectId)).pipe(
        Effect.option,
      );
      if (Option.isNone(id)) {
        yield* Effect.annotateCurrentSpan("executor.mcp.session_id", "unroutable");
        return mcpSessionNotFound();
      }
      const object = Cloudflare.fromCloudflareFetcher(namespace.get(id.value));
      return yield* send({ kind: "session" }, "json-rpc", (attempt) => object.fetch(attempt));
    }).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")));
  return {
    http: Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      const session = request.headers["mcp-session-id"];
      return session === undefined ? authenticatedMcp(forward("json-rpc")) : inSession(session);
    }),
    approvals: browserMcpRequest(forward("approval")),
  };
});
