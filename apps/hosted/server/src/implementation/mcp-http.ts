import { CurrentAuthorization } from "../contracts/authorization.ts";
import { CurrentUsage } from "../contracts/product-analytics.ts";
import { grantAuthorization } from "@executor-js/mcp-auth";
import { GroupDatabase } from "../contracts/groups.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import {
  restrictMcpBackend,
  permitsDelivery,
  GrantForbidden,
  requestedMcpMode,
  mcpResource,
  mcpResourceMetadataUrl,
} from "@executor-js/mcp-auth";
import { defaultMcpLimits, makeMcp, type McpBackend, type McpOptions } from "@executor-js/mcp";
import { Context, Effect, Option, Schema } from "effect";
import { ElicitationFailed } from "@executor-js/sdk/core";
import { McpProtocol } from "effect/unstable/ai";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  McpAuthentication,
  McpUnauthorized,
  McpForbidden,
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
  | McpForbidden
  | Effect.Error<ReturnType<HostedBackend[keyof HostedBackend]>>
  | Effect.Error<ReturnType<McpAuthentication["Service"]["authenticate"]>>;
const unavailable = () => Effect.fail(new McpUnauthorized());
const RequestCaller = Context.Reference<string>("hosted/McpRequestCaller", {
  defaultValue: () => "unavailable",
});
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
  }),
});
const RequestApprovalUrl = Context.Reference<
  ((address: import("@executor-js/mcp/browser").BrowserApprovalAddress) => string) | undefined
>("hosted/McpApprovalUrl", { defaultValue: () => undefined });
const requestBackend: McpBackend<RequestError> = {
  listSkills: (input) => Effect.flatMap(RequestBackend, (backend) => backend.listSkills(input)),
  readSkill: (input) => Effect.flatMap(RequestBackend, (backend) => backend.readSkill(input)),
  authorizeElicitation: (input) =>
    Effect.flatMap(RequestBackend, (backend) => backend.authorizeElicitation(input)),
  listApps: (input) => Effect.flatMap(RequestBackend, (backend) => backend.listApps(input)),
  listTargets: (input) => Effect.flatMap(RequestBackend, (backend) => backend.listTargets(input)),
  listTools: (input) => Effect.flatMap(RequestBackend, (backend) => backend.listTools(input)),
  callTool: (input, options) =>
    Effect.flatMap(RequestBackend, (backend) => backend.callTool(input, options)),
  resumeInvocation: (request, response, options) =>
    Effect.flatMap(RequestBackend, (backend) =>
      backend.resumeInvocation(request, response, options),
    ),
};

/** Build native MCP protocol state inside its host-owned scope, without a caller identity. */
export const makeHostedMcp = (beforeExecute?: McpOptions["beforeExecute"]) =>
  makeMcp({
    backend: requestBackend,
    ...(beforeExecute === undefined ? {} : { beforeExecute }),
    caller: RequestCaller,
    limits: defaultMcpLimits,
    browser: {
      url: (address) =>
        Effect.flatMap(RequestApprovalUrl, (url) =>
          url === undefined
            ? Effect.die("Browser approval URL requires an authenticated MCP request")
            : Effect.succeed(url(address)),
        ),
    },
    protocols: [
      McpProtocol.v2026_07_28,
      McpProtocol.v2025_11_25,
      McpProtocol.v2025_06_18,
      McpProtocol.v2025_03_26,
    ],
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
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const authentication = yield* McpAuthentication;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, authentication.origin);
    const mode = requestedMcpMode(url);
    const organization = requestedMcpOrganization(url);
    const scoped = (fresh: McpAccess) =>
      Effect.gen(function* () {
        if (
          mode === undefined ||
          !permitsDelivery(fresh.grant, mode) ||
          mcpSessionKey(fresh) !== mcpSessionKey(access)
        )
          return yield* new McpForbidden();
        const backend = yield* hostedMcpBackend.pipe(
          Effect.provideService(CurrentOrganization, fresh.access),
          Effect.provideService(CurrentAuthorization, grantAuthorization(fresh.grant.policy)),
          Effect.provideService(CurrentUserId, fresh.userId),
        );
        return restrictMcpBackend<RequestError, never>(backend, Effect.succeed(fresh.grant));
      });
    const backend = yield* scoped(access);
    const services = yield* Effect.context<HostedExecutor | GroupDatabase>().pipe(
      Effect.map(Context.pick(HostedExecutor, GroupDatabase)),
    );
    // Discovery uses this HTTP request's authenticated identity. Resource policies
    // are still checked by the hosted backend. Never retain this adapter in the session.
    // Calls and elicitation can run after a wait, so recheck token/grant/membership
    // before executing or releasing them, including calls after an approved one.
    const current = authentication
      .authenticate(new Headers(request.headers), mode, organization)
      .pipe(Effect.flatMap(scoped), Effect.provideContext(services));
    const authorized: McpBackend<RequestError> = {
      ...backend,
      listSkills: (input) => current.pipe(Effect.flatMap((fresh) => fresh.listSkills(input))),
      readSkill: (input) => current.pipe(Effect.flatMap((fresh) => fresh.readSkill(input))),

      authorizeElicitation: (input) =>
        current.pipe(
          Effect.flatMap((fresh) => fresh.authorizeElicitation(input)),
          Effect.catchTags({
            McpUnauthorized: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
            McpForbidden: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
            AuthenticationUnavailable: () =>
              Effect.fail(new ElicitationFailed({ reason: "transport" })),
          }),
        ),
      callTool: (input, options) =>
        current.pipe(Effect.flatMap((fresh) => fresh.callTool(input, options))),
      resumeInvocation: (pending, response, options) =>
        current.pipe(Effect.flatMap((fresh) => fresh.resumeInvocation(pending, response, options))),
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

/** Authenticate every MCP HTTP method through OAuth or PAT validation; never fall back to a browser cookie. */
export const authenticatedMcp = <E, R>(
  handle: (access: McpAccess) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const auth = yield* McpAuthentication;
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Programmatic clients have no Origin. Untrusted browser pages cannot call MCP.
    if (request.headers.origin !== undefined && request.headers.origin !== auth.origin)
      return HttpServerResponse.empty({ status: 403 });
    const url = new URL(request.url, auth.origin);
    const mode = requestedMcpMode(url);
    if (mode === undefined)
      return HttpServerResponse.jsonUnsafe(
        { error: "Unsupported elicitation_mode." },
        { status: 400 },
      );
    const access = yield* auth.authenticate(
      new Headers(request.headers),
      mode,
      requestedMcpOrganization(url),
    );
    return yield* handle(access);
  }).pipe(
    Effect.catchTag("McpUnauthorized", () =>
      Effect.gen(function* () {
        const { origin } = yield* McpAuthentication;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const mode = requestedMcpMode(new URL(request.url, origin));
        if (mode === undefined)
          return HttpServerResponse.jsonUnsafe(
            { error: "Unsupported elicitation_mode." },
            { status: 400 },
          );
        return HttpServerResponse.empty({
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${mcpResourceMetadataUrl(origin, mode)}", scope="mcp offline_access"`,
          },
        });
      }),
    ),
    Effect.catchTag("McpForbidden", () =>
      Effect.succeed(HttpServerResponse.empty({ status: 403 })),
    ),
    Effect.catchTag("AuthenticationUnavailable", () =>
      Effect.succeed(HttpServerResponse.empty({ status: 503 })),
    ),
    Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
  );

/** RFC 9728 resource metadata for the request's configured auth origin. */
export const mcpProtectedResource = Effect.gen(function* () {
  const { origin } = yield* McpAuthentication;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const mode = requestedMcpMode(new URL(request.url, origin));
  if (mode === undefined)
    return HttpServerResponse.jsonUnsafe(
      { error: "Unsupported elicitation_mode." },
      { status: 400 },
    );
  return HttpServerResponse.jsonUnsafe({
    resource: mcpResource(origin, mode),
    authorization_servers: [`${origin}/api/auth`],
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
