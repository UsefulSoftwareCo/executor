/**
 * Stateless MCP SDK v2 assembly for the 2026-07-28 protocol era.
 *
 * A later host PR will call {@link buildMcpServerV2} from a
 * `createMcpHandler` `McpServerFactory`, once per request. The factory's
 * `McpRequestContext.requestInfo` exposes the original HTTP request; the host
 * reads its modern `_meta` envelope, extracts `CLIENT_CAPABILITIES_META_KEY`,
 * and passes the request-scoped {@link appsEnabledForClientCapabilities}
 * decision here. This package deliberately does not replace existing v1 host
 * routing.
 */
import { Effect, Match, Option, Schema } from "effect";
import * as Cause from "effect/Cause";
import {
  acceptedContent,
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

import {
  getUiCapability,
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
  type McpAppsClientCapabilities,
  type McpAppToolMeta,
} from "./mcp-apps";
import {
  createExecutorMcpServerAssembly,
  type ExecutorMcpAssembly,
  type ExecutorMcpServerConfig,
  type McpHandlerResult,
  type McpRequestJoinKeys,
  type McpToolResult,
  type NativeExecutionServices,
} from "./tool-server-shared";

const NATIVE_ELICITATION_RESPONSE_KEY = "elicitation";

const NativeRequestState = Schema.Struct({ executionId: Schema.String });
type NativeRequestState = typeof NativeRequestState.Type;
const decodeNativeRequestState = Schema.decodeUnknownOption(NativeRequestState);

type V2RequestContext = McpRequestJoinKeys & {
  readonly serverContext: ServerContext;
};

/** Additional request-scoped inputs required by the SDK v2 assembly. */
export type ExecutorMcpServerV2Config<E extends Cause.YieldableError = Cause.YieldableError> =
  ExecutorMcpServerConfig<E> & {
    /** Whether this request's client can render MCP Apps resources. */
    readonly appsEnabled: boolean;
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
    /** Lifetime of signed continuation state in seconds; the SDK defaults to ten minutes. */
    readonly requestStateTtlSeconds?: number;
  };

/** Decide whether client capabilities advertise support for MCP Apps HTML. */
export const appsEnabledForClientCapabilities = (
  clientCapabilities: McpAppsClientCapabilities | null | undefined,
): boolean => Boolean(getUiCapability(clientCapabilities)?.mimeTypes?.includes(RESOURCE_MIME_TYPE));

const requestJoinKeys = (context: ServerContext): V2RequestContext => ({
  requestId: context.mcpReq.id,
  ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
  serverContext: context,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const v2ToolResult = (result: McpHandlerResult): CallToolResult | InputRequiredResult => result;

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

const createV2Assembly = <E extends Cause.YieldableError>(
  config: ExecutorMcpServerV2Config<E>,
): ExecutorMcpAssembly<McpServer, V2RequestContext> => {
  const requestStateCodec = createRequestStateCodec<NativeRequestState>({
    key: config.requestStateSigningKey,
    ...(config.requestStateTtlSeconds === undefined
      ? {}
      : { ttlSeconds: config.requestStateTtlSeconds }),
    bind: (context) => `${context.mcpReq.method}\u0000${config.requestStatePrincipal}`,
  });
  const verifyRequestState = async (state: string, context: ServerContext) => {
    const decoded = await requestStateCodec.verify(state, context);
    return Effect.runPromise(Schema.decodeUnknownEffect(NativeRequestState)(decoded));
  };
  const server = new McpServer(
    { name: "executor", version: "1.0.0" },
    {
      capabilities: { resources: {}, tools: {} },
      requestState: { verify: verifyRequestState },
    },
  );

  const registerTool: ExecutorMcpAssembly<McpServer, V2RequestContext>["registerTool"] = (
    name,
    toolConfig,
    callback,
  ) => {
    const inputSchema = z.object(toolConfig.inputSchema);
    return server.registerTool<z.ZodObject<z.ZodRawShape>, typeof inputSchema>(
      name,
      { ...toolConfig, inputSchema },
      async (args, context) => v2ToolResult(await callback(args, requestJoinKeys(context))),
    );
  };

  const registerApp: ExecutorMcpAssembly<McpServer, V2RequestContext>["registerAppTool"] = (
    name,
    toolConfig,
    callback,
  ) => {
    const inputSchema = z.object(toolConfig.inputSchema);
    const metadata = normalizedAppMetadata(toolConfig._meta);
    if (!config.appsEnabled && visibilityIncludes(metadata, "model")) {
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
        async (args, context) => v2ToolResult(await callback(args, requestJoinKeys(context))),
      );
    }

    return registerAppTool<typeof inputSchema, z.ZodObject<z.ZodRawShape>>(
      server,
      name,
      { ...toolConfig, inputSchema, _meta: metadata },
      async (args, context) => v2ToolResult(await callback(args, requestJoinKeys(context))),
    );
  };

  const nativeInputRequired = async <NativeE extends Cause.YieldableError>(
    services: NativeExecutionServices<NativeE, V2RequestContext>,
    execution: Parameters<NativeExecutionServices<NativeE, V2RequestContext>["executionPaused"]>[0],
  ): Promise<InputRequiredResult> => {
    const requestState = await requestStateCodec.mint(
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
    era: "v2",
    initialAppsEnabled: config.appsEnabled,
    getClientCapabilities: () => null,
    getElicitationSupport: () => ({ form: true, url: true }),
    getUiCapability: () => (config.appsEnabled ? { mimeTypes: [RESOURCE_MIME_TYPE] } : undefined),
    onInitialized: () => undefined,
    registerTool,
    registerAppTool: registerApp,
    registerAppResource: (name, uri, resourceConfig, callback) => {
      if (!config.appsEnabled) return;
      registerAppResource(server, name, uri, resourceConfig, async () => {
        const result = await callback();
        return { contents: [...result.contents] };
      });
    },
    executeNative: <NativeE extends Cause.YieldableError>(
      services: NativeExecutionServices<NativeE, V2RequestContext>,
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
 * Build one stateless SDK v2 Executor MCP server for a modern request.
 *
 * Hosts must reuse the signing key across every request that can participate
 * in the same native-elicitation continuation flow.
 */
export const buildMcpServerV2 = <E extends Cause.YieldableError>(
  config: ExecutorMcpServerV2Config<E>,
): Effect.Effect<McpServer> =>
  createExecutorMcpServerAssembly(config, () => createV2Assembly(config));
