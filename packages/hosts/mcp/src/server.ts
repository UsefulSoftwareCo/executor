import { Effect, Match, Option, Schema } from "effect";
import * as Cause from "effect/Cause";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  jsonSchemaValidator,
  JsonSchemaType,
  JsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import { Validator } from "@cfworker/json-schema";
import { z } from "zod/v4";

import type {
  ElicitationResponse,
  ElicitationHandler,
  ElicitationContext,
  ElicitationRequest,
} from "@executor-js/sdk";
import type * as Tracer from "effect/Tracer";
import {
  createExecutionEngine,
  formatExecuteResult,
  formatPausedExecution,
  type ExecutionEngine,
  type ExecutionEngineConfig,
} from "@executor-js/execution";

// ---------------------------------------------------------------------------
// Workers-compatible JSON Schema validator (replaces Ajv which uses new Function())
// ---------------------------------------------------------------------------

class CfWorkerJsonSchemaValidator implements jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const validator = new Validator(schema as Record<string, unknown>, "2020-12", false);
    return (input: unknown) => {
      const result = validator.validate(input);
      if (result.valid) {
        return { valid: true, data: input as T, errorMessage: undefined };
      }
      const errorMessage = result.errors.map((e) => `${e.instanceLocation}: ${e.error}`).join("; ");
      return { valid: false, data: undefined, errorMessage };
    };
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type SharedMcpServerConfig = {
  /**
   * Pre-built `execute` tool description. When provided, the factory skips
   * its internal `engine.getDescription` yield. Useful when the caller
   * wants to compute the description inside its own Effect tracer context
   * so sub-spans (`executor.sources.list`, `executor.tools.list`) nest as
   * children of the caller's root span.
   */
  readonly description?: string;
  /**
   * Parent span override for engine calls. The factory captures the
   * caller's context at construction time, but `Effect.runPromiseWith`
   * starts a fresh fiber per SDK callback — so the `currentSpan`
   * FiberRef resets to root unless explicitly anchored.
   *
   * Accepts either a fixed span (per-request McpServer instances) or a
   * getter (session-scoped instances that need to anchor each callback
   * under whichever request triggered it; see the Cloud DO).
   */
  readonly parentSpan?: Tracer.AnySpan | (() => Tracer.AnySpan | undefined);
  /**
   * Enable verbose MCP capability / elicitation debug logging.
   */
  readonly debug?: boolean;
};

export type ExecutorMcpServerConfig<E extends Cause.YieldableError = Cause.YieldableError> =
  | (ExecutionEngineConfig<E> & SharedMcpServerConfig)
  | ({ readonly engine: ExecutionEngine<E> } & SharedMcpServerConfig)
  | (ExecutionEngineConfig<E> & SharedMcpServerConfig & { readonly stateless: true })
  | ({ readonly engine: ExecutionEngine<E>; readonly stateless: true } & SharedMcpServerConfig);

// ---------------------------------------------------------------------------
// Elicitation bridge
// ---------------------------------------------------------------------------

const getElicitationSupport = (server: McpServer): { form: boolean; url: boolean } => {
  const capabilities = server.server.getClientCapabilities();
  if (capabilities === undefined || !capabilities.elicitation) return { form: false, url: false };
  const elicitation = capabilities.elicitation as Record<string, unknown>;
  return { form: Boolean(elicitation.form), url: Boolean(elicitation.url) };
};

const readDebugDefault = (): boolean => {
  if (typeof process === "undefined" || !process.env) return false;
  const value = process.env.EXECUTOR_MCP_DEBUG;
  return value === "1" || value === "true";
};

const supportsManagedElicitation = (server: McpServer): boolean =>
  getElicitationSupport(server).form;

const capabilitySnapshot = (server: McpServer) => ({
  clientCapabilities: server.server.getClientCapabilities() ?? null,
  elicitationSupport: getElicitationSupport(server),
  managedElicitation: supportsManagedElicitation(server),
});

type ElicitInputParams =
  | {
      mode?: "form";
      message: string;
      requestedSchema: { readonly [key: string]: unknown };
    }
  | { mode: "url"; message: string; url: string; elicitationId: string };

const elicitationRequestTag = (request: ElicitationRequest): ElicitationRequest["_tag"] =>
  Match.value(request).pipe(
    Match.tag("UrlElicitation", () => "UrlElicitation" as const),
    Match.tag("FormElicitation", () => "FormElicitation" as const),
    Match.exhaustive,
  );

const requestedSchemaIsNonEmpty = (request: ElicitationRequest): boolean =>
  Match.value(request).pipe(
    Match.tag("FormElicitation", (req) => Object.keys(req.requestedSchema).length > 0),
    Match.tag("UrlElicitation", () => false),
    Match.exhaustive,
  );

const elicitationRequestUrl = (request: ElicitationRequest): string | undefined =>
  Match.value(request).pipe(
    Match.tag("UrlElicitation", (req): string | undefined => req.url),
    Match.tag("FormElicitation", (): string | undefined => undefined),
    Match.exhaustive,
  );

const pausedInteractionKind = (request: ElicitationRequest): ElicitationRequest["_tag"] =>
  elicitationRequestTag(request);

const elicitationRequestToParams: (request: ElicitationRequest) => ElicitInputParams =
  Match.type<ElicitationRequest>().pipe(
    Match.tag("UrlElicitation", (req) => ({
      mode: "url" as const,
      message: req.message,
      url: req.url,
      elicitationId: req.elicitationId,
    })),
    Match.tag("FormElicitation", (req) => ({
      message: req.message,
      // The MCP SDK validates requestedSchema as a JSON Schema with
      // `type: "object"` and `properties`. For approval-only elicitations
      // where no fields are needed, provide a minimal valid schema.
      requestedSchema:
        Object.keys(req.requestedSchema).length === 0
          ? { type: "object" as const, properties: {} }
          : req.requestedSchema,
    })),
    Match.exhaustive,
  );

const makeMcpElicitationHandler =
  (
    server: McpServer,
    debugLog?: (event: string, data: Record<string, unknown>) => void,
  ): ElicitationHandler =>
  (ctx: ElicitationContext): Effect.Effect<typeof ElicitationResponse.Type> => {
    const { url: supportsUrl } = getElicitationSupport(server);

    // If client doesn't support url mode, fall back to a form asking the user
    // to visit the URL manually and confirm when done.
    const params = Match.value(ctx.request).pipe(
      Match.tag(
        "UrlElicitation",
        (req): ElicitInputParams =>
          !supportsUrl
            ? {
                message: `${req.message}\n\nPlease visit this URL:\n${req.url}\n\nClick accept once you have completed the flow.`,
                requestedSchema: { type: "object" as const, properties: {} },
              }
            : elicitationRequestToParams(req),
      ),
      Match.tag("FormElicitation", (req): ElicitInputParams => elicitationRequestToParams(req)),
      Match.exhaustive,
    );

    return Effect.promise(async (): Promise<typeof ElicitationResponse.Type> => {
      const requestTag = elicitationRequestTag(ctx.request);
      debugLog?.("elicitation.request", {
        requestTag,
        supportsUrl,
        message: ctx.request.message,
        hasRequestedSchema: requestedSchemaIsNonEmpty(ctx.request),
        url: elicitationRequestUrl(ctx.request),
        clientCapabilities: server.server.getClientCapabilities() ?? null,
      });

      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: MCP SDK elicitInput is a Promise API; failures become a cancel response
      try {
        const response = await server.server.elicitInput(
          params as Parameters<typeof server.server.elicitInput>[0],
        );

        debugLog?.("elicitation.response", {
          requestTag,
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
      } catch (err) {
        const error = formatBoundaryError(err);
        debugLog?.("elicitation.error", {
          requestTag,
          error,
          clientCapabilities: server.server.getClientCapabilities() ?? null,
        });
        console.error(
          "[executor] elicitInput failed - falling back to cancel.",
          JSON.stringify({
            error,
            requestTag,
            ...capabilitySnapshot(server),
          }),
        );
        return { action: "cancel" as const } as ElicitationResponse;
      }
    });
  };

const formatBoundaryError = (err: unknown): { name?: string; message: string; stack?: string } => {
  // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: SDK Promise rejection supplies unknown JS errors for logging only
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: fallback log formatting for unknown SDK Promise rejection values
  return { message: String(err) };
};

// ---------------------------------------------------------------------------
// MCP result formatting
// ---------------------------------------------------------------------------

type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const toMcpResult = (formatted: ReturnType<typeof formatExecuteResult>): McpToolResult => ({
  content: [{ type: "text", text: formatted.text }],
  structuredContent: formatted.structured,
  isError: formatted.isError || undefined,
});

const toMcpPausedResult = (formatted: ReturnType<typeof formatPausedExecution>): McpToolResult => ({
  content: [{ type: "text", text: formatted.text }],
  structuredContent: formatted.structured,
});

const formatFailureMessage = (value: unknown): string | null => {
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (typeof value === "string" && value.length > 0) return value;
  return null;
};

const toMcpFailureResult = (cause: Cause.Cause<unknown>): McpToolResult => {
  const failure = cause.reasons.find(Cause.isFailReason);
  const text = failure
    ? (formatFailureMessage(failure.error) ?? "Tool execution failed")
    : "Tool execution failed";
  return {
    content: [{ type: "text", text: `Error: ${text}` }],
    structuredContent: { status: "error", error: text },
    isError: true,
  };
};

const JsonObjectFromString = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonObjectString = Schema.decodeUnknownOption(JsonObjectFromString);

const parseJsonContent = (raw: string): Record<string, unknown> | undefined => {
  if (raw === "{}") return undefined;
  const parsed = decodeJsonObjectString(raw);
  return Option.isSome(parsed) ? parsed.value : undefined;
};

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export const createExecutorMcpServer = <E extends Cause.YieldableError>(
  config: ExecutorMcpServerConfig<E>,
): Effect.Effect<McpServer> =>
  Effect.gen(function* () {
    const engine = "engine" in config ? config.engine : createExecutionEngine(config);
    const description =
      config.description ??
      (yield* engine.getDescription.pipe(Effect.withSpan("mcp.host.get_description")));

    // Captured at construction time. SDK callbacks fire later (often
    // deferred past the outer Effect's await), so we use the runtime to
    // re-enter Effect-land at each callback edge.
    const context = yield* Effect.context<never>();
    const debugEnabled = config.debug ?? readDebugDefault();
    const debugLog = (event: string, data: Record<string, unknown>) => {
      if (!debugEnabled) return;
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: debug logging must tolerate non-serializable SDK capability snapshots
      try {
        console.error(`[executor:mcp] ${event} ${JSON.stringify(data)}`);
      } catch {
        console.error(`[executor:mcp] ${event}`, data);
      }
    };

    const resolveParentSpan = (): Tracer.AnySpan | undefined => {
      const ps = config.parentSpan;
      return typeof ps === "function" ? ps() : ps;
    };
    const anchor = <A, EffE>(effect: Effect.Effect<A, EffE>): Effect.Effect<A, EffE> => {
      const parent = resolveParentSpan();
      return parent ? Effect.withParentSpan(effect, parent) : effect;
    };
    const runToolEffect = <EffE>(effect: Effect.Effect<McpToolResult, EffE>) =>
      Effect.runPromiseWith(context)(
        anchor(effect).pipe(
          Effect.catchCause((cause) => Effect.succeed(toMcpFailureResult(cause))),
        ),
      );

    const server = yield* Effect.sync(
      () =>
        new McpServer(
          { name: "executor", version: "1.0.0" },
          {
            capabilities: { tools: {} },
            jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
          },
        ),
    ).pipe(Effect.withSpan("mcp.host.create_server"));

    const executeCode = (code: string): Effect.Effect<McpToolResult, E> =>
      Effect.gen(function* () {
        debugLog("execute.call", {
          managedElicitation: supportsManagedElicitation(server),
          elicitationSupport: getElicitationSupport(server),
          clientCapabilities: server.server.getClientCapabilities() ?? null,
          codeLength: code.length,
        });
        if (supportsManagedElicitation(server)) {
          const result = yield* engine.execute(code, {
            onElicitation: makeMcpElicitationHandler(server, debugLog),
          });
          return toMcpResult(formatExecuteResult(result));
        }
        const outcome = yield* engine.executeWithPause(code);
        debugLog("execute.paused_flow_result", {
          status: outcome.status,
          executionId: outcome.status === "paused" ? outcome.execution.id : undefined,
          interactionKind:
            outcome.status === "paused"
              ? pausedInteractionKind(outcome.execution.elicitationContext.request)
              : undefined,
        });
        return outcome.status === "completed"
          ? toMcpResult(formatExecuteResult(outcome.result))
          : toMcpPausedResult(formatPausedExecution(outcome.execution));
      }).pipe(
        Effect.withSpan("mcp.host.tool.execute", {
          attributes: {
            "mcp.tool.name": "execute",
            "mcp.execute.code_length": code.length,
          },
        }),
      );

    const resumeExecution = (
      executionId: string,
      action: "accept" | "decline" | "cancel",
      content: Record<string, unknown> | undefined,
    ): Effect.Effect<McpToolResult, E> =>
      Effect.gen(function* () {
        debugLog("resume.call", {
          executionId,
          action,
          hasContent: content !== undefined,
          clientCapabilities: server.server.getClientCapabilities() ?? null,
        });
        const outcome = yield* engine.resume(executionId, { action, content });
        if (!outcome) {
          debugLog("resume.missing_execution", { executionId });
          return {
            content: [{ type: "text" as const, text: `No paused execution: ${executionId}` }],
            isError: true,
          } satisfies McpToolResult;
        }
        debugLog("resume.result", {
          executionId,
          status: outcome.status,
          nextExecutionId: outcome.status === "paused" ? outcome.execution.id : undefined,
          interactionKind:
            outcome.status === "paused"
              ? pausedInteractionKind(outcome.execution.elicitationContext.request)
              : undefined,
        });
        return outcome.status === "completed"
          ? toMcpResult(formatExecuteResult(outcome.result))
          : toMcpPausedResult(formatPausedExecution(outcome.execution));
      }).pipe(
        Effect.withSpan("mcp.host.tool.resume", {
          attributes: {
            "mcp.tool.name": "resume",
            "mcp.execute.resume.action": action,
            "mcp.execute.execution_id": executionId,
          },
        }),
      );

    // --- tools ---

    const executeTool = yield* Effect.sync(() =>
      server.registerTool(
        "execute",
        {
          description,
          inputSchema: { code: z.string().trim().min(1) },
        },
        ({ code }) => runToolEffect(executeCode(code)),
      ),
    ).pipe(
      Effect.withSpan("mcp.host.register_tool", {
        attributes: { "mcp.tool.name": "execute" },
      }),
    );

    const resumeTool = yield* Effect.sync(() =>
      server.registerTool(
        "resume",
        {
          description: [
            "Resume a paused execution using the executionId returned by execute.",
            "Never call this without user approval unless they explicitly state otherwise.",
          ].join("\n"),
          inputSchema: {
            executionId: z.string().describe("The execution ID from the paused result"),
            action: z
              .enum(["accept", "decline", "cancel"])
              .describe("How to respond to the interaction"),
            content: z
              .string()
              .describe("Optional JSON-encoded response content for form elicitations")
              .default("{}"),
          },
        },
        ({ executionId, action, content: rawContent }) =>
          runToolEffect(resumeExecution(executionId, action, parseJsonContent(rawContent))),
      ),
    ).pipe(
      Effect.withSpan("mcp.host.register_tool", {
        attributes: { "mcp.tool.name": "resume" },
      }),
    );

    // --- capability-based tool visibility ---

    const syncToolAvailability = () => {
      executeTool.enable();
      if (supportsManagedElicitation(server)) {
        resumeTool.disable();
      } else {
        resumeTool.enable();
      }
      console.error(
        "[executor] MCP capability snapshot",
        JSON.stringify({
          ...capabilitySnapshot(server),
          resumeEnabled: !supportsManagedElicitation(server),
        }),
      );
      debugLog("tool.visibility", {
        clientCapabilities: server.server.getClientCapabilities() ?? null,
        elicitationSupport: getElicitationSupport(server),
        managedElicitation: supportsManagedElicitation(server),
        resumeEnabled: !supportsManagedElicitation(server),
      });
    };

    yield* Effect.sync(() => {
      syncToolAvailability();
      server.server.oninitialized = syncToolAvailability;
    }).pipe(Effect.withSpan("mcp.host.sync_tool_availability"));

    return server;
  }).pipe(Effect.withSpan("mcp.host.create_executor_server"));
