import { CurrentAuthorization } from "../contracts/authorization.ts";
import { CurrentUsage } from "../contracts/product-analytics.ts";
import { grantAuthorization } from "@executor-js/mcp-auth";
import { GroupDatabase } from "../contracts/groups.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import {
  restrictMcpBackend,
  deliveryRefusal,
  GrantForbidden,
  requestedMcpAddress,
  mcpResource,
  mcpResourceMetadataUrl,
  requestResourceOrigin,
  type McpAddress,
} from "@executor-js/mcp-auth";
import {
  defaultMcpLimits,
  makeMcp,
  refusedMcpRequest,
  type McpBackend,
  type McpOptions,
} from "@executor-js/mcp";
import { annotateSkillRead, executorIntro } from "@executor-js/app-templates/executor";
import { Context, Effect, Option, Result, Schema } from "effect";
import { ElicitationFailed } from "@executor-js/sdk/core";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  CurrentMcpGrant,
  McpAuthentication,
  McpUnauthorized,
  type McpAccess,
} from "../contracts/mcp.ts";
import { CurrentOrganization, OrganizationReference } from "../contracts/organization.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { hostedMcpBackend } from "./mcp.ts";

// A native MCP server retains its tool handlers. Authority is supplied only while
// dispatching the HTTP request, never while registering those handlers.
type HostedBackend = Effect.Success<typeof hostedMcpBackend>;
type RequestError =
  | GrantForbidden
  | Effect.Error<ReturnType<HostedBackend[keyof HostedBackend]>>
  | Effect.Error<ReturnType<McpAuthentication["Service"]["authenticate"]>>;
const unavailable = () => Effect.fail(new McpUnauthorized());
const RequestCaller = Context.Reference<string | undefined>("hosted/McpRequestCaller", {
  defaultValue: () => undefined,
});
// Programs belong to the caller across MCP sessions, so a request without one must not share a partition.
const requestCaller = Effect.flatMap(RequestCaller, (caller) =>
  caller === undefined
    ? Effect.die("MCP request has no authenticated caller")
    : Effect.succeed(caller),
);
const RequestBackend = Context.Reference<McpBackend<RequestError>>("hosted/McpRequestBackend", {
  defaultValue: () => ({
    listSkills: unavailable,
    readSkill: unavailable,
    listApps: unavailable,
    listTargets: unavailable,
    listTools: unavailable,
    callTool: unavailable,
    resumeInvocation: unavailable,
    authorizeElicitation: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
    eventDefinitions: unavailable,
    findEventSubscription: unavailable,
    subscribeEvent: unavailable,
    unsubscribeEvent: unavailable,
  }),
});
const RequestApprovalUrl = Context.Reference<
  ((address: import("@executor-js/mcp/browser").BrowserApprovalAddress) => string) | undefined
>("hosted/McpApprovalUrl", { defaultValue: () => undefined });
const requestBackend: McpBackend<RequestError> = {
  listSkills: (input, options) =>
    Effect.flatMap(RequestBackend, (backend) => backend.listSkills(input, options)),
  readSkill: (input) => Effect.flatMap(RequestBackend, (backend) => backend.readSkill(input)),
  authorizeElicitation: (input) =>
    Effect.flatMap(RequestBackend, (backend) => backend.authorizeElicitation(input)),
  listApps: (input) => Effect.flatMap(RequestBackend, (backend) => backend.listApps(input)),
  listTargets: (input) => Effect.flatMap(RequestBackend, (backend) => backend.listTargets(input)),
  listTools: (input, options) =>
    Effect.flatMap(RequestBackend, (backend) => backend.listTools(input, options)),
  callTool: (input, options) =>
    Effect.flatMap(RequestBackend, (backend) => backend.callTool(input, options)),
  resumeInvocation: (request, response, options) =>
    Effect.flatMap(RequestBackend, (backend) =>
      backend.resumeInvocation(request, response, options),
    ),
  eventDefinitions: (input) =>
    Effect.flatMap(RequestBackend, (backend) => backend.eventDefinitions(input)),
  findEventSubscription: (key) =>
    Effect.flatMap(RequestBackend, (backend) => backend.findEventSubscription(key)),
  subscribeEvent: (input) =>
    Effect.flatMap(RequestBackend, (backend) => backend.subscribeEvent(input)),
  unsubscribeEvent: (input) =>
    Effect.flatMap(RequestBackend, (backend) => backend.unsubscribeEvent(input)),
};

/** Build native MCP protocol state inside its host-owned scope, without a caller identity. */
export const makeHostedMcp = (beforeExecute?: McpOptions["beforeExecute"]) =>
  makeMcp({
    backend: requestBackend,
    ...(beforeExecute === undefined ? {} : { beforeExecute }),
    caller: requestCaller,
    instructions: executorIntro,
    limits: defaultMcpLimits,
    annotateSkillRead,
    browser: {
      url: (address) =>
        Effect.flatMap(RequestApprovalUrl, (url) =>
          url === undefined
            ? Effect.die("Browser approval URL requires an authenticated MCP request")
            : Effect.succeed(url(address)),
        ),
    },
  }).pipe(Effect.orDie);

/** An organization-pathed MCP URL names its organization; bare /mcp leaves the choice to the token. */
export const requestedMcpOrganization = (url: URL): OrganizationReference | undefined => {
  const match = /^\/org\/([^/]+)\/mcp$/.exec(url.pathname);
  if (match === null) return undefined;
  const reference = Schema.decodeUnknownOption(OrganizationReference)(
    decodeURIComponent(match[1] ?? ""),
  );
  return Option.getOrUndefined(reference);
};

/** A session belongs to a user/client/organization grant, never to a browser's active organization. */
export const mcpSessionKey = ({ userId, clientId, access, grant }: McpAccess) =>
  JSON.stringify([userId, clientId, access.organization, grant.id]);

/** Supply fresh authorized operations to an existing native MCP transport. */
export const dispatchHostedMcp = <E, R>(
  access: McpAccess,
  address: McpAddress,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const authentication = yield* McpAuthentication;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scoped = (fresh: McpAccess) =>
      Effect.gen(function* () {
        // A grant serves only the MCP URL it was issued for, and says why it cannot serve this one.
        const refusal = deliveryRefusal(fresh.grant, address);
        if (refusal !== undefined) return yield* new GrantForbidden({ refusal });
        const backend = yield* hostedMcpBackend.pipe(
          Effect.provideService(CurrentOrganization, fresh.access),
          Effect.provideService(CurrentAuthorization, grantAuthorization(fresh.grant.policy)),
          Effect.provideService(CurrentUserId, fresh.userId),
          Effect.provideService(CurrentMcpGrant, fresh.grant.id),
        );
        return restrictMcpBackend<RequestError, never>(backend, Effect.succeed(fresh.grant));
      });
    // Clients print a refusal's body after their own prefix, so it keeps the typed cause.
    const scope = yield* Effect.result(scoped(access));
    if (Result.isFailure(scope)) return yield* refusedMcpRequest(scope.failure);
    const backend = scope.success;
    const services = yield* Effect.context<HostedExecutor | GroupDatabase>().pipe(
      Effect.map(Context.pick(HostedExecutor, GroupDatabase)),
    );
    // Discovery uses this HTTP request's authenticated identity. Resource policies
    // are still checked by the hosted backend. Never retain this adapter in the session.
    // Calls and elicitation can run after a wait, so recheck token/grant/membership
    // before executing or releasing them, including calls after an approved one.
    // A recheck names the organization this request resolved, by its ID; it never resolves the
    // URL's or X-Executor-Organization's slug again, so a slug renamed during the request cannot
    // move it to another organization. The same bearer keeps its user, client and grant.
    const headers = new Headers(request.headers);
    headers.delete("x-executor-organization");
    // The organization's opaque ID goes on the request's span and on each operation that rechecks
    // (`mcp.tool.call`, `mcp.tool.resume`), so their latency can be split by organization.
    const organization = { "executor.organization.id": access.access.organization };
    yield* Effect.annotateCurrentSpan(organization);
    const current = Effect.annotateCurrentSpan(organization).pipe(
      Effect.andThen(
        authentication.authenticate(headers, address.mode, access.access.organization),
      ),
      Effect.flatMap(scoped),
      Effect.provideContext(services),
    );
    const authorized: McpBackend<RequestError> = {
      ...backend,
      listSkills: (input, options) =>
        current.pipe(Effect.flatMap((fresh) => fresh.listSkills(input, options))),
      readSkill: (input) => current.pipe(Effect.flatMap((fresh) => fresh.readSkill(input))),

      authorizeElicitation: (input) =>
        current.pipe(
          Effect.flatMap((fresh) => fresh.authorizeElicitation(input)),
          Effect.catchTags({
            McpUnauthorized: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
            McpForbidden: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
            GrantForbidden: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
            AuthenticationUnavailable: () =>
              Effect.fail(new ElicitationFailed({ reason: "transport" })),
          }),
        ),
      callTool: (input, options) =>
        current.pipe(Effect.flatMap((fresh) => fresh.callTool(input, options))),
      resumeInvocation: (pending, response, options) =>
        current.pipe(Effect.flatMap((fresh) => fresh.resumeInvocation(pending, response, options))),
      subscribeEvent: (input) =>
        current.pipe(Effect.flatMap((fresh) => fresh.subscribeEvent(input))),
    };
    return yield* handler.pipe(
      Effect.provideService(RequestBackend, authorized),
      Effect.provideService(RequestApprovalUrl, (address) => {
        const url = new URL(`/mcp/approve/${address.requestId}`, authentication.origin);
        url.searchParams.set("sessionId", address.sessionId);
        url.searchParams.set("grantId", access.grant.id);
        return url.toString();
      }),
      Effect.provideService(RequestCaller, mcpSessionKey(access)),
      Effect.provideService(CurrentUsage, { source: "mcp", client_id: access.clientId }),
    );
  });

const invalidAddress = HttpServerResponse.jsonUnsafe(
  { error: "Unsupported elicitation_mode or connection." },
  { status: 400 },
);

/** Authenticate every MCP HTTP method through OAuth or PAT validation; never fall back to a browser cookie. */
export const authenticatedMcp = <E, R>(
  handle: (
    access: McpAccess,
    address: McpAddress,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const auth = yield* McpAuthentication;
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Programmatic clients have no Origin. Untrusted browser pages cannot call MCP.
    if (request.headers.origin !== undefined && request.headers.origin !== auth.origin)
      return HttpServerResponse.empty({ status: 403 });
    const url = new URL(request.url, auth.origin);
    const address = requestedMcpAddress(url);
    if (address === undefined) return invalidAddress;
    const access = yield* Effect.result(
      auth.authenticate(new Headers(request.headers), address.mode, requestedMcpOrganization(url)),
    );
    if (Result.isSuccess(access)) return yield* handle(access.success, address);
    if (access.failure._tag === "McpUnauthorized")
      return HttpServerResponse.empty({
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${mcpResourceMetadataUrl(requestResourceOrigin(auth.resourceOrigins.mcp, request.headers.host), address)}", scope="mcp offline_access"`,
        },
      });
    // Clients print a refusal's body after their own prefix, so it keeps the typed cause.
    return yield* refusedMcpRequest(access.failure);
  }).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")));

/** RFC 9728 resource metadata naming the authorization server's issuer. */
export const mcpProtectedResource = Effect.gen(function* () {
  const { issuer, resourceOrigins } = yield* McpAuthentication;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const resourceOrigin = requestResourceOrigin(resourceOrigins.mcp, request.headers.host);
  const address = requestedMcpAddress(new URL(request.url, resourceOrigin));
  if (address === undefined) return invalidAddress;
  return HttpServerResponse.jsonUnsafe({
    resource: mcpResource(resourceOrigin, address),
    authorization_servers: [issuer],
    scopes_supported: ["mcp", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "Executor",
  });
});
/** RFC 8414 authorization-server metadata from Better Auth. */
export const mcpAuthorizationServer = Effect.flatMap(
  McpAuthentication,
  (auth) => auth.metadata,
).pipe(
  Effect.map(HttpServerResponse.jsonUnsafe),
  Effect.catchTag("AuthenticationUnavailable", () =>
    Effect.succeed(HttpServerResponse.empty({ status: 503 })),
  ),
);
