import { CurrentPolicy } from "../contracts/authorization.ts";
import { CurrentUsage } from "../contracts/product-analytics.ts";
import { requiresToolMetadata } from "@executor-js/authorization";
import { GroupDatabase } from "../contracts/groups.ts";
import { CurrentUserId, callerSpanAttributes } from "../contracts/auth.ts";
import { recordAuthFailure } from "./auth-telemetry.ts";
import {
  restrictMcpBackend,
  grantRefusal,
  unrecordedRefusal,
  GrantForbidden,
  McpWhoami,
  requestedMcpAddress,
  namedApprovalMode,
  mcpResource,
  mcpResourceMetadataUrl,
  requestResourceOrigin,
  type ApprovalMode,
  type McpAddress,
} from "@executor-js/mcp-auth";
import {
  defaultMcpLimits,
  makeMcp,
  McpRequestAttributes,
  refusedMcpRequest,
  type McpBackend,
  type McpOptions,
} from "@executor-js/mcp";
import { annotateSkillRead, executorIntro } from "@executor-js/app-templates/executor";
import { Cause, Context, Effect, Exit, Option, Result, Schema } from "effect";
import {
  ElicitationFailed,
  InvocationPrefetch,
  PrefetchHost,
  invocationEntries,
  sameAccounts,
  type AppAccounts,
  type AppId,
} from "@executor-js/sdk/core";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  CurrentMcpGrant,
  CurrentMcpSession,
  McpAuthentication,
  McpUnauthorized,
  type McpAccess,
} from "../contracts/mcp.ts";
import { CurrentOrganization, OrganizationReference } from "../contracts/organization.ts";
import {
  CallStateCache,
  ConcurrentStatements,
  HostedBackground,
  HostedExecutor,
  StatementBatch,
  statementGroup,
  type CallState,
} from "../contracts/executor.ts";
import { FoldReadAhead, readSelection, SelectionReadAhead } from "./access.ts";
import { callerAccounts } from "./app-accounts.ts";
import { resourceAuthorityForLinks } from "./resource-policy.ts";
import { BearerHashes } from "./bearer-access.ts";
import { hostedMcpBackend } from "./mcp.ts";
import { patGrantOf } from "./mcp-oauth.ts";

type HostedBackend = Effect.Success<typeof hostedMcpBackend>;
type RequestError =
  | GrantForbidden
  | Effect.Error<ReturnType<HostedBackend[keyof HostedBackend]>>
  | Effect.Error<ReturnType<McpAuthentication["Service"]["authenticate"]>>;
const unavailable = () => Effect.fail(new McpUnauthorized());
const callStateLimit = 256;
const accountsKey = (accounts: AppAccounts | undefined) => [
  accounts?.user === undefined,
  (accounts === undefined ? [] : invocationEntries(accounts))
    .filter(([, ids]) => ids.length > 0)
    .map(([slot, ids]) => [slot, [...new Set(ids)].sort()] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
];
const RequestCaller = Context.Reference<string | undefined>("hosted/McpRequestCaller", {
  defaultValue: () => undefined,
});
const requestCaller = Effect.flatMap(RequestCaller, (caller) =>
  caller === undefined
    ? Effect.die("MCP request has no authenticated caller")
    : Effect.succeed(caller),
);
const RequestBackend = Context.Reference<McpBackend<RequestError>>("hosted/McpRequestBackend", {
  defaultValue: () => ({
    listSkills: unavailable,
    bundleSkills: unavailable,
    readSkill: unavailable,
    listApps: unavailable,
    listAccounts: unavailable,
    listTools: unavailable,
    searchableTools: unavailable,
    searchTools: unavailable,
    callTool: unavailable,
    resumeInvocation: unavailable,
    authorizeElicitation: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
    findEventSubscription: unavailable,
    subscribeEvent: unavailable,
    unsubscribeEvent: unavailable,
  }),
});
const RequestMode = Context.Reference<ApprovalMode | undefined>("hosted/McpRequestMode", {
  defaultValue: () => undefined,
});
const requestMode = Effect.flatMap(RequestMode, (mode) =>
  mode === undefined
    ? Effect.die("MCP request has no authenticated approval mode")
    : Effect.succeed(mode),
);
const RequestApprovalUrl = Context.Reference<
  ((address: import("@executor-js/mcp/browser").BrowserApprovalAddress) => string) | undefined
>("hosted/McpApprovalUrl", { defaultValue: () => undefined });
const requestBackend: McpBackend<RequestError> = {
  listSkills: (input, options) =>
    Effect.flatMap(RequestBackend, (backend) => backend.listSkills(input, options)),
  bundleSkills: (input, options) =>
    Effect.flatMap(RequestBackend, (backend) => backend.bundleSkills(input, options)),
  readSkill: (input) => Effect.flatMap(RequestBackend, (backend) => backend.readSkill(input)),
  authorizeElicitation: (input) =>
    Effect.flatMap(RequestBackend, (backend) => backend.authorizeElicitation(input)),
  listApps: (input) => Effect.flatMap(RequestBackend, (backend) => backend.listApps(input)),
  listAccounts: (input) => Effect.flatMap(RequestBackend, (backend) => backend.listAccounts(input)),
  listTools: (input, options) =>
    Effect.flatMap(RequestBackend, (backend) => backend.listTools(input, options)),
  searchableTools: (input, options) =>
    Effect.flatMap(RequestBackend, (backend) => backend.searchableTools(input, options)),
  searchTools: (input) => Effect.flatMap(RequestBackend, (backend) => backend.searchTools(input)),
  callTool: (input, options) =>
    Effect.flatMap(RequestBackend, (backend) => backend.callTool(input, options)),
  resumeInvocation: (request, response, options) =>
    Effect.flatMap(RequestBackend, (backend) =>
      backend.resumeInvocation(request, response, options),
    ),
  findEventSubscription: (key) =>
    Effect.flatMap(RequestBackend, (backend) => backend.findEventSubscription(key)),
  subscribeEvent: (input) =>
    Effect.flatMap(RequestBackend, (backend) => backend.subscribeEvent(input)),
  unsubscribeEvent: (input) =>
    Effect.flatMap(RequestBackend, (backend) => backend.unsubscribeEvent(input)),
};

export const makeHostedMcp = (
  beforeExecute?: McpOptions["beforeExecute"],
  limits: McpOptions["limits"] = defaultMcpLimits,
  sessions?: McpOptions["sessions"],
  interactions?: McpOptions["interactions"],
  maxSessions?: McpOptions["maxSessions"],
) =>
  makeMcp({
    backend: requestBackend,
    ...(beforeExecute === undefined ? {} : { beforeExecute }),
    ...(sessions === undefined ? {} : { sessions }),
    ...(interactions === undefined ? {} : { interactions }),
    ...(maxSessions === undefined ? {} : { maxSessions }),
    caller: requestCaller,
    mode: requestMode,
    instructions: executorIntro,
    limits,
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

export const requestedMcpOrganization = (url: URL): OrganizationReference | undefined => {
  const match = /^\/org\/([^/]+)\/mcp$/.exec(url.pathname);
  if (match === null) return undefined;
  const reference = Schema.decodeUnknownOption(OrganizationReference)(
    decodeURIComponent(match[1] ?? ""),
  );
  return Option.getOrUndefined(reference);
};

export const mcpAccessRefusal = (access: McpAccess, address: McpAddress) =>
  grantRefusal(access.grant) ??
  (Option.isSome(patGrantOf(access.grant.id)) ? unrecordedRefusal(address) : undefined);

export const mcpSessionKey = ({ userId, clientId, access, grant }: McpAccess) =>
  JSON.stringify([userId, clientId, access.organization, grant.id]);

export const dispatchHostedMcp = <E, R>(
  access: McpAccess,
  address: McpAddress,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const authentication = yield* McpAuthentication;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = request.headers["mcp-session-id"];
    const scoped = (fresh: McpAccess) =>
      Effect.gen(function* () {
        const refusal = mcpAccessRefusal(fresh, address);
        if (refusal !== undefined) return yield* new GrantForbidden({ refusal });
        const backend = yield* hostedMcpBackend.pipe(
          Effect.provideService(CurrentOrganization, fresh.access),
          Effect.provideService(CurrentPolicy, fresh.policy),
          Effect.provideService(CurrentUserId, fresh.userId),
          Effect.provideService(CurrentMcpGrant, fresh.grant.id),
          Effect.provideService(CurrentMcpSession, session),
        );
        return restrictMcpBackend<RequestError, never>(backend, Effect.succeed(fresh.grant));
      });
    const scope = yield* Effect.result(scoped(access));
    if (Result.isFailure(scope)) return yield* refusedMcpRequest(scope.failure);
    const backend = scope.success;
    const services = yield* Effect.context<HostedExecutor | GroupDatabase>().pipe(
      Effect.map(Context.pick(HostedExecutor, GroupDatabase)),
      Effect.map(Context.add(HostedBackground, yield* HostedBackground)),
    );
    const headers = new Headers(request.headers);
    headers.delete("x-executor-organization");
    const caller = callerSpanAttributes(access.access.organization, access.userId);
    yield* Effect.annotateCurrentSpan(caller);
    const named = namedApprovalMode(new URL(request.url, authentication.origin));
    const current = Effect.annotateCurrentSpan(caller).pipe(
      Effect.andThen(
        authentication
          .authenticate(headers, named, access.access.organization)
          .pipe(Effect.annotateSpans(caller)),
      ),
      Effect.flatMap(scoped),
      Effect.provideContext(services),
    );
    const readAhead = (app: AppId) =>
      Effect.flatten(HostedExecutor).pipe(
        Effect.flatMap((executor) => readSelection(executor, access.access.owner, app)),
        Effect.provideContext(services),
        Effect.exit,
        Effect.map((read) => (Exit.isSuccess(read) ? read.value : undefined)),
      );
    const batchedCall = (
      batch: NonNullable<Effect.Success<typeof StatementBatch>>,
      cache: NonNullable<Effect.Success<typeof CallStateCache>>,
      input: Parameters<McpBackend<RequestError>["callTool"]>[0],
      options: Parameters<McpBackend<RequestError>["callTool"]>[1],
    ) =>
      Effect.gen(function* () {
        const executor = yield* Effect.flatten(HostedExecutor).pipe(
          Effect.provideContext(services),
        );
        const owner = access.access.owner;
        const organization = access.access.organization;
        const key = JSON.stringify([mcpSessionKey(access), input.app, accountsKey(input.accounts)]);
        let recheck: Exit.Exit<
          Effect.Success<typeof current>,
          Effect.Error<typeof current>
        > = Exit.die("unreachable");
        let fold: Effect.Success<typeof FoldReadAhead>;
        const round = (known: CallState | undefined, first: boolean) =>
          Effect.gen(function* () {
            const sdk = executor[PrefetchHost].invocation({ app: input.app, owner, known });
            const leaves: Array<Effect.Effect<unknown>> = [
              ...(first
                ? [
                    Effect.exit(current).pipe(
                      Effect.map((exit) => {
                        recheck = exit;
                      }),
                    ),
                  ]
                : []),
              ...sdk.leaves.map((leaf) =>
                Effect.provideService(leaf, CurrentUserId, access.userId),
              ),
            ];
            if (first)
              leaves.push(
                Effect.exit(resourceAuthorityForLinks(organization, access.userId, input.app)).pipe(
                  Effect.map((result) => {
                    fold = { organization, user: access.userId, app: input.app, result };
                  }),
                  Effect.provideContext(services),
                ),
              );
            yield* batch(leaves, { outside: first ? 1 : 0 });
            return yield* sdk.take;
          });
        const resolvedAccounts = (read: Effect.Success<ReturnType<typeof round>>) =>
          read.app === undefined ||
          Result.isFailure(read.app) ||
          fold === undefined ||
          Exit.isFailure(fold.result) ||
          !fold.result.value.access.canUse
            ? Effect.succeed(undefined)
            : callerAccounts(read.app.success, fold.result.value.accounts).pipe(
                Effect.provideService(CurrentPolicy, access.policy),
                Effect.provideService(CurrentUserId, access.userId),
                Effect.provideContext(services),
                Effect.option,
                Effect.map(Option.getOrUndefined),
              );
        const known = cache.get(key);
        let read = yield* round(known, true);
        let rounds = 1;
        const authorized = yield* recheck;
        const live = yield* resolvedAccounts(read);
        if (live !== undefined && (known === undefined || !sameAccounts(known.accounts, live))) {
          read = yield* round({ accounts: live, hint: read.hint }, false);
          rounds = 2;
        }
        const failed =
          read.failed ||
          (fold !== undefined &&
            Exit.isFailure(fold.result) &&
            Cause.findErrorOption(fold.result.cause).pipe(
              Option.exists((error) => error._tag === "StorageError"),
            ));
        if (!failed) {
          cache.delete(key);
          if (live !== undefined) {
            cache.set(key, { accounts: live, hint: read.hint });
            if (cache.size > callStateLimit) cache.delete(cache.keys().next().value!);
          }
        }
        yield* Effect.annotateCurrentSpan({
          "executor.mcp.call.batches": rounds,
          "executor.mcp.call.batch_discarded": failed,
        });
        if (failed || read.app === undefined) return yield* authorized.callTool(input, options);
        return yield* authorized.callTool(input, options).pipe(
          Effect.provideService(SelectionReadAhead, {
            owner,
            app: input.app,
            current: read.app,
          }),
          Effect.provideService(FoldReadAhead, fold),
          Effect.provideService(InvocationPrefetch, read.invocation),
        );
      });
    const authorized: McpBackend<RequestError> = {
      ...backend,
      listSkills: (input, options) =>
        current.pipe(Effect.flatMap((fresh) => fresh.listSkills(input, options))),
      bundleSkills: (input, options) =>
        current.pipe(Effect.flatMap((fresh) => fresh.bundleSkills(input, options))),
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
        Effect.gen(function* () {
          if (
            (yield* ConcurrentStatements) === undefined ||
            requiresToolMetadata(access.policy.tools, input.app)
          )
            return yield* current.pipe(Effect.flatMap((fresh) => fresh.callTool(input, options)));
          const batch = yield* StatementBatch;
          const cache = yield* CallStateCache;
          if (batch !== undefined && cache !== undefined)
            return yield* batchedCall(batch, cache, input, options);
          const [fresh, read] = yield* Effect.all([current, readAhead(input.app)], {
            concurrency: "unbounded",
          });
          return yield* fresh
            .callTool(input, options)
            .pipe(Effect.provideService(SelectionReadAhead, read));
        }).pipe(statementGroup),
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
      Effect.provideService(
        RequestMode,
        access.grant.target.kind === "mcp" ? access.grant.target.mode : undefined,
      ),
      Effect.provideService(McpRequestAttributes, caller),
      Effect.provideService(CurrentUsage, { source: "mcp", client_id: access.clientId }),
    );
  });

export const mcpChallenge = Effect.gen(function* () {
  const auth = yield* McpAuthentication;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const address = requestedMcpAddress(new URL(request.url, auth.origin));
  if (address === undefined) return invalidAddress;
  return HttpServerResponse.empty({
    status: 401,
    headers: {
      "www-authenticate": `Bearer resource_metadata="${mcpResourceMetadataUrl(requestResourceOrigin(auth.resourceOrigins.mcp, request.headers.host), address)}", scope="mcp offline_access"`,
    },
  });
});

const invalidAddress = HttpServerResponse.jsonUnsafe(
  { error: "Unsupported elicitation_mode or connection." },
  { status: 400 },
);

export const authenticatedMcp = <E, R>(
  handle: (
    access: McpAccess,
    address: McpAddress,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const auth = yield* McpAuthentication;
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.origin !== undefined && request.headers.origin !== auth.origin)
      return yield* Effect.as(
        recordAuthFailure("origin_mismatch"),
        HttpServerResponse.empty({ status: 403 }),
      );
    const url = new URL(request.url, auth.origin);
    const address = requestedMcpAddress(url);
    if (address === undefined) return invalidAddress;
    const hashes = new Map<string, string>();
    const access = yield* Effect.result(
      auth.authenticate(
        new Headers(request.headers),
        namedApprovalMode(url),
        requestedMcpOrganization(url),
      ),
    ).pipe(Effect.provideService(BearerHashes, hashes));
    if (Result.isSuccess(access))
      return yield* handle(access.success, address).pipe(
        Effect.provideService(BearerHashes, hashes),
      );
    if (access.failure._tag === "McpUnauthorized") return yield* mcpChallenge;
    return yield* refusedMcpRequest(access.failure);
  }).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")));

export const mcpWhoami = authenticatedMcp((access, address) =>
  Effect.gen(function* () {
    const refusal = mcpAccessRefusal(access, address);
    if (refusal !== undefined) return yield* refusedMcpRequest(new GrantForbidden({ refusal }));
    const auth = yield* McpAuthentication;
    return yield* auth.describe(access).pipe(
      Effect.map((described) =>
        HttpServerResponse.jsonUnsafe(Schema.encodeSync(McpWhoami)(described)),
      ),
      Effect.catchTags({
        McpUnauthorized: () => mcpChallenge,
        AuthenticationUnavailable: refusedMcpRequest,
      }),
    );
  }),
);

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
