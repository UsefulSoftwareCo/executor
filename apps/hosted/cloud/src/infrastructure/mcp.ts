/** Native Effect MCP protocol sessions; product data and grants stay in Postgres. */
import { traceHeaders } from "@executor-js/telemetry";
import {
  McpAuthentication,
  authenticatedMcp,
  browserMcpRequest,
  mcpChallenge,
  mcpSessionKey,
} from "@executor-js/hosted-server";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { HttpServerError } from "effect/http/HttpServerError";
import { forwardMcpRequest } from "../implementation/mcp-forward.ts";
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
import { durableNamespace, inJurisdiction } from "./jurisdiction.ts";

/**
 * The gateway selects one private object per authenticated user/client/organization. The MCP
 * server Worker hosts them, so a wake never starts the API Worker. An object keeps its MCP
 * sessions' negotiated protocol state in its storage (`mcp-session-store.ts`), so a session
 * continues after the object is evicted or redeployed; programs and connections live in memory.
 */
export class McpSession extends Cloudflare.DurableObject<McpSession, McpSessionObject>()(
  "McpSession",
) {}

/**
 * Resolve the session binding at startup; return a handler for each request.
 *
 * A request without a session id (initialize, the stateless 2026-07-28 protocol, approvals) is
 * authenticated here and sent to the object its user/client/organization/grant names. A request
 * inside a session is sent to the object its signed id names, with no bearer check and no
 * database here: the object checks the bearer and that the bearer's key names it before any work.
 */
export const cloudMcp = Effect.gen(function* () {
  const sessions = yield* inJurisdiction(McpSession.from(McpServer));
  const sessionNamespace = yield* durableNamespace("McpSession");
  const keys = yield* mcpSessionKeys;
  const send = (
    route: "authenticated" | "session",
    fetch: (
      attempt: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError>,
  ) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("executor.mcp.route", route);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const headers = yield* traceHeaders;
      const traced = request.modify({ headers: { ...request.headers, ...headers } });
      const response = yield* forwardMcpRequest(traced, (attempt) => timedForward(fetch(attempt)));
      const organization = response.headers[sessionOrganizationHeader];
      if (organization !== undefined)
        yield* Effect.annotateCurrentSpan("executor.organization.id", organization);
      return HttpServerResponse.removeHeader(response, sessionOrganizationHeader);
    }).pipe(Effect.flatMap(observeMcpStream("gateway")), Effect.withSpan("mcp.session.forward"));
  const forward = (access: Parameters<typeof mcpSessionKey>[0]) =>
    Effect.annotateCurrentSpan("executor.organization.id", access.access.organization).pipe(
      Effect.andThen(
        send("authenticated", (attempt) =>
          sessions.getByName(mcpSessionKey(access)).fetch(attempt),
        ),
      ),
    );
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
      const namespace = yield* sessionNamespace;
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
      return yield* send("session", (attempt) => object.fetch(attempt));
    }).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")));
  return {
    http: Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      const session = request.headers["mcp-session-id"];
      return session === undefined ? authenticatedMcp(forward) : inSession(session);
    }),
    approvals: browserMcpRequest((access) => forward(access)),
  };
});
