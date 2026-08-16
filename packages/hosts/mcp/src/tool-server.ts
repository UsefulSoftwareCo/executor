/**
 * MCP server assembly shared by stateless modern requests and sessionful
 * connections. Stateless callers supply request-scoped capability policy;
 * sessionful callers register the full surface once and read negotiated client
 * capabilities from the live server.
 */
import { Data, Effect, Match, Option, Schema } from "effect";
import * as Cause from "effect/Cause";
import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  fromJsonSchema,
  inputRequired,
  inputResponse,
  McpServer,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { ElicitationRequest } from "@executor-js/sdk";

import { mcpResourceKey, type McpResource } from "./seams";
import {
  getUiCapability,
  EXTENSION_ID,
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
  type McpAppsClientCapabilities,
  type McpAppToolMeta,
} from "./mcp-apps";
import {
  buildExecutorMcpTools,
  type ExecutorMcpAssembly,
  type ExecutorMcpToolConfig,
  type McpHandlerResult,
  type McpRequestJoinKeys,
  type McpToolResult,
  type NativeExecutionServices,
} from "./tool-server-core";

export { formatMcpExecutionOutcome, PAUSED_APPROVAL_TIMEOUT_MS } from "./tool-server-core";
export type {
  BrowserApprovalStore,
  ExecutorMcpToolConfig,
  McpArtifactsPort,
  McpConnectionsPort,
  McpToolResult,
  PausedExecutionHooks,
  ResumeFallbackOutcome,
  ResumeUnavailableStatus,
} from "./tool-server-core";

const NATIVE_ELICITATION_RESPONSE_KEY = "elicitation";

const NativeRequestStateSchema = Schema.Struct({ executionId: Schema.String });
/** Verified payload carried by a modern native-elicitation continuation. */
export type NativeRequestState = typeof NativeRequestStateSchema.Type;
const decodeNativeRequestState = Schema.decodeUnknownOption(NativeRequestStateSchema);

const NativeRequestStateCallSchema = Schema.Struct({
  method: Schema.Literal("tools/call"),
  params: Schema.Struct({
    name: Schema.String,
    arguments: Schema.Struct({ code: Schema.String }),
  }),
});
const decodeNativeRequestStateCall = Schema.decodeUnknownOption(NativeRequestStateCallSchema);

type McpServerRequestContext = McpRequestJoinKeys & {
  readonly serverContext: ServerContext;
};

/** Configuration required to build an Executor MCP server. */
export type ExecutorMcpServerConfig<E extends Cause.YieldableError = Cause.YieldableError> =
  ExecutorMcpToolConfig<E> & {
    /** Initial/static MCP Apps policy. Sessionful servers replace it after initialize. */
    readonly appsEnabled: boolean;
    /**
     * Register a connection-lifetime server whose capability-dependent behavior
     * follows the live initialize-negotiated state. Omitted for stateless modern
     * request factories, which keep using {@link appsEnabled} as fixed policy.
     */
    readonly sessionful?: boolean;
    /** HMAC key used to sign opaque native-elicitation continuation state. */
    readonly requestStateSigningKey: Uint8Array | string;
    /**
     * Stable identifier of the authenticated principal this server instance
     * was built for (org/user/subject). Bound into the signed continuation
     * state so a `requestState` minted for one principal is rejected when
     * echoed by another — the spec's user-binding MUST for state that
     * influences authorization. Single-user hosts pass a constant.
     */
    readonly requestStatePrincipal: string;
    /** Closed request binding derived before the modern server is constructed. */
    readonly requestStateBinding?: string;
    /** Lifetime of signed continuation state in seconds; the SDK defaults to ten minutes. */
    readonly requestStateTtlSeconds?: number;
  };

/** Decide whether client capabilities advertise support for MCP Apps HTML. */
export const appsEnabledForClientCapabilities = (
  clientCapabilities: McpAppsClientCapabilities | null | undefined,
): boolean => Boolean(getUiCapability(clientCapabilities)?.mimeTypes?.includes(RESOURCE_MIME_TYPE));

/** Bind modern continuation state to the ownership identity used by MCP hosts. */
export const mcpRequestStatePrincipal = (principal: {
  readonly accountId: string;
  readonly organizationId: string;
}): string => `${principal.accountId}\u0000${principal.organizationId}`;

/** Fields whose exact values bind one modern native-elicitation continuation. */
export interface McpRequestStateBindingInput {
  readonly principal: string;
  readonly resource: McpResource;
  readonly method: string;
  readonly toolName: string;
  readonly codeDigest: string;
}

/** Build the canonical NUL-separated modern continuation binding. */
export const mcpRequestStateBinding = (input: McpRequestStateBindingInput): string =>
  [
    input.principal,
    mcpResourceKey(input.resource),
    input.method,
    input.toolName,
    input.codeDigest,
  ].join("\u0000");

/** Return the lowercase SHA-256 digest used to bind an execute code argument. */
export const mcpCodeDigest = async (code: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Derive a continuation binding from an already-parsed modern tools/call body. */
export const mcpRequestStateBindingFromBody = async (input: {
  readonly body: unknown;
  readonly principal: string;
  readonly resource: McpResource;
}): Promise<string | null> => {
  const call = decodeNativeRequestStateCall(input.body);
  if (Option.isNone(call)) return null;
  return mcpRequestStateBinding({
    principal: input.principal,
    resource: input.resource,
    method: call.value.method,
    toolName: call.value.params.name,
    codeDigest: await mcpCodeDigest(call.value.params.arguments.code),
  });
};

/** Route-level failure verifying untrusted modern continuation state. */
export class McpRequestStateVerificationError extends Data.TaggedError(
  "McpRequestStateVerificationError",
)<{ readonly cause: unknown }> {}

class McpRequestStateBindingError extends Data.TaggedError("McpRequestStateBindingError")<{}> {}

const requestStateBindingForContext = (
  binding: string | undefined,
  principal: string,
  context: ServerContext,
): Promise<string> => {
  if (binding !== undefined) return Promise.resolve(binding);
  if (context.mcpReq.envelope === undefined) {
    return Promise.resolve(`${context.mcpReq.method}\u0000${principal}`);
  }
  return Effect.runPromise(Effect.fail(new McpRequestStateBindingError()));
};

/**
 * Verify and parse a modern continuation before a stateless worker uses its
 * execution id for Durable Object routing.
 */
export const verifyNativeRequestState = (input: {
  readonly state: string;
  readonly body: unknown;
  readonly resource: McpResource;
  readonly requestStateSigningKey: Uint8Array | string;
  readonly requestStatePrincipal: string;
}): Effect.Effect<NativeRequestState, McpRequestStateVerificationError> =>
  Effect.gen(function* () {
    const binding = yield* Effect.tryPromise({
      try: () =>
        mcpRequestStateBindingFromBody({
          body: input.body,
          principal: input.requestStatePrincipal,
          resource: input.resource,
        }),
      catch: (cause) => new McpRequestStateVerificationError({ cause }),
    });
    if (binding === null) {
      return yield* new McpRequestStateVerificationError({
        cause: "invalid request-state binding",
      });
    }
    const codec = createRequestStateCodec<NativeRequestState>({
      key: input.requestStateSigningKey,
      bind: () => binding,
    });
    const decoded = yield* Effect.tryPromise({
      // The route-level verifier has no handler context. Its codec binding is a
      // closed value derived from the parsed call, resource, and principal, so
      // the SDK callback never observes this inert placeholder.
      try: () => Reflect.apply(codec.verify, codec, [input.state, null]) as Promise<unknown>,
      catch: (cause) => new McpRequestStateVerificationError({ cause }),
    });
    return yield* Schema.decodeUnknownEffect(NativeRequestStateSchema)(decoded).pipe(
      Effect.mapError((cause) => new McpRequestStateVerificationError({ cause })),
    );
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const appsClientCapabilitiesFromUnknown = (
  capabilities: unknown,
): McpAppsClientCapabilities | null => {
  if (!isRecord(capabilities)) return null;
  const extensions = capabilities.extensions;
  if (!isRecord(extensions)) return null;
  const ui = extensions[EXTENSION_ID];
  if (!isRecord(ui)) return null;
  const mimeTypes = ui.mimeTypes;
  if (mimeTypes === undefined) return { extensions: { [EXTENSION_ID]: {} } };
  if (!Array.isArray(mimeTypes) || !mimeTypes.every((value) => typeof value === "string")) {
    return null;
  }
  return { extensions: { [EXTENSION_ID]: { mimeTypes } } };
};

const elicitationSupportFromUnknown = (
  capabilities: unknown,
): { readonly form: boolean; readonly url: boolean } => {
  if (!isRecord(capabilities) || !isRecord(capabilities.elicitation)) {
    return { form: false, url: false };
  }
  const elicitation = capabilities.elicitation;
  const hasExplicitModes = "form" in elicitation || "url" in elicitation;
  return {
    form: hasExplicitModes ? Boolean(elicitation.form) : true,
    url: Boolean(elicitation.url),
  };
};

/** Parse the MCP Apps capability subset from an already-decoded modern body. */
export const clientCapabilitiesFromRequestBody = (
  body: unknown,
): McpAppsClientCapabilities | null => {
  if (!isRecord(body)) return null;
  const params = body.params;
  if (!isRecord(params)) return null;
  const metadata = params._meta;
  if (!isRecord(metadata)) return null;
  const capabilities = metadata[CLIENT_CAPABILITIES_META_KEY];
  return appsClientCapabilitiesFromUnknown(capabilities);
};

/** Parse a cloned HTTP request body without consuming the request itself. */
export const requestBodyFromRequest = (request: Request): Effect.Effect<unknown> =>
  Effect.tryPromise({
    try: () => request.clone().json(),
    catch: () => null,
  }).pipe(
    Effect.match({
      onFailure: () => null,
      onSuccess: (body) => body,
    }),
  );

/**
 * Parse the MCP Apps capability subset from a modern request's `_meta`
 * envelope without consuming the request body used by the SDK handler.
 */
export const clientCapabilitiesFromRequest = (
  request: Request,
): Effect.Effect<McpAppsClientCapabilities | null> =>
  requestBodyFromRequest(request).pipe(Effect.map(clientCapabilitiesFromRequestBody));

const requestJoinKeys = (context: ServerContext): McpServerRequestContext => ({
  requestId: context.mcpReq.id,
  ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
  serverContext: context,
});

const appToolMeta = (metadata: Record<string, unknown>): McpAppToolMeta | undefined => {
  const ui = metadata.ui;
  if (!isRecord(ui)) return undefined;
  const resourceUri = typeof ui.resourceUri === "string" ? ui.resourceUri : undefined;
  const visibility = Array.isArray(ui.visibility)
    ? ui.visibility.filter(
        (value): value is "model" | "app" => value === "model" || value === "app",
      )
    : undefined;
  return {
    ...(resourceUri === undefined ? {} : { resourceUri }),
    ...(visibility === undefined ? {} : { visibility }),
  };
};

const normalizedAppMetadata = (metadata: Record<string, unknown>) => {
  const ui = appToolMeta(metadata);
  const legacyResourceUri = metadata[RESOURCE_URI_META_KEY];
  return {
    ...metadata,
    ...(ui === undefined ? {} : { ui }),
    ...(typeof legacyResourceUri === "string"
      ? { [RESOURCE_URI_META_KEY]: legacyResourceUri }
      : {}),
  };
};

const withoutAppMetadata = (metadata: Record<string, unknown>): Record<string, unknown> => {
  const { ui: _ui, [RESOURCE_URI_META_KEY]: _resourceUri, ...rest } = metadata;
  return rest;
};

const visibilityIncludes = (
  metadata: Record<string, unknown>,
  visibility: "model" | "app",
): boolean => appToolMeta(metadata)?.visibility?.includes(visibility) ?? true;

const toolResult = (result: McpHandlerResult): CallToolResult | InputRequiredResult => result;

const elicitationInputRequest = (request: ElicitationRequest) =>
  Match.value(request).pipe(
    Match.tag("FormElicitation", (form) =>
      inputRequired.elicit({
        message: form.message,
        requestedSchema:
          Object.keys(form.requestedSchema).length === 0
            ? fromJsonSchema({ type: "object" as const, properties: {} })
            : fromJsonSchema(form.requestedSchema),
      }),
    ),
    Match.tag("UrlElicitation", (url) =>
      inputRequired.elicitUrl({ message: url.message, url: url.url }),
    ),
    Match.exhaustive,
  );

const missingNativeExecution = (executionId: string): McpToolResult => ({
  content: [
    {
      type: "text",
      text: `Paused execution is unknown: ${executionId}. Run execute again to start a fresh flow.`,
    },
  ],
  structuredContent: {
    status: "execution_not_found",
    executionId,
  },
  isError: true,
});

const createMcpAssembly = <E extends Cause.YieldableError>(
  config: ExecutorMcpServerConfig<E>,
): ExecutorMcpAssembly<McpServer, McpServerRequestContext> => {
  const sessionful = config.sessionful ?? false;
  const initialAppsEnabled = sessionful
    ? (config.restoredAppsEnabled ?? config.appsEnabled)
    : config.appsEnabled;
  const requestStateCodec = (binding: string) =>
    createRequestStateCodec<NativeRequestState>({
      key: config.requestStateSigningKey,
      ...(config.requestStateTtlSeconds === undefined
        ? {}
        : { ttlSeconds: config.requestStateTtlSeconds }),
      bind: () => binding,
    });
  const verifyRequestState = async (state: string, context: ServerContext) => {
    const binding = await requestStateBindingForContext(
      config.requestStateBinding,
      config.requestStatePrincipal,
      context,
    );
    const decoded = await requestStateCodec(binding).verify(state, context);
    return Effect.runPromise(Schema.decodeUnknownEffect(NativeRequestStateSchema)(decoded));
  };
  const server = new McpServer(
    { name: "executor", version: "1.0.0" },
    {
      capabilities: { resources: {}, tools: {} },
      requestState: { verify: verifyRequestState },
    },
  );

  const registerTool: ExecutorMcpAssembly<McpServer, McpServerRequestContext>["registerTool"] = (
    name,
    toolConfig,
    callback,
  ) => {
    const inputSchema = z.object(toolConfig.inputSchema);
    return server.registerTool<z.ZodObject<z.ZodRawShape>, typeof inputSchema>(
      name,
      { ...toolConfig, inputSchema },
      async (args, context) => toolResult(await callback(args, requestJoinKeys(context))),
    );
  };

  const registerApp: ExecutorMcpAssembly<McpServer, McpServerRequestContext>["registerAppTool"] = (
    name,
    toolConfig,
    callback,
  ) => {
    const inputSchema = z.object(toolConfig.inputSchema);
    const metadata = normalizedAppMetadata(toolConfig._meta);
    if (!sessionful && !config.appsEnabled && visibilityIncludes(metadata, "model")) {
      const plainMetadata = withoutAppMetadata(metadata);
      return server.registerTool<z.ZodObject<z.ZodRawShape>, typeof inputSchema>(
        name,
        {
          ...toolConfig,
          inputSchema,
          ...(Object.keys(plainMetadata).length === 0
            ? { _meta: undefined }
            : { _meta: plainMetadata }),
        },
        async (args, context) => toolResult(await callback(args, requestJoinKeys(context))),
      );
    }

    return registerAppTool<typeof inputSchema, z.ZodObject<z.ZodRawShape>>(
      server,
      name,
      { ...toolConfig, inputSchema, _meta: metadata },
      async (args, context) => toolResult(await callback(args, requestJoinKeys(context))),
    );
  };

  const nativeInputRequired = async <NativeE extends Cause.YieldableError>(
    services: NativeExecutionServices<NativeE, McpServerRequestContext>,
    execution: Parameters<
      NativeExecutionServices<NativeE, McpServerRequestContext>["executionPaused"]
    >[0],
  ): Promise<InputRequiredResult> => {
    const binding = await requestStateBindingForContext(
      config.requestStateBinding,
      config.requestStatePrincipal,
      services.requestContext.serverContext,
    );
    const requestState = await requestStateCodec(binding).mint(
      { executionId: execution.id },
      services.requestContext.serverContext,
    );
    return inputRequired({
      inputRequests: {
        [NATIVE_ELICITATION_RESPONSE_KEY]: elicitationInputRequest(
          execution.elicitationContext.request,
        ),
      },
      requestState,
    });
  };

  return {
    server,
    initialAppsEnabled,
    getClientCapabilities: () =>
      sessionful ? (server.server.getClientCapabilities() ?? null) : null,
    getElicitationSupport: () =>
      sessionful
        ? elicitationSupportFromUnknown(server.server.getClientCapabilities())
        : { form: true, url: true },
    getUiCapability: () =>
      sessionful
        ? getUiCapability(appsClientCapabilitiesFromUnknown(server.server.getClientCapabilities()))
        : config.appsEnabled
          ? { mimeTypes: [RESOURCE_MIME_TYPE] }
          : undefined,
    onInitialized: (callback) => {
      if (sessionful) server.server.oninitialized = callback;
    },
    registerTool,
    registerAppTool: registerApp,
    registerAppResource: (name, uri, resourceConfig, callback) => {
      if (!sessionful && !config.appsEnabled) return;
      registerAppResource(server, name, uri, resourceConfig, async () => {
        const result = await callback();
        return { contents: [...result.contents] };
      });
    },
    executeNative: <NativeE extends Cause.YieldableError>(
      services: NativeExecutionServices<NativeE, McpServerRequestContext>,
    ) =>
      Effect.gen(function* () {
        const decodedState = decodeNativeRequestState(
          services.requestContext.serverContext.mcpReq.requestState<unknown>(),
        );

        if (Option.isSome(decodedState)) {
          const paused = yield* services.engine.getPausedExecution(decodedState.value.executionId);
          if (!paused) return missingNativeExecution(decodedState.value.executionId);
          const response = inputResponse(
            services.requestContext.serverContext.mcpReq.inputResponses,
            NATIVE_ELICITATION_RESPONSE_KEY,
          );
          if (response.kind === "elicit") {
            const content = Match.value(paused.elicitationContext.request).pipe(
              Match.tag("UrlElicitation", () => response.content),
              Match.tag("FormElicitation", (form) =>
                response.action === "accept"
                  ? acceptedContent(
                      services.requestContext.serverContext.mcpReq.inputResponses,
                      NATIVE_ELICITATION_RESPONSE_KEY,
                      fromJsonSchema<Record<string, unknown>>(
                        Object.keys(form.requestedSchema).length === 0
                          ? { type: "object", properties: {} }
                          : form.requestedSchema,
                      ),
                    )
                  : response.content,
              ),
              Match.exhaustive,
            );
            if (response.action === "accept" && content === undefined) {
              return yield* Effect.promise(() => nativeInputRequired(services, paused));
            }
            const outcome = yield* services.resume(decodedState.value.executionId, {
              action: response.action,
              content,
            });
            if (!outcome) return missingNativeExecution(decodedState.value.executionId);
            if (outcome.status === "completed") return services.complete(outcome.result);
            yield* services.executionPaused(outcome.execution);
            return yield* Effect.promise(() => nativeInputRequired(services, outcome.execution));
          }

          return yield* Effect.promise(() => nativeInputRequired(services, paused));
        }

        const outcome = yield* services.engine.executeWithPause(services.code);
        if (outcome.status === "completed") return services.complete(outcome.result);
        yield* services.executionPaused(outcome.execution);
        return yield* Effect.promise(() => nativeInputRequired(services, outcome.execution));
      }),
  };
};

/**
 * Build one Executor MCP server.
 *
 * Stateless hosts must reuse the signing key across every request that can
 * participate in the same native-elicitation continuation flow. Sessionful
 * hosts keep one instance connected and may use a connection-lifetime key.
 */
export const buildMcpServer = <E extends Cause.YieldableError>(
  config: ExecutorMcpServerConfig<E>,
): Effect.Effect<McpServer> => buildExecutorMcpTools(config, () => createMcpAssembly(config));
