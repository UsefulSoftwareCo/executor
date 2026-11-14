import { CurrentPolicy } from "../contracts/authorization.ts";
import { grantAuthorization } from "@executor-js/mcp-auth";
import { checkInvocationAccounts } from "./access.ts";
import { invocationAccounts } from "@executor-js/sdk/core";
import { CurrentUserId } from "../contracts/auth.ts";
/** Browser identity selects the same MCP host partition as the original bearer grant. */
import {
  BrowserApprovalAddress,
  BrowserApprovalAnswer,
  type BrowserApprovals,
} from "@executor-js/mcp/browser";
import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { McpAuthentication, McpUnauthorized } from "../contracts/mcp.ts";
import { restrictMcpBackend, permitsBrowserApproval } from "@executor-js/mcp-auth";
import { CurrentOrganization } from "../contracts/organization.ts";
import type { McpAccess } from "../contracts/mcp.ts";
import { mcpSessionKey } from "./mcp-http.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { hostedMcpBackend } from "./mcp.ts";
import { personApprover, personCaller } from "./caller.ts";

import { HostedApprovalQuery } from "../contracts/mcp-browser.ts";
const browserAccess = Effect.gen(function* () {
  const auth = yield* McpAuthentication;
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST")
    return HttpServerResponse.empty({ status: 405 });
  if (
    request.headers.authorization !== undefined ||
    request.headers["sec-fetch-site"] === "cross-site" ||
    (request.headers.origin !== undefined && request.headers.origin !== auth.origin) ||
    (request.method === "POST" && request.headers.origin !== auth.origin)
  )
    return HttpServerResponse.empty({ status: 403 });
  const headers = new Headers(request.headers);
  const url = new URL(request.url, auth.origin);
  const query = yield* Schema.decodeUnknownEffect(HostedApprovalQuery)(
    HttpServerRequest.searchParamsFromURL(url),
  );
  // The incoming Origin was checked above. Internal cookie verification also needs it on GET.
  headers.set("origin", auth.origin);
  // The grant comes from the link's sealed reference, or from an older link's grant ID.
  const grantId =
    query.grant !== undefined
      ? yield* auth.openGrant(query.grant)
      : query.grantId !== undefined
        ? query.grantId
        : yield* new McpUnauthorized();
  const access = yield* auth.browserGrant(headers, grantId);
  const address = yield* Schema.decodeUnknownEffect(BrowserApprovalAddress)({
    sessionId: query.sessionId,
    requestId: url.pathname.split("/").at(-1),
    ...(query.mode === undefined ? {} : { mode: query.mode }),
  });
  return { access, address, issuer: auth.issuer };
}).pipe(
  Effect.catchTags({
    AuthenticationUnavailable: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
    McpUnauthorized: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
    McpApprovalForbidden: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
    SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
  }),
);

/** Authenticate cookies and current membership on both gateway and session-host boundaries. */
export const browserMcpRequest = <E, R>(
  handle: (
    access: McpAccess,
    address: BrowserApprovalAddress,
    issuer: string,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  browserAccess.pipe(
    Effect.flatMap((scope) =>
      HttpServerResponse.isHttpServerResponse(scope)
        ? Effect.succeed(scope)
        : handle(scope.access, scope.address, scope.issuer),
    ),
    Effect.map((response) =>
      response.pipe(
        HttpServerResponse.setHeader("cache-control", "no-store"),
        HttpServerResponse.setHeader("referrer-policy", "no-referrer"),
      ),
    ),
  );

/** Inspect and answer through the shared manager, after checking app/account access with browser authority. */
export const hostedMcpApproval = (
  approvals: BrowserApprovals,
  access: McpAccess,
  address: BrowserApprovalAddress,
  issuer?: string,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // A model-mode grant's page answers only its own programs' requests that require a person;
    // the model-mode address cannot reach a browser-mode session.
    const permitted =
      address.mode === "model"
        ? access.grant.target.kind === "mcp" && access.grant.target.mode === "model"
        : permitsBrowserApproval(access.grant);
    if (!permitted) return HttpServerResponse.empty({ status: 403 });
    const caller = mcpSessionKey(access);
    const view = yield* approvals.get(caller, address);
    if (view.status === "pending") {
      const backend = yield* hostedMcpBackend.pipe(
        Effect.provideService(CurrentOrganization, access.access),
        Effect.provideService(CurrentPolicy, grantAuthorization(access.grant.policy)),
        Effect.provideService(CurrentUserId, access.userId),
      );
      const restricted = restrictMcpBackend<Error, never>(backend, Effect.succeed(access.grant));
      yield* restricted.authorizeElicitation(
        view.request.status === "approval-required"
          ? {
              app: view.request.invocation.app,
              tool: view.request.invocation.tool,
              accounts: invocationAccounts(view.request.invocation),
            }
          : view.request.tool,
      );
      if (view.request.status === "approval-required")
        yield* checkInvocationAccounts(
          yield* Effect.flatten(HostedExecutor),
          access.access.owner,
          view.request.invocation,
        ).pipe(
          Effect.provideService(CurrentOrganization, access.access),
          Effect.provideService(CurrentUserId, access.userId),
        );
    }
    if (request.method !== "POST") {
      if (view.status !== "pending") return HttpServerResponse.jsonUnsafe(view);
      const executor = yield* Effect.flatten(HostedExecutor);
      const app = yield* executor.apps.get({
        app:
          view.request.status === "approval-required"
            ? view.request.invocation.app
            : view.request.tool.app,
        owner: access.access.owner,
      });
      return HttpServerResponse.jsonUnsafe({ ...view, appName: app.name });
    }
    const answer = yield* HttpServerRequest.schemaBodyJson(BrowserApprovalAnswer);
    // The signed-in person on this page approved it, whichever client asked.
    const approver = personApprover(
      personCaller(access, access.access.organization, issuer ?? "", "ui"),
      "browser",
    );
    return HttpServerResponse.jsonUnsafe(
      yield* approvals.answer(caller, address, answer.response, approver),
    );
  }).pipe(
    Effect.catchTags({
      SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      HttpServerError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      AppNotFound: () => Effect.succeed(HttpServerResponse.jsonUnsafe({ status: "unavailable" })),
      StorageError: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      OrganizationForbidden: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
      AccountNotFound: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
      ElicitationFailed: (error) =>
        Effect.succeed(
          HttpServerResponse.empty({ status: error.reason === "forbidden" ? 403 : 503 }),
        ),
      ElicitationResponseInvalid: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: "The answer does not match this form." },
            { status: 400 },
          ),
        ),
    }),
  );
