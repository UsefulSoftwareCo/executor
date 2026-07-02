import { Duration, Effect, Match, Option, Schema } from "effect";
import * as Cause from "effect/Cause";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ContentBlockSchema, type ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type {
  jsonSchemaValidator,
  JsonSchemaType,
  JsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import { Validator } from "@cfworker/json-schema";
import * as z from "zod/v4";

import { isToolFile } from "@executor-js/sdk";
import type {
  ElicitationResponse,
  ElicitationHandler,
  ElicitationContext,
  ElicitationRequest,
  ToolFileValue,
} from "@executor-js/sdk";
import type * as Tracer from "effect/Tracer";
import {
  createExecutionEngine,
  formatExecuteResult,
  formatPausedExecution,
  findSkill,
  renderSkillsIndex,
  EXECUTE_SKILL,
  INTEGRATION_INVENTORY_HEADER,
  type ExecutionEngine,
  type ExecutionEngineConfig,
  type ResumeResponse,
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
   * so sub-spans (`executor.integrations.list`, `executor.tools.list`) nest as
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
  /**
   * Controls how elicitation is handled for this MCP connection. The default
   * is model-managed resume, where paused executions expose interaction
   * metadata and the model can call `resume` with the user's response.
   */
  readonly elicitationMode?:
    | {
        readonly mode: "browser";
        readonly approvalUrl: (executionId: string) => string;
      }
    | {
        readonly mode: "model";
      }
    | {
        readonly mode: "native";
      };
  readonly browserApprovalStore?: BrowserApprovalStore;
  /**
   * Host-owned lifecycle for paused executions. The MCP server reports pause
   * boundaries; the host decides whether that means a keepAlive lease, browser
   * wait, durable record, or no-op.
   */
  readonly pausedExecutionHooks?: PausedExecutionHooks;
};

export type ExecutorMcpServerConfig<E extends Cause.YieldableError = Cause.YieldableError> =
  | (ExecutionEngineConfig<E> & SharedMcpServerConfig)
  | ({ readonly engine: ExecutionEngine<E> } & SharedMcpServerConfig)
  | (ExecutionEngineConfig<E> & SharedMcpServerConfig & { readonly stateless: true })
  | ({ readonly engine: ExecutionEngine<E>; readonly stateless: true } & SharedMcpServerConfig);

export type BrowserApprovalStore = {
  readonly takeResponse: (executionId: string) => Effect.Effect<ResumeResponse | null>;
  readonly waitForResponse?: (executionId: string) => Effect.Effect<ResumeResponse | null>;
};

export const PAUSED_APPROVAL_TIMEOUT_MS = 4 * 60 * 1000;
const BROWSER_APPROVAL_WAIT_TIMEOUT_MS = PAUSED_APPROVAL_TIMEOUT_MS + 1000;

export type PausedExecutionHooks = {
  readonly onExecutionPaused?: (executionId: string) => Effect.Effect<void>;
  readonly onResumeStarted?: (executionId: string) => Effect.Effect<void>;
  readonly onResumeSettled?: (executionId: string) => Effect.Effect<void>;
};

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

const capabilitySnapshot = (server: McpServer) => ({
  clientCapabilities: server.server.getClientCapabilities() ?? null,
  elicitationSupport: getElicitationSupport(server),
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
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type FormattedExecuteInput = Parameters<typeof formatExecuteResult>[0];
type ExecuteOutputItem = NonNullable<FormattedExecuteInput["output"]>[number];

const TEXT_FILE_CONTENT_MAX_CHARS = 64_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toolFileName = (file: ToolFileValue): string => file.name ?? "tool-output";

const fileResourceUri = (file: ToolFileValue): string =>
  `executor-file:///${encodeURIComponent(toolFileName(file))}`;

const normalizedMimeType = (file: ToolFileValue): string =>
  file.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";

const toolFileKind = (file: ToolFileValue): "image" | "audio" | "text" | "resource" => {
  const mimeType = normalizedMimeType(file);
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json") ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+xml") ||
    mimeType === "application/javascript" ||
    mimeType === "application/x-javascript" ||
    mimeType === "application/yaml" ||
    mimeType === "application/x-yaml"
  ) {
    return "text";
  }
  return "resource";
};

const bytesFromBase64 = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const decodeTextFile = (file: ToolFileValue): string => {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytesFromBase64(file.data));
  if (text.length <= TEXT_FILE_CONTENT_MAX_CHARS) return text;
  return `${text.slice(0, TEXT_FILE_CONTENT_MAX_CHARS)}\n\n[truncated ${
    text.length - TEXT_FILE_CONTENT_MAX_CHARS
  } characters]`;
};

const toolFileContent = (file: ToolFileValue): ContentBlock[] => {
  const kind = toolFileKind(file);
  if (kind === "image") {
    return [{ type: "image", data: file.data, mimeType: file.mimeType }];
  }
  if (kind === "audio") {
    return [{ type: "audio", data: file.data, mimeType: file.mimeType }];
  }
  if (kind === "text") {
    return [{ type: "text", text: decodeTextFile(file) }];
  }
  return [
    {
      type: "resource",
      resource: {
        uri: fileResourceUri(file),
        mimeType: file.mimeType,
        blob: file.data,
      },
    },
  ];
};

const toolFileSummaryLine = (file: ToolFileValue, index?: number): string => {
  const prefix = index === undefined ? "" : `${index + 1}. `;
  return `${prefix}${toolFileName(file)} (${file.mimeType}, ${file.byteLength} bytes)`;
};

const outputFileContent = (file: ToolFileValue): ContentBlock[] => [
  {
    type: "text",
    text: `File output: ${toolFileSummaryLine(file)}`,
  },
  ...toolFileContent(file),
];

const isFileOutputItem = (
  item: ExecuteOutputItem,
): item is { readonly type: "file"; readonly file: ToolFileValue } =>
  isRecord(item) && item.type === "file" && isToolFile(item.file);

const isMcpContentBlock = (value: unknown): value is ContentBlock =>
  ContentBlockSchema.safeParse(value).success;

const isContentOutputItem = (
  item: ExecuteOutputItem,
): item is { readonly type: "content"; readonly content: ContentBlock } =>
  isRecord(item) && item.type === "content" && isMcpContentBlock(item.content);

const outputItemContent = (item: ExecuteOutputItem): ContentBlock[] => {
  if (isFileOutputItem(item)) {
    return outputFileContent(item.file);
  }
  if (isContentOutputItem(item)) {
    return [item.content];
  }
  return [{ type: "text", text: "Invalid execution output item omitted." }];
};

const toMcpOutputResult = (
  result: FormattedExecuteInput,
  output: readonly ExecuteOutputItem[],
): McpToolResult => {
  const formatted = formatExecuteResult(result);
  const content = output.flatMap(outputItemContent);
  const extraText: string[] = [];
  if (result.error) {
    extraText.push(formatted.text);
  } else if (result.logs && result.logs.length > 0) {
    extraText.push(`Logs:\n${result.logs.join("\n")}`);
  }
  content.push(...extraText.map((text): ContentBlock => ({ type: "text", text })));

  return {
    content,
    structuredContent: formatted.structured,
    isError: formatted.isError || undefined,
  };
};

const toMcpResult = (result: FormattedExecuteInput): McpToolResult => {
  if (result.output && result.output.length > 0) return toMcpOutputResult(result, result.output);
  const formatted = formatExecuteResult(result);
  return {
    content: [{ type: "text", text: formatted.text }],
    structuredContent: formatted.structured,
    isError: formatted.isError || undefined,
  };
};

const toMcpPausedResult = (formatted: ReturnType<typeof formatPausedExecution>): McpToolResult => ({
  content: [{ type: "text", text: formatted.text }],
  structuredContent: formatted.structured,
});

// `execute` failures reaching the MCP host are infra defects — domain
// failures from tools are now expressed as `ToolResult` values (success
// channel) and flow through `formatExecuteResult`. Emit an opaque
// generic plus a fresh correlation id and log the cause out-of-band so
// the model can't read internal context off `.message`.
const newCorrelationId = (): string =>
  Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0");

const defaultResumeApprovalUrl = (executionId: string): string =>
  `/resume/${encodeURIComponent(executionId)}`;

const browserApprovalReturnPrompt =
  "Return text to the user telling them to approve the action at this approvalUrl. Only after you have prompted the user, call the `resume` tool with this executionId; `resume` will wait for the user's browser decision.";

const formatResumeApprovalRequired = (input: {
  readonly executionId: string;
  readonly approvalUrl: string;
}): McpToolResult => ({
  content: [
    {
      type: "text",
      text: [
        "User approval required.",
        "",
        "Tell the user to open this URL while signed in and approve or decline the paused interaction:",
        input.approvalUrl,
        "",
        "Required next steps for this agent:",
        browserApprovalReturnPrompt,
      ].join("\n"),
    },
  ],
  structuredContent: {
    status: "user_approval_required",
    executionId: input.executionId,
    approvalUrl: input.approvalUrl,
    resumePrompt: browserApprovalReturnPrompt,
  },
});

const toMcpFailureResult = (cause: Cause.Cause<unknown>): McpToolResult => {
  const correlationId = newCorrelationId();
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: best-effort defect logging must tolerate non-serializable causes
  try {
    console.error(
      `[executor:mcp] execute defect correlation_id=${correlationId}`,
      Cause.pretty(cause),
    );
  } catch {
    /* ignore logger failures */
  }
  const text = `Internal tool error [${correlationId}]`;
  return {
    content: [{ type: "text", text: `Error: ${text}` }],
    structuredContent: { status: "error", error: text },
    isError: true,
  };
};

// A paused execution lives in the session runtime's memory: it expires when
// the user takes too long to answer, and dies early when the runtime is
// rebuilt (host restart, redeploy). Either way the recovery is the same and
// the model should be told it, not just handed a miss.
const missingExecutionResult = (executionId: string): McpToolResult => ({
  content: [
    {
      type: "text" as const,
      text: [
        `No paused execution: ${executionId}.`,
        "The paused execution expired or was lost when its session was restarted — paused executions only stay resumable for a few minutes.",
        "To recover, run the execute tool again with the original code; if it pauses, a fresh executionId will be issued.",
      ].join(" "),
    },
  ],
  structuredContent: {
    status: "execution_not_found",
    executionId,
    recovery: "re_execute",
  },
  isError: true,
});

// The `skills` tool serves named, static how-to docs (see the execution
// package's skills registry). No name -> the index; a known name -> that
// skill's body; an unknown name -> the index plus a not-found note so the model
// retries with a listed name instead of the same miss.
//
// The skill body IS the payload, returned as plain text content. We do NOT
// attach `structuredContent`: a client that prefers structured output (Claude
// Code does) will surface only that and drop the text, so the long-form guide
// silently fails to load. The not-found case keeps `isError` (a separate field
// clients honor) so a bad name still reads as a failure.
//
// The `execute` skill also gets the live integration inventory appended, the
// same block the execute tool description carries, so a model reading the guide
// sees what is connected without a second round trip.
const skillsResult = (name: string | undefined, executeInventory: string): McpToolResult => {
  const trimmed = name?.trim();
  if (!trimmed) {
    return { content: [{ type: "text", text: renderSkillsIndex() }] };
  }
  const skill = findSkill(trimmed);
  if (!skill) {
    return {
      content: [{ type: "text", text: `No skill named "${trimmed}".\n\n${renderSkillsIndex()}` }],
      isError: true,
    };
  }
  const text =
    skill.name === EXECUTE_SKILL.name && executeInventory.length > 0
      ? `${skill.body}\n\n${executeInventory}`
      : skill.body;
  return { content: [{ type: "text", text }] };
};

/** Pull the live integration inventory block out of the built execute
 *  description (it runs from its header to the end), so the `skills` tool can
 *  re-use it without rebuilding the inventory from the executor. */
const extractInventory = (description: string): string => {
  const index = description.indexOf(INTEGRATION_INVENTORY_HEADER);
  return index === -1 ? "" : description.slice(index).trimEnd();
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
    // The same live integration inventory the description carries, re-used by
    // the `skills` tool so the `execute` guide lists what is connected too.
    const executeInventory = extractInventory(description);

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
    const elicitationMode =
      config.elicitationMode ??
      ({
        mode: "model",
      } as const);
    const onExecutionPaused = (executionId: string): Effect.Effect<void> =>
      config.pausedExecutionHooks?.onExecutionPaused?.(executionId) ?? Effect.void;
    const onResumeStarted = (executionId: string): Effect.Effect<void> =>
      config.pausedExecutionHooks?.onResumeStarted?.(executionId) ?? Effect.void;
    const onResumeSettled = (executionId: string): Effect.Effect<void> =>
      config.pausedExecutionHooks?.onResumeSettled?.(executionId) ?? Effect.void;
    const resumeWithLifecycle = (executionId: string, response: ResumeResponse) =>
      Effect.gen(function* () {
        yield* onResumeStarted(executionId);
        return yield* engine.resume(executionId, response);
      }).pipe(Effect.ensuring(onResumeSettled(executionId)));

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
          elicitationMode: elicitationMode.mode,
          elicitationSupport: getElicitationSupport(server),
          clientCapabilities: server.server.getClientCapabilities() ?? null,
          codeLength: code.length,
        });
        if (elicitationMode.mode === "native") {
          const result = yield* engine.execute(code, {
            onElicitation: makeMcpElicitationHandler(server, debugLog),
          });
          return toMcpResult(result);
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
        if (outcome.status === "paused") {
          yield* Effect.annotateCurrentSpan({
            "mcp.execute.paused": true,
            "mcp.execute.paused_execution_id": outcome.execution.id,
            "mcp.execute.pause_source": "execute",
          });
          yield* onExecutionPaused(outcome.execution.id);
        }
        return outcome.status === "completed"
          ? toMcpResult(outcome.result)
          : elicitationMode.mode === "browser"
            ? yield* requireUserResumeApproval(outcome.execution.id)
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
        const outcome = yield* resumeWithLifecycle(executionId, { action, content });
        if (!outcome) {
          debugLog("resume.missing_execution", { executionId });
          return missingExecutionResult(executionId);
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
        if (outcome.status === "paused") {
          yield* Effect.annotateCurrentSpan({
            "mcp.execute.paused": true,
            "mcp.execute.paused_execution_id": outcome.execution.id,
            "mcp.execute.pause_source": "resume",
          });
          yield* onExecutionPaused(outcome.execution.id);
        }
        return outcome.status === "completed"
          ? toMcpResult(outcome.result)
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

    const requireUserResumeApproval = (executionId: string): Effect.Effect<McpToolResult> =>
      Effect.sync(() => {
        const approvalUrl =
          elicitationMode.mode === "browser"
            ? elicitationMode.approvalUrl(executionId)
            : defaultResumeApprovalUrl(executionId);
        debugLog("resume.user_approval_required", {
          executionId,
          approvalUrl,
          clientCapabilities: server.server.getClientCapabilities() ?? null,
        });
        return formatResumeApprovalRequired({ executionId, approvalUrl });
      }).pipe(
        Effect.withSpan("mcp.host.tool.resume.user_approval_required", {
          attributes: {
            "mcp.tool.name": "resume",
            "mcp.execute.execution_id": executionId,
          },
        }),
      );

    const takeBrowserApprovalResponse = (
      executionId: string,
    ): Effect.Effect<ResumeResponse | null> => {
      return config.browserApprovalStore?.takeResponse(executionId) ?? Effect.succeed(null);
    };

    const waitForBrowserApprovalResponse = (
      executionId: string,
    ): Effect.Effect<ResumeResponse | null> => {
      const waitForResponse = config.browserApprovalStore?.waitForResponse;
      if (!waitForResponse) return takeBrowserApprovalResponse(executionId);

      return waitForResponse(executionId).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(BROWSER_APPROVAL_WAIT_TIMEOUT_MS),
          orElse: () => Effect.succeed(null),
        }),
      );
    };

    const resumeAfterBrowserApproval = (executionId: string): Effect.Effect<McpToolResult, E> =>
      Effect.gen(function* () {
        const response = yield* waitForBrowserApprovalResponse(executionId);
        if (!response) return yield* requireUserResumeApproval(executionId);

        const outcome = yield* resumeWithLifecycle(executionId, response);
        if (!outcome) {
          return missingExecutionResult(executionId);
        }
        if (outcome.status === "paused") {
          yield* Effect.annotateCurrentSpan({
            "mcp.execute.paused": true,
            "mcp.execute.paused_execution_id": outcome.execution.id,
            "mcp.execute.pause_source": "browser_resume",
          });
          yield* onExecutionPaused(outcome.execution.id);
        }
        return outcome.status === "completed"
          ? toMcpResult(outcome.result)
          : yield* requireUserResumeApproval(outcome.execution.id);
      }).pipe(
        Effect.withSpan("mcp.host.tool.resume.browser_approval", {
          attributes: {
            "mcp.tool.name": "resume",
            "mcp.execute.execution_id": executionId,
          },
        }),
      );

    // --- tools ---

    yield* Effect.sync(() =>
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

    yield* Effect.sync(() =>
      server.registerTool(
        "skills",
        {
          description: [
            "Fetch a named how-to skill. Skills hold the long-form guidance that would otherwise bloat another tool's always-loaded description.",
            'Call `skills({ name: "execute" })` for the full guide to writing code for the `execute` tool (search the catalog, call tools, emit results, resume paused runs).',
            "Call with no name to list the available skills.",
          ].join("\n"),
          inputSchema: {
            name: z
              .string()
              .optional()
              .describe('The skill to fetch, e.g. "execute". Omit to list available skills.'),
          },
        },
        ({ name }) => runToolEffect(Effect.succeed(skillsResult(name, executeInventory))),
      ),
    ).pipe(
      Effect.withSpan("mcp.host.register_tool", {
        attributes: { "mcp.tool.name": "skills" },
      }),
    );

    yield* Effect.sync(() => {
      if (elicitationMode.mode === "native") {
        return undefined;
      }

      if (elicitationMode.mode === "model") {
        return server.registerTool(
          "resume",
          {
            description: [
              "Resume a paused execution using the executionId returned by execute.",
              "This connection explicitly allows model-side resume via elicitation_mode=model.",
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
        );
      }

      return server.registerTool(
        "resume",
        {
          description: [
            "Request user approval to resume a paused execution.",
            "Call this with the executionId returned by execute. If the user has not approved in the browser yet, tell them to open the returned approval URL. If they have approved, this returns the resumed execution result.",
            "This connection does not allow the model to choose accept, decline, cancel, or content.",
          ].join("\n"),
          inputSchema: {
            executionId: z.string().describe("The execution ID from the paused result"),
          },
        },
        ({ executionId }) => runToolEffect(resumeAfterBrowserApproval(executionId)),
      );
    }).pipe(
      Effect.withSpan("mcp.host.register_tool", {
        attributes: { "mcp.tool.name": "resume" },
      }),
    );

    yield* Effect.sync(() => {
      console.error(
        "[executor] MCP session mode",
        JSON.stringify({
          ...capabilitySnapshot(server),
          elicitationMode: elicitationMode.mode,
          resumeEnabled: elicitationMode.mode !== "native",
        }),
      );
      debugLog("tool.visibility", {
        clientCapabilities: server.server.getClientCapabilities() ?? null,
        elicitationSupport: getElicitationSupport(server),
        elicitationMode: elicitationMode.mode,
        resumeEnabled: elicitationMode.mode !== "native",
      });
    }).pipe(Effect.withSpan("mcp.host.sync_tool_availability"));

    return server;
  }).pipe(Effect.withSpan("mcp.host.create_executor_server"));
