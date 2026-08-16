import { Data, Effect, Match } from "effect";
import * as Cause from "effect/Cause";
import { Validator } from "@cfworker/json-schema";
import {
  getUiCapability,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type {
  jsonSchemaValidator,
  JsonSchemaType,
  JsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import * as z from "zod/v4";

import type { ElicitationContext, ElicitationHandler, ElicitationRequest } from "@executor-js/sdk";
import { ElicitationResponse } from "@executor-js/sdk";

import {
  createExecutorMcpServerAssembly,
  elicitationRequestTag,
  type ExecutorMcpAssembly,
  type ExecutorMcpServerConfig,
  type McpHandlerResult,
  type McpRequestJoinKeys,
  type McpToolResult,
  type NativeExecutionServices,
} from "./tool-server-shared";

export { formatMcpExecutionOutcome, PAUSED_APPROVAL_TIMEOUT_MS } from "./tool-server-shared";
export type {
  BrowserApprovalStore,
  ExecutorMcpServerConfig,
  McpArtifactsPort,
  McpConnectionsPort,
  McpToolResult,
  PausedExecutionHooks,
  ResumeFallbackOutcome,
  ResumeUnavailableStatus,
} from "./tool-server-shared";

// Workers-compatible JSON Schema validator (replaces Ajv, which uses new Function()).
class CfWorkerJsonSchemaValidator implements jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const validator = new Validator(schema as Record<string, unknown>, "2020-12", false);
    return (input: unknown) => {
      const result = validator.validate(input);
      if (result.valid) {
        return { valid: true, data: input as T, errorMessage: undefined };
      }
      const errorMessage = result.errors
        .map((error) => `${error.instanceLocation}: ${error.error}`)
        .join("; ");
      return { valid: false, data: undefined, errorMessage };
    };
  }
}

class McpNativeElicitationTransportError extends Data.TaggedError(
  "McpNativeElicitationTransportError",
)<{
  readonly cause: unknown;
}> {}

type ElicitInputParams =
  | {
      mode?: "form";
      message: string;
      requestedSchema: { readonly [key: string]: unknown };
    }
  | { mode: "url"; message: string; url: string; elicitationId: string };

const requestedSchemaIsNonEmpty = (request: ElicitationRequest): boolean =>
  Match.value(request).pipe(
    Match.tag("FormElicitation", (form) => Object.keys(form.requestedSchema).length > 0),
    Match.tag("UrlElicitation", () => false),
    Match.exhaustive,
  );

const elicitationRequestUrl = (request: ElicitationRequest): string | undefined =>
  Match.value(request).pipe(
    Match.tag("UrlElicitation", (url): string | undefined => url.url),
    Match.tag("FormElicitation", (): string | undefined => undefined),
    Match.exhaustive,
  );

const elicitationRequestToParams: (request: ElicitationRequest) => ElicitInputParams =
  Match.type<ElicitationRequest>().pipe(
    Match.tag("UrlElicitation", (url) => ({
      mode: "url" as const,
      message: url.message,
      url: url.url,
      elicitationId: url.elicitationId,
    })),
    Match.tag("FormElicitation", (form) => ({
      message: form.message,
      requestedSchema:
        Object.keys(form.requestedSchema).length === 0
          ? { type: "object" as const, properties: {} }
          : form.requestedSchema,
    })),
    Match.exhaustive,
  );

const getElicitationSupport = (server: McpServer): { form: boolean; url: boolean } => {
  const capabilities = server.server.getClientCapabilities();
  if (capabilities === undefined || !capabilities.elicitation) return { form: false, url: false };
  const elicitation = capabilities.elicitation as Record<string, unknown>;
  return { form: Boolean(elicitation.form), url: Boolean(elicitation.url) };
};

const formatBoundaryError = (
  error: unknown,
): { name?: string; message: string; stack?: string } => {
  // oxlint-disable-next-line executor/no-instanceof-error -- boundary: SDK Promise rejection supplies unknown JS errors for debug logging only
  if (error instanceof Error) {
    // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: narrowed native Error detail is confined to opt-in debug logging
    return { name: error.name, message: error.message, stack: error.stack };
  }
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: fallback log formatting for unknown SDK Promise rejection values
  return { message: String(error) };
};

const makeMcpElicitationHandler =
  (
    server: McpServer,
    relatedRequestId: string | number,
    debugLog: (event: string, data: Record<string, unknown>) => void,
  ): ElicitationHandler =>
  (context: ElicitationContext): Effect.Effect<typeof ElicitationResponse.Type> => {
    const { url: supportsUrl } = getElicitationSupport(server);
    const params = Match.value(context.request).pipe(
      Match.tag(
        "UrlElicitation",
        (request): ElicitInputParams =>
          supportsUrl
            ? elicitationRequestToParams(request)
            : {
                message: `${request.message}\n\nPlease visit this URL:\n${request.url}\n\nClick accept once you have completed the flow.`,
                requestedSchema: { type: "object" as const, properties: {} },
              },
      ),
      Match.tag(
        "FormElicitation",
        (request): ElicitInputParams => elicitationRequestToParams(request),
      ),
      Match.exhaustive,
    );

    return Effect.promise(async (): Promise<typeof ElicitationResponse.Type> => {
      debugLog("elicitation.request", {
        requestTag: elicitationRequestTag(context.request),
        supportsUrl,
        message: context.request.message,
        hasRequestedSchema: requestedSchemaIsNonEmpty(context.request),
        url: elicitationRequestUrl(context.request),
        clientCapabilities: server.server.getClientCapabilities() ?? null,
      });

      const response = await server.server.elicitInput(
        params as Parameters<typeof server.server.elicitInput>[0],
        { relatedRequestId },
      );
      debugLog("elicitation.response", {
        requestTag: elicitationRequestTag(context.request),
        action: response.action,
        hasContent:
          typeof response.content === "object" &&
          response.content !== null &&
          Object.keys(response.content).length > 0,
      });
      return {
        action: response.action as typeof ElicitationResponse.Type.action,
        content: response.content,
      };
    }).pipe(
      Effect.tapDefect((defect) =>
        Effect.sync(() => {
          debugLog("elicitation.error", {
            requestTag: elicitationRequestTag(context.request),
            error: formatBoundaryError(defect),
            clientCapabilities: server.server.getClientCapabilities() ?? null,
          });
        }),
      ),
      Effect.catchDefect((cause) =>
        // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: ElicitationHandler has no error channel, so retain a classified defect for the MCP result boundary
        Effect.die(new McpNativeElicitationTransportError({ cause })),
      ),
    );
  };

const requestJoinKeys = (extra: {
  readonly requestId: string | number;
  readonly sessionId?: string;
}): McpRequestJoinKeys => ({
  requestId: extra.requestId,
  ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
});

const v1ToolResult = (result: McpHandlerResult): McpToolResult =>
  "resultType" in result
    ? {
        content: [{ type: "text", text: "Input-required results are unavailable on SDK v1." }],
        isError: true,
      }
    : result;

const createV1Assembly = <E extends Cause.YieldableError>(
  config: ExecutorMcpServerConfig<E>,
): ExecutorMcpAssembly<McpServer, McpRequestJoinKeys> => {
  const server = new McpServer(
    { name: "executor", version: "1.0.0" },
    {
      capabilities: { resources: {}, tools: {} },
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );

  const registerTool: ExecutorMcpAssembly<McpServer, McpRequestJoinKeys>["registerTool"] = (
    name,
    toolConfig,
    callback,
  ) => {
    const inputSchema = z.object(toolConfig.inputSchema);
    return server.registerTool<z.ZodObject<z.ZodRawShape>, typeof inputSchema>(
      name,
      { ...toolConfig, inputSchema },
      async (args, extra) => v1ToolResult(await callback(args, requestJoinKeys(extra))),
    );
  };

  const registerApp: ExecutorMcpAssembly<McpServer, McpRequestJoinKeys>["registerAppTool"] = (
    name,
    toolConfig,
    callback,
  ) => {
    const inputSchema = z.object(toolConfig.inputSchema);
    return registerAppTool<z.ZodObject<z.ZodRawShape>, typeof inputSchema>(
      server,
      name,
      { ...toolConfig, inputSchema },
      async (args, extra) => v1ToolResult(await callback(args, requestJoinKeys(extra))),
    );
  };

  return {
    server,
    era: "v1",
    initialAppsEnabled: config.restoredAppsEnabled ?? false,
    getClientCapabilities: () => server.server.getClientCapabilities() ?? null,
    getElicitationSupport: () => getElicitationSupport(server),
    getUiCapability: () =>
      getUiCapability(
        server.server.getClientCapabilities() as
          | (ClientCapabilities & { extensions?: Record<string, unknown> })
          | null,
      ),
    onInitialized: (callback) => {
      server.server.oninitialized = callback;
    },
    registerTool,
    registerAppTool: registerApp,
    registerAppResource: (name, uri, resourceConfig, callback) => {
      registerAppResource(server, name, uri, resourceConfig, async () => {
        const result = await callback();
        return { contents: [...result.contents] };
      });
    },
    executeNative: <NativeE extends Cause.YieldableError>(
      services: NativeExecutionServices<NativeE, McpRequestJoinKeys>,
    ) =>
      services.engine
        .execute(services.code, {
          onElicitation: makeMcpElicitationHandler(
            server,
            services.requestContext.requestId,
            services.debugLog,
          ),
        })
        .pipe(Effect.map(services.complete)),
  };
};

/**
 * Build the legacy SDK v1 Executor MCP tool server.
 *
 * Its public signature and wire behavior remain unchanged; SDK-specific
 * construction and native elicitation are confined to this assembly.
 */
export const createExecutorMcpServer = <E extends Cause.YieldableError>(
  config: ExecutorMcpServerConfig<E>,
): Effect.Effect<McpServer> =>
  createExecutorMcpServerAssembly(config, () => createV1Assembly(config));
