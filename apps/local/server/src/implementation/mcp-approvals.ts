import { GrantId, permitsTool, permitsDelivery } from "@executor-js/mcp-auth";
import type { LocalMcpOAuth } from "./mcp-oauth.ts";
import type { Executor } from "@executor-js/sdk/core";
/** Browser approval access uses paired dashboard cookies, never the programmatic bearer key. */
import {
  BrowserApprovalAddress,
  BrowserApprovalAnswer,
  BrowserSessionId,
  type BrowserApprovals,
} from "@executor-js/mcp/browser";
import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { localRequest, requestOrigin, sessionCookie, type LocalAuth } from "./auth.ts";
import type { ServerConfig } from "../contracts/config.ts";

/** Local endpoints share the execution manager with /mcp while retaining separate cookie/Origin checks. */
export const localMcpApproval = (
  approvals: BrowserApprovals,
  auth: LocalAuth,
  config: ServerConfig,
  executor: Executor,
  oauth: LocalMcpOAuth,
) =>
  Effect.gen(function* () {
    const request = yield* localRequest(config.port, config.browserOrigin);
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST")
      return HttpServerResponse.empty({ status: 405 });
    if (
      request.headers.authorization !== undefined ||
      (request.method === "POST" && request.headers.origin !== requestOrigin(config, request))
    )
      return HttpServerResponse.empty({ status: 403 });
    if (!(yield* auth.valid(request.cookies[sessionCookie(config.port)])))
      return HttpServerResponse.empty({ status: 401 });
    const query = yield* HttpServerRequest.schemaSearchParams(
      Schema.Struct({ sessionId: BrowserSessionId, grantId: GrantId }),
    );
    const url = new URL(request.url, "http://localhost");
    const address = yield* Schema.decodeUnknownEffect(BrowserApprovalAddress)({
      ...query,
      requestId: url.pathname.split("/").at(-1),
    });
    const headers = new Headers(request.headers);
    headers.set("origin", oauth.origin);
    const grant =
      query.grantId === "local-administrator"
        ? {
            id: query.grantId,
            policy: { kind: "all" as const },
            target: { kind: "mcp" as const, mode: "browser" as const },
          }
        : (yield* oauth.browserGrant(headers, query.grantId)).grant;
    if (!permitsDelivery(grant, "browser")) return HttpServerResponse.empty({ status: 403 });
    const view = yield* approvals.get(grant.id, address);
    if (view.status === "pending") {
      const tool =
        view.request.status === "approval-required" ? view.request.invocation : view.request.tool;
      if (!permitsTool(grant.policy, tool.app, tool.tool))
        return HttpServerResponse.empty({ status: 403 });
    }
    if (request.method !== "POST") {
      if (view.status !== "pending") return HttpServerResponse.jsonUnsafe(view);
      const app = yield* executor.apps.get({
        app:
          view.request.status === "approval-required"
            ? view.request.invocation.app
            : view.request.tool.app,
      });
      return HttpServerResponse.jsonUnsafe({ ...view, appName: app.name });
    }
    const answer = yield* HttpServerRequest.schemaBodyJson(BrowserApprovalAnswer);
    return HttpServerResponse.jsonUnsafe(
      yield* approvals.answer(grant.id, address, answer.response),
    );
  }).pipe(
    Effect.catchTags({
      LocalMcpUnauthorized: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
      LocalMcpAuthUnavailable: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      AppNotFound: () => Effect.succeed(HttpServerResponse.jsonUnsafe({ status: "unavailable" })),
      StorageError: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      AuthForbidden: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
      AuthStorageError: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      HttpServerError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      ElicitationResponseInvalid: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: "The answer does not match this form." },
            { status: 400 },
          ),
        ),
    }),
    Effect.map((response) =>
      response.pipe(
        HttpServerResponse.setHeader("cache-control", "no-store"),
        HttpServerResponse.setHeader("referrer-policy", "no-referrer"),
      ),
    ),
  );
