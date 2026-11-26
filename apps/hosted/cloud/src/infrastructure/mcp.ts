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
import {
  mcpMethodHeader,
  mcpRequestAttributes,
  parseMcpBody,
} from "../implementation/mcp-request-method.ts";
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

export class McpSession extends Cloudflare.DurableObject<McpSession, McpSessionObject>()(
  "McpSession",
) {}

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

export const cloudMcp = Effect.gen(function* () {
  const sessions = yield* McpSession.from(McpServer);
  const environment = yield* Cloudflare.WorkerEnvironment;
  const keys = yield* mcpSessionKeys;
  const send = (
    route:
      | {
          readonly kind: "authenticated";
          readonly caller: ReturnType<typeof callerSpanAttributes>;
        }
      | { readonly kind: "session" },
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
        const body = parseMcpBody(
          request.method === "POST"
            ? yield* HttpServerRequest.toWeb(request).pipe(
                Effect.flatMap((web) => Effect.tryPromise(() => web.clone().text())),
                Effect.option,
                Effect.map(Option.getOrUndefined),
              )
            : undefined,
        );
        let method: string | undefined;
        if (carries === "json-rpc" && request.method === "POST") {
          const attributes = mcpRequestAttributes(body);
          method = attributes["rpc.method"];
          yield* Effect.annotateCurrentSpan(attributes);
          if (Option.isSome(server))
            for (const [key, value] of Object.entries(attributes))
              server.value.attribute(key, value);
        }
        return yield* Effect.gen(function* () {
          const headers = yield* traceHeaders;
          const { [mcpMethodHeader]: _sent, ...received } = request.headers;
          const traced = request.modify({
            headers: {
              ...received,
              ...headers,
              ...(method === undefined ? {} : { [mcpMethodHeader]: method }),
            },
          });
          const response = yield* refuseTooDeep(
            forwardMcpRequest(traced, (attempt) => timedForward(fetch(attempt))),
          );
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
      if (request.headers.origin !== undefined && request.headers.origin !== auth.origin)
        return HttpServerResponse.empty({ status: 403 });
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
