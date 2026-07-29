import { Duration, Effect, Match, Option, Schema } from "effect";
import * as Cause from "effect/Cause";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ContentBlockSchema,
  type ClientCapabilities,
  type ContentBlock,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getUiCapability,
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type {
  jsonSchemaValidator,
  JsonSchemaType,
  JsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import { Validator } from "@cfworker/json-schema";
import * as z from "zod/v4";

import { isToolFile, sanitizeArtifactPreviewMarkup } from "@executor-js/sdk";
import type {
  Artifact,
  ArtifactBinding,
  ArtifactSummary,
  ElicitationResponse,
  ElicitationHandler,
  ElicitationContext,
  ElicitationRequest,
  SaveArtifactInput,
  ToolFileValue,
} from "@executor-js/sdk";
import type * as Tracer from "effect/Tracer";
import {
  createExecutionEngine,
  formatExecuteResult,
  formatPausedExecution,
  formatTtlDuration,
  findSkill,
  renderSkillsIndex,
  EXECUTE_SKILL,
  INTEGRATION_INVENTORY_HEADER,
  type ExecutionEngine,
  type ExecutionEngineConfig,
  type ResumeResponse,
  type ExecutionResult,
  type PausedExecution,
  type PausedExecutionDeadline,
} from "@executor-js/execution";
import {
  MCP_APPS_SHELL_RESOURCE_URI,
  smokeRenderRejection,
  validateArtifactCode,
  type ArtifactSmokeRenderResult,
} from "./create-artifact";
import { TOOL_CALL_CONTRACT_MESSAGE } from "./tool-call-code";
import { resolveArtifactAction } from "./artifact-action";
import {
  extractArtifactRoles,
  resolveArtifactBindings,
  type BindableConnection,
} from "./artifact-bindings";

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
  /**
   * Host-provided approval lease duration. When present, paused payloads carry
   * an absolute deadline and hooks receive the same deadline.
   */
  readonly pausedExecutionLeaseMs?: number;
  /**
   * Optional host-owned model resume fallback. Used by Cloudflare session
   * Durable Objects to route a resume miss to the session that owns the pause.
   */
  readonly resumeFallback?: (
    executionId: string,
    response: ResumeResponse,
  ) => Effect.Effect<ResumeFallbackOutcome | null, unknown>;
  /**
   * Loads the MCP-Apps shell HTML served as the `ui://executor/shell.html`
   * resource. Injected rather than imported: the shell carries React, Recharts
   * and Tailwind, and this package also runs on Workers. Hosts that can serve
   * it pass `loadMcpAppsShellHtml` from `@executor-js/mcp-apps-shell`; hosts
   * that leave it unset simply don't register the resource or the ui tools.
   */
  readonly loadAppShellHtml?: () => Promise<string>;
  /**
   * Renders an artifact once, server-side, before it is saved — so a component
   * that throws on its first render is refused at create time with the real
   * error instead of saving cleanly and dying on the user's page.
   *
   * Injected for the same reason `loadAppShellHtml` is: it needs React,
   * react-dom/server and the whole component barrel, and this package must not
   * drag any of that into the graph of a host that only ever calls `execute`.
   * Hosts that can afford it pass `smokeRenderArtifact` from
   * `@executor-js/mcp-apps-shell`, which loads it behind a dynamic import.
   *
   * Unset means no smoke check: creates are validated statically and saved, as
   * they were before. That is also what happens when the check itself fails —
   * see the fail-open path in `createArtifact`.
   */
  readonly smokeRenderArtifact?: (code: string) => Promise<ArtifactSmokeRenderResult>;
  /**
   * The scoped executor's artifact operations, so `create-artifact` can persist what
   * it renders and `list-artifacts` / `show-artifact` can read it back. Only
   * the three operations the MCP surface needs, so hosts don't have to hand the
   * whole `Executor` across this boundary.
   */
  readonly artifacts?: McpArtifactsPort;
  /**
   * The caller's saved connections, for binding an artifact's integration roles
   * at create time. Structurally satisfied by `executor.connections`; hosts pass
   * the same scoped executor they pass `artifacts`.
   *
   * Absent means `create-artifact` cannot bind, so it refuses code that calls an
   * integration rather than saving an artifact that could never run.
   */
  readonly connections?: McpConnectionsPort;
  /**
   * Builds the web-app deep link for a saved artifact. Clients that can't
   * render MCP Apps get this URL instead of an inline widget. Absent (stdio has
   * no origin at all) means `create-artifact` still persists and reports the id, but
   * has no URL to offer.
   */
  readonly artifactUrl?: (artifactId: string) => string;
};

/**
 * The narrow artifact surface the MCP tools need. Structurally satisfied by
 * `Executor["artifacts"]`, so hosts holding a scoped executor can pass
 * `executor.artifacts` directly.
 */
export type McpArtifactsPort = {
  readonly list: () => Effect.Effect<readonly ArtifactSummary[], unknown>;
  readonly get: (id: string) => Effect.Effect<Artifact, unknown>;
  readonly save: (input: SaveArtifactInput) => Effect.Effect<Artifact, unknown>;
};

/**
 * The connection surface binding needs: list what this caller can reach. The
 * scoped executor has already narrowed it, so an inferred binding can never
 * name a connection the caller couldn't call themselves.
 */
export type McpConnectionsPort = {
  readonly list: () => Effect.Effect<readonly BindableConnection[], unknown>;
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
  readonly onExecutionPaused?: (
    executionId: string,
    deadline: PausedExecutionDeadline | undefined,
  ) => Effect.Effect<void>;
  readonly onResumeStarted?: (executionId: string) => Effect.Effect<void>;
  readonly onResumeSettled?: (executionId: string) => Effect.Effect<void>;
};

export type ResumeUnavailableStatus =
  | "execution_not_found"
  | "execution_expired"
  | "execution_forbidden"
  | "execution_already_settled";

export type ResumeFallbackOutcome =
  | {
      readonly status: "result";
      readonly result: McpToolResult;
    }
  | {
      readonly status: Exclude<ResumeUnavailableStatus, "execution_not_found">;
      readonly ttlMs?: number;
    }
  | {
      readonly status: "execution_not_found";
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

export type McpToolResult = {
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

export const formatMcpExecutionOutcome = (
  outcome: ExecutionResult,
  options?: { readonly pausedDeadline?: PausedExecutionDeadline },
): McpToolResult =>
  outcome.status === "completed"
    ? toMcpResult(outcome.result)
    : toMcpPausedResult(
        formatPausedExecution(outcome.execution, { deadline: options?.pausedDeadline }),
      );

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

const recoveryText =
  "To recover, run the execute tool again with the original code; if it pauses, a fresh executionId will be issued.";

const resumeUnavailableResult = (input: {
  readonly status: ResumeUnavailableStatus;
  readonly executionId: string;
  readonly ttlMs?: number;
}): McpToolResult => {
  const windowMs = input.ttlMs ?? PAUSED_APPROVAL_TIMEOUT_MS;
  const approvalWindow = formatTtlDuration(windowMs);
  const textByStatus: Record<ResumeUnavailableStatus, string[]> = {
    execution_not_found: [
      `Paused execution is unknown: ${input.executionId}.`,
      `Paused executions are only resumable for a limited window; this id may have expired or never existed.`,
      recoveryText,
    ],
    execution_expired: [
      `Paused execution expired: ${input.executionId}.`,
      `Approval windows last ${approvalWindow}; the owning session no longer has a live pause for this executionId.`,
      recoveryText,
    ],
    execution_forbidden: [
      `Paused execution cannot be resumed by this authenticated identity: ${input.executionId}.`,
      "Resume must be called by the same account and organization that owns the paused session.",
    ],
    execution_already_settled: [
      `Paused execution has already settled: ${input.executionId}.`,
      "The resume result is no longer available for replay.",
      "Run execute again only if the result is still needed.",
    ],
  };
  return {
    content: [
      {
        type: "text" as const,
        text: textByStatus[input.status].join(" "),
      },
    ],
    structuredContent: {
      status: input.status,
      executionId: input.executionId,
      ...(input.status === "execution_expired" ? { ttlMs: windowMs } : {}),
      ...(input.status === "execution_forbidden" ? {} : { recovery: "re_execute" }),
    },
    isError: true,
  };
};

const missingExecutionResult = (executionId: string): McpToolResult =>
  resumeUnavailableResult({ status: "execution_not_found", executionId });

const alreadySettledResult = (executionId: string): McpToolResult =>
  resumeUnavailableResult({ status: "execution_already_settled", executionId });

const fallbackOutcomeResult = (
  executionId: string,
  outcome: ResumeFallbackOutcome,
): McpToolResult => {
  if (outcome.status === "result") return outcome.result;
  return resumeUnavailableResult({
    status: outcome.status,
    executionId,
    ttlMs: "ttlMs" in outcome ? outcome.ttlMs : undefined,
  });
};

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

// ---------------------------------------------------------------------------
// Hang-visibility join keys
// ---------------------------------------------------------------------------
// A killed execution exports nothing: OTEL only ships a span when it ends, and
// a Cloudflare deploy/eviction cancels the request without an error, so a hung
// `execute` is invisible in the trace store. Two mitigations live here:
//   1. Every execution-path span carries the JSON-RPC id + transport session id
//      (`mcp.rpc.id`, `mcp.request.session_id`), so a client's
//      `notifications/cancelled` — which names the cancelled request id — can
//      be joined to the exact call it gave up on.
//   2. A zero-duration start marker span (`<completion span name>.start`, a
//      1:1 pairing so "started without finishing" is a single unambiguous
//      query) is emitted the moment execution begins. It ends immediately, so
//      it becomes exportable while the execution is still running; whether it
//      actually ships before a kill depends on the host's span processor
//      draining first (cloud batches on a 1s timer, so markers for executions
//      that survive >1s export, sub-second kills can still lose theirs). A
//      start marker without a matching completion span is a true positive for
//      an execution that died mid-flight.

type McpRequestJoinKeys = {
  readonly requestId: string | number;
  readonly sessionId?: string | undefined;
};

// `mcp.request.session_id` is emitted unconditionally (empty string when the
// transport carries none) to match the worker-side `annotateMcpRequest`
// producer: JSON-RPC ids are small per-session integers, so a row without the
// session key would make `mcp.rpc.id` globally ambiguous.
const joinKeyAttributes = (joinKeys: McpRequestJoinKeys): Record<string, unknown> => ({
  "mcp.rpc.id": String(joinKeys.requestId),
  "mcp.request.session_id": joinKeys.sessionId ?? "",
});

const startMarker = (name: string, attributes: Record<string, unknown>): Effect.Effect<void> =>
  Effect.void.pipe(Effect.withSpan(name, { attributes }));

// ---------------------------------------------------------------------------
// Artifacts / MCP Apps result formatting
// ---------------------------------------------------------------------------
//
// Delivery is negotiated, not branched on by the model: an artifact reaches the
// user as an inline widget when the client renders MCP Apps, and as a link into
// the web app when it doesn't. Both carry `artifactId`, because either way the
// artifact was saved and can be reopened later.

const renderRejectedResult = (reason: string): McpToolResult => ({
  content: [{ type: "text", text: `create-artifact rejected: ${reason}` }],
  structuredContent: { status: "error", error: reason },
  isError: true,
});

/** `execute-action` was handed something other than a single proxy-shaped tool
 *  call. Names the contract rather than just refusing, since the reader is
 *  either a confused iframe or someone probing the app channel by hand. */
const actionRejectedResult = (): McpToolResult => ({
  content: [{ type: "text", text: TOOL_CALL_CONTRACT_MESSAGE }],
  structuredContent: { status: "error", error: "invalid_action_code" },
  isError: true,
});

/**
 * The artifact whose bindings a call must be resolved through is missing or
 * isn't this caller's.
 *
 * One result for both, deliberately: distinguishing "no such artifact" from
 * "not yours" would let the app channel probe for ids that exist.
 */
const actionArtifactUnavailableResult = (): McpToolResult => ({
  content: [
    {
      type: "text",
      text: "This action refers to an artifact that isn't available on this account.",
    },
  ],
  structuredContent: { status: "error", error: "artifact_unavailable" },
  isError: true,
});

/**
 * A role in the artifact's code has no connection behind it.
 *
 * Structured rather than prose-only because the binding UI that ships with
 * sharing renders exactly this: which role failed, for which integration, and
 * what the viewer could bind it to instead. The apps plugin's `BindingError`
 * carries the same three facts for the same reason.
 */
const bindingUnresolvedResult = (input: {
  readonly role: string;
  readonly integration: string;
  readonly message: string;
  readonly candidates: readonly string[];
}): McpToolResult => ({
  content: [
    {
      type: "text",
      text:
        input.candidates.length > 0
          ? `${input.message} Choose one of ${input.candidates.join(", ")}.`
          : input.message,
    },
  ],
  structuredContent: {
    status: "error",
    error: "binding_unresolved",
    role: input.role,
    integration: input.integration,
    candidates: input.candidates,
  },
  isError: true,
});

const renderedInAppResult = (input: {
  readonly code: string;
  readonly artifactId: string;
  readonly title: string;
}): McpToolResult => ({
  content: [
    {
      type: "text",
      text: `Rendered "${input.title}" as an interactive UI component. Saved as artifact ${input.artifactId}.`,
    },
  ],
  structuredContent: { code: input.code, artifactId: input.artifactId },
});

const renderedAsLinkResult = (input: {
  readonly url: string;
  readonly artifactId: string;
  readonly title: string;
}): McpToolResult => ({
  content: [
    {
      type: "text",
      text: [
        `Saved "${input.title}" as artifact ${input.artifactId}.`,
        "This MCP client cannot display MCP Apps, so give the user this URL to open it:",
        input.url,
      ].join("\n"),
    },
  ],
  structuredContent: {
    status: "fallback_url",
    url: input.url,
    artifactId: input.artifactId,
  },
});

const renderedWithoutSurfaceResult = (input: {
  readonly artifactId: string;
  readonly title: string;
}): McpToolResult => ({
  content: [
    {
      type: "text",
      text: [
        `Saved "${input.title}" as artifact ${input.artifactId}.`,
        "This MCP client cannot display MCP Apps and this deployment has no web UI configured, so there is nowhere to show it right now.",
        "Tell the user the artifact was saved and can be opened from a client that supports MCP Apps.",
      ].join("\n"),
    },
  ],
  structuredContent: {
    status: "fallback_unavailable",
    reason: "mcp_apps_unsupported",
    artifactId: input.artifactId,
  },
});

const artifactsUnavailableResult = (): McpToolResult => ({
  content: [
    {
      type: "text",
      text: "Artifacts are not available on this connection.",
    },
  ],
  structuredContent: { status: "error", error: "artifacts_unavailable" },
  isError: true,
});

const artifactListResult = (artifacts: readonly ArtifactSummary[]): McpToolResult => {
  const items = artifacts.map((artifact) => ({
    id: artifact.id,
    title: artifact.title,
    description: artifact.description,
    updatedAt: artifact.updatedAt.toISOString(),
  }));
  const text =
    items.length === 0
      ? "No saved artifacts yet. Use create-artifact to make one."
      : [
          "Saved artifacts:",
          ...items.map(
            (item) =>
              `- ${item.id} — ${item.title}${item.description ? `: ${item.description}` : ""} (updated ${item.updatedAt})`,
          ),
        ].join("\n");
  return { content: [{ type: "text", text }], structuredContent: { artifacts: items } };
};

const artifactNotFoundResult = (id: string): McpToolResult => ({
  content: [
    {
      type: "text",
      text: `No artifact with id "${id}". Call list-artifacts to see what is saved.`,
    },
  ],
  structuredContent: { status: "error", error: "artifact_not_found", id },
  isError: true,
});

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
    const pauseDeadline = (): PausedExecutionDeadline | undefined => {
      const ttlMs = config.pausedExecutionLeaseMs;
      return ttlMs === undefined || ttlMs <= 0
        ? undefined
        : { ttlMs, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
    };
    const onExecutionPaused = (
      executionId: string,
      deadline: PausedExecutionDeadline | undefined,
    ): Effect.Effect<void> =>
      config.pausedExecutionHooks?.onExecutionPaused?.(executionId, deadline) ?? Effect.void;
    const onResumeStarted = (executionId: string): Effect.Effect<void> =>
      config.pausedExecutionHooks?.onResumeStarted?.(executionId) ?? Effect.void;
    const onResumeSettled = (executionId: string): Effect.Effect<void> =>
      config.pausedExecutionHooks?.onResumeSettled?.(executionId) ?? Effect.void;
    const resumeWithLifecycle = (executionId: string, response: ResumeResponse) =>
      Effect.gen(function* () {
        yield* onResumeStarted(executionId);
        return yield* engine.resume(executionId, response);
      }).pipe(Effect.ensuring(onResumeSettled(executionId)));

    const localExecutionAlreadySettled = (executionId: string): Effect.Effect<boolean> =>
      engine.isExecutionSettled?.(executionId) ?? Effect.succeed(false);

    const resumeFallback = (
      executionId: string,
      response: ResumeResponse,
    ): Effect.Effect<ResumeFallbackOutcome | null> =>
      config
        .resumeFallback?.(executionId, response)
        .pipe(Effect.catchCause(() => Effect.succeed(null))) ?? Effect.succeed(null);

    const formatPausedModelResult = (
      execution: PausedExecution,
      source: "execute" | "execute_action" | "resume" | "browser_resume",
    ): Effect.Effect<McpToolResult> =>
      Effect.gen(function* () {
        const deadline = pauseDeadline();
        yield* Effect.annotateCurrentSpan({
          "mcp.execute.paused": true,
          "mcp.execute.paused_execution_id": execution.id,
          "mcp.execute.pause_source": source,
        });
        yield* onExecutionPaused(execution.id, deadline);
        return toMcpPausedResult(formatPausedExecution(execution, { deadline }));
      });

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
            // `resources` is required to serve the MCP-Apps shell at
            // `ui://executor/shell.html`; it stays advertised even when no
            // shell loader is configured so the capability set doesn't vary
            // per host.
            capabilities: { resources: {}, tools: {} },
            jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
          },
        ),
    ).pipe(Effect.withSpan("mcp.host.create_server"));

    const executeCode = (
      code: string,
      extra: McpRequestJoinKeys,
    ): Effect.Effect<McpToolResult, E> =>
      Effect.gen(function* () {
        yield* startMarker("mcp.host.tool.execute.start", {
          "mcp.tool.name": "execute",
          "mcp.execute.code_length": code.length,
        });
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
          const deadline = pauseDeadline();
          yield* Effect.annotateCurrentSpan({
            "mcp.execute.paused": true,
            "mcp.execute.paused_execution_id": outcome.execution.id,
            "mcp.execute.pause_source": "execute",
          });
          yield* onExecutionPaused(outcome.execution.id, deadline);
          return elicitationMode.mode === "browser"
            ? yield* requireUserResumeApproval(outcome.execution.id)
            : toMcpPausedResult(formatPausedExecution(outcome.execution, { deadline }));
        }
        return toMcpResult(outcome.result);
      }).pipe(
        Effect.withSpan("mcp.host.tool.execute", {
          attributes: {
            "mcp.tool.name": "execute",
            "mcp.execute.code_length": code.length,
          },
        }),
        Effect.annotateSpans(joinKeyAttributes(extra)),
      );

    /** What the caller could bind an unresolved role to. Best effort: the
     *  connections port is optional, and a failure to enumerate must not
     *  replace the real error with a different one. */
    const bindingCandidates = (integration: string): Effect.Effect<readonly string[]> =>
      config.connections
        ? config.connections.list().pipe(
            Effect.map((all) =>
              all
                .filter((connection) => connection.integration === integration)
                .map(
                  (connection) =>
                    `${connection.integration}.${connection.owner}.${connection.name}`,
                ),
            ),
            Effect.catchCause(() => Effect.succeed([] as readonly string[])),
          )
        : Effect.succeed([]);

    /** The artifact as THIS caller can read it. A miss and a row owned by
     *  someone else are the same answer, because they are the same query. */
    const loadArtifact = (id: string): Effect.Effect<Artifact | null> =>
      config.artifacts
        ? config.artifacts.get(id).pipe(Effect.catchCause(() => Effect.succeed(null)))
        : Effect.succeed(null);

    // `execute-action` is `execute` as called by the shell rather than by the
    // model, and the difference is who owns approval. The shell renders the
    // approval modal itself in its trusted outer frame, so a pause here must
    // come back as the `waiting_for_interaction` payload the shell knows how to
    // resolve — never as a browser approval URL, which the user would have no
    // way to act on from inside a widget. That holds even when the session's
    // elicitation mode is `browser`, which is why this doesn't just call
    // `executeCode`.
    //
    // The other difference is WIDTH. `execute` takes arbitrary code because the
    // model writes it; this channel takes exactly one proxy-shaped tool call,
    // because that is all a declarative artifact can produce. See
    // `tool-call-code.ts`.
    //
    // The third difference is that the incoming path is not yet an ADDRESS.
    // Artifact code names an integration and, optionally, a role; the tier and
    // connection are held on the artifact row. So this channel re-writes the
    // call against those bindings before executing, and the executed code is
    // built HERE, from a parsed path and a stored binding, never taken from the
    // iframe verbatim. That is what makes the short form safe: an iframe that
    // invented a five-segment address would only be naming a role the artifact
    // has no binding for, and would be refused.
    const executeCodeFromApp = (
      code: string,
      artifactId: string | undefined,
    ): Effect.Effect<McpToolResult, E> =>
      Effect.gen(function* () {
        const resolution = yield* resolveArtifactAction({ code, artifactId, loadArtifact });
        debugLog("execute_action.call", {
          elicitationMode: elicitationMode.mode,
          elicitationSupport: getElicitationSupport(server),
          codeLength: code.length,
          status: resolution.status,
          artifactId: artifactId ?? null,
        });
        if (resolution.status === "invalid_action_code") {
          yield* Effect.annotateCurrentSpan({ "mcp.execute_action.rejected": true });
          return actionRejectedResult();
        }
        if (resolution.status === "artifact_unavailable") {
          return actionArtifactUnavailableResult();
        }
        if (resolution.status === "binding_unresolved") {
          yield* Effect.annotateCurrentSpan({
            "mcp.execute_action.binding_unresolved": true,
            "mcp.execute_action.role": resolution.role,
          });
          return bindingUnresolvedResult({
            role: resolution.role,
            integration: resolution.integration,
            message: resolution.message,
            candidates: yield* bindingCandidates(resolution.integration),
          });
        }
        const boundCode = resolution.code;

        if (elicitationMode.mode === "native") {
          const result = yield* engine.execute(boundCode, {
            onElicitation: makeMcpElicitationHandler(server, debugLog),
          });
          return toMcpResult(result);
        }
        const outcome = yield* engine.executeWithPause(boundCode);
        debugLog("execute_action.paused_flow_result", {
          status: outcome.status,
          executionId: outcome.status === "paused" ? outcome.execution.id : undefined,
          interactionKind:
            outcome.status === "paused"
              ? pausedInteractionKind(outcome.execution.elicitationContext.request)
              : undefined,
        });
        if (outcome.status === "paused") {
          return yield* formatPausedModelResult(outcome.execution, "execute_action");
        }
        return toMcpResult(outcome.result);
      }).pipe(
        Effect.withSpan("mcp.host.tool.execute_action", {
          attributes: {
            "mcp.tool.name": "execute-action",
            "mcp.execute.code_length": code.length,
          },
        }),
      );

    const resumeExecution = (
      executionId: string,
      action: "accept" | "decline" | "cancel",
      content: Record<string, unknown> | undefined,
      extra: McpRequestJoinKeys,
    ): Effect.Effect<McpToolResult, E> =>
      Effect.gen(function* () {
        yield* startMarker("mcp.host.tool.resume.start", {
          "mcp.tool.name": "resume",
          "mcp.execute.execution_id": executionId,
        });
        debugLog("resume.call", {
          executionId,
          action,
          hasContent: content !== undefined,
          clientCapabilities: server.server.getClientCapabilities() ?? null,
        });
        const outcome = yield* resumeWithLifecycle(executionId, { action, content });
        if (!outcome) {
          debugLog("resume.missing_execution", { executionId });
          if (yield* localExecutionAlreadySettled(executionId)) {
            return alreadySettledResult(executionId);
          }
          const fallback = yield* resumeFallback(executionId, { action, content });
          if (fallback) {
            debugLog("resume.fallback_result", { executionId, status: fallback.status });
            return fallbackOutcomeResult(executionId, fallback);
          }
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
          return yield* formatPausedModelResult(outcome.execution, "resume");
        }
        return toMcpResult(outcome.result);
      }).pipe(
        Effect.withSpan("mcp.host.tool.resume", {
          attributes: {
            "mcp.tool.name": "resume",
            "mcp.execute.resume.action": action,
            "mcp.execute.execution_id": executionId,
          },
        }),
        Effect.annotateSpans(joinKeyAttributes(extra)),
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

    const resumeAfterBrowserApproval = (
      executionId: string,
      extra: McpRequestJoinKeys,
    ): Effect.Effect<McpToolResult, E> =>
      Effect.gen(function* () {
        yield* startMarker("mcp.host.tool.resume.browser_approval.start", {
          "mcp.tool.name": "resume",
          "mcp.execute.execution_id": executionId,
        });
        const response = yield* waitForBrowserApprovalResponse(executionId);
        if (!response) return yield* requireUserResumeApproval(executionId);

        const outcome = yield* resumeWithLifecycle(executionId, response);
        if (!outcome) {
          return missingExecutionResult(executionId);
        }
        if (outcome.status === "paused") {
          const deadline = pauseDeadline();
          yield* Effect.annotateCurrentSpan({
            "mcp.execute.paused": true,
            "mcp.execute.paused_execution_id": outcome.execution.id,
            "mcp.execute.pause_source": "browser_resume",
          });
          yield* onExecutionPaused(outcome.execution.id, deadline);
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
        Effect.annotateSpans(joinKeyAttributes(extra)),
      );

    // --- tools ---

    yield* Effect.sync(() =>
      server.registerTool(
        "execute",
        {
          description,
          inputSchema: { code: z.string().trim().min(1) },
        },
        ({ code }, extra) => runToolEffect(executeCode(code, extra)),
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
          ({ executionId, action, content: rawContent }, extra) =>
            runToolEffect(
              resumeExecution(executionId, action, parseJsonContent(rawContent), extra),
            ),
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
        ({ executionId }, extra) => runToolEffect(resumeAfterBrowserApproval(executionId, extra)),
      );
    }).pipe(
      Effect.withSpan("mcp.host.register_tool", {
        attributes: { "mcp.tool.name": "resume" },
      }),
    );

    // --- artifacts / MCP Apps ---
    //
    // These register unconditionally once a shell loader is configured. Whether
    // the client can actually *render* an app is only known after `initialize`,
    // so the app-only tools are toggled in `syncToolAvailability` below; the
    // model-facing three stay enabled either way and fall back to a deep link.

    const artifacts = config.artifacts;

    // Set from the client's advertised capabilities at `initialize`. Read by
    // the render handlers to choose inline widget vs. deep link.
    let appsEnabled = false;
    let executeActionTool: { enable: () => void; disable: () => void } | undefined;
    let executeActionResumeTool: { enable: () => void; disable: () => void } | undefined;

    const saveAndDeliverArtifact = (input: {
      readonly code: string;
      readonly title: string;
      readonly description?: string;
      readonly existingId?: string;
      readonly bindings?: Readonly<Record<string, ArtifactBinding>>;
      /** Sanitized layout markup from the smoke render, when it produced any. */
      readonly preview?: string | null;
    }): Effect.Effect<McpToolResult, unknown> =>
      Effect.gen(function* () {
        if (!artifacts) return artifactsUnavailableResult();
        const saved = yield* artifacts.save({
          ...(input.existingId === undefined ? {} : { id: input.existingId }),
          title: input.title,
          description: input.description ?? null,
          code: input.code,
          ...(input.bindings === undefined ? {} : { bindings: input.bindings }),
          preview: input.preview ?? null,
        });
        yield* Effect.annotateCurrentSpan({
          "mcp.artifact.id": saved.id,
          "mcp.artifact.apps_enabled": appsEnabled,
        });
        return deliverArtifact({ code: saved.code, artifactId: saved.id, title: saved.title });
      });

    const deliverArtifact = (input: {
      readonly code: string;
      readonly artifactId: string;
      readonly title: string;
    }): McpToolResult => {
      if (appsEnabled) return renderedInAppResult(input);
      const url = config.artifactUrl?.(input.artifactId);
      return url
        ? renderedAsLinkResult({ url, artifactId: input.artifactId, title: input.title })
        : renderedWithoutSurfaceResult({ artifactId: input.artifactId, title: input.title });
    };

    /**
     * Bind the integration roles an artifact's code uses, at create time.
     *
     * Binding happens HERE rather than at render time because this is the only
     * moment the author, the code and their connections are all in hand — and
     * because a create that can't bind is a create that would have saved a
     * broken artifact. The model finds out now, with the candidate list, rather
     * than the user finding out later through a query error inside the UI.
     *
     * `artifactId` turns the same call into an update in place. A model tweaking
     * a dashboard has the whole component in hand already — it fetched it with
     * `show-artifact`, edited it, and is calling back with the result — so a
     * separate `update-artifact` tool would take the same four arguments and
     * differ only in whether a row is minted. One tool keeps the catalog small
     * and makes the wrong thing (a copy per tweak) the thing the model has to
     * ask for rather than the thing it gets by default.
     *
     * An update replaces the code outright — v1 keeps no version history — and
     * re-extracts and re-resolves the bindings from the NEW source, because the
     * roles the new code uses are not necessarily the ones the old code did.
     * `title` and `description` are optional on an update and absent means keep
     * what is stored, so a pure code tweak doesn't have to restate them.
     */
    const createArtifact = (input: {
      readonly code: string;
      readonly title?: string;
      readonly description?: string;
      readonly connections?: Readonly<Record<string, string>>;
      readonly artifactId?: string;
    }): Effect.Effect<McpToolResult, unknown> =>
      Effect.gen(function* () {
        // An update reads the existing row FIRST, both to carry its title and
        // description forward and to refuse a foreign id before any work. The
        // refusal is `artifact_unavailable` — the same answer `execute-action`
        // gives — so create-artifact cannot be used to probe which ids exist.
        const existing =
          input.artifactId === undefined ? null : yield* loadArtifact(input.artifactId);
        if (input.artifactId !== undefined && !existing) return actionArtifactUnavailableResult();

        const title = input.title ?? existing?.title;
        if (title === undefined) {
          return renderRejectedResult(
            "title is required when creating an artifact. Give it a short human-readable name.",
          );
        }
        // Only an update inherits; a create with no description stores none.
        const description = input.description ?? existing?.description ?? undefined;

        const rejection = validateArtifactCode(input.code);
        if (rejection) return renderRejectedResult(rejection);

        // Static checks first, then the real one: render it. See
        // `smokeRenderRejection` for what the model is told.
        //
        // FAIL OPEN. The renderer is injected, runs on three different hosts,
        // and is the newest thing in this path — if IT breaks (a missing
        // module, an environment gap on some host), the right outcome is a
        // saved artifact and a logged warning, never a refused create of code
        // that is perfectly good. Only a definite `failed` blocks a save.
        const smoke = config.smokeRenderArtifact;
        // The render that validates the artifact is also the render that
        // previews it: the same pass produces the loading-state markup the
        // gallery draws, so a preview costs nothing beyond sanitizing it.
        let preview: string | null = null;
        if (smoke) {
          const smokeResult: ArtifactSmokeRenderResult = yield* Effect.tryPromise(() =>
            smoke(input.code),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.as(Effect.logWarning("create-artifact smoke render was unavailable", cause), {
                status: "ok",
              } satisfies ArtifactSmokeRenderResult),
            ),
          );
          const renderRejection = smokeRenderRejection(smokeResult);
          if (renderRejection) {
            yield* Effect.annotateCurrentSpan({ "mcp.artifact.smoke_render": "failed" });
            return renderRejectedResult(renderRejection);
          }
          // Fail open, exactly as the verdict does: a preview that cannot be
          // produced or cannot be sanitized is a card that falls back to its
          // schematic, never a create that is refused.
          preview =
            smokeResult.status === "ok" && smokeResult.markup !== undefined
              ? sanitizeArtifactPreviewMarkup(smokeResult.markup)
              : null;
        }

        const saveInput = {
          code: input.code,
          title,
          preview,
          ...(description === undefined ? {} : { description }),
          ...(existing === null ? {} : { existingId: existing.id }),
        };

        const roles = extractArtifactRoles(input.code);
        if (roles.length === 0 && input.connections === undefined) {
          return yield* saveAndDeliverArtifact({ ...saveInput, bindings: {} });
        }

        if (!config.connections) {
          return renderRejectedResult(
            "This connection cannot bind integrations, so an artifact that calls one cannot be saved here.",
          );
        }

        const available = yield* config.connections
          .list()
          .pipe(Effect.catchCause(() => Effect.succeed([] as readonly BindableConnection[])));
        const resolved = resolveArtifactBindings({
          roles,
          connections: input.connections,
          available,
        });
        if (!resolved.ok) return renderRejectedResult(resolved.message);

        yield* Effect.annotateCurrentSpan({
          "mcp.artifact.role_count": roles.length,
        });
        return yield* saveAndDeliverArtifact({ ...saveInput, bindings: resolved.bindings });
      }).pipe(
        Effect.withSpan("mcp.host.tool.create_artifact", {
          attributes: {
            "mcp.tool.name": "create-artifact",
            "mcp.artifact.update": input.artifactId !== undefined,
            "mcp.execute.code_length": input.code.length,
          },
        }),
      );

    const listArtifacts = (): Effect.Effect<McpToolResult, unknown> =>
      Effect.gen(function* () {
        if (!artifacts) return artifactsUnavailableResult();
        return artifactListResult(yield* artifacts.list());
      }).pipe(
        Effect.withSpan("mcp.host.tool.list_artifacts", {
          attributes: { "mcp.tool.name": "list-artifacts" },
        }),
      );

    const showArtifact = (id: string): Effect.Effect<McpToolResult, unknown> =>
      Effect.gen(function* () {
        if (!artifacts) return artifactsUnavailableResult();
        // A miss is the ordinary case (the model guessed an id, or the row was
        // deleted), so it becomes an isError result rather than a defect.
        const artifact: Artifact | null = yield* artifacts
          .get(id)
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (!artifact) return artifactNotFoundResult(id);
        return deliverArtifact({
          code: artifact.code,
          artifactId: artifact.id,
          title: artifact.title,
        });
      }).pipe(
        Effect.withSpan("mcp.host.tool.show_artifact", {
          attributes: { "mcp.tool.name": "show-artifact", "mcp.artifact.id": id },
        }),
      );

    const loadAppShellHtml = config.loadAppShellHtml;

    if (loadAppShellHtml) {
      yield* Effect.sync(() => {
        registerAppResource(
          server,
          "Executor Shell",
          MCP_APPS_SHELL_RESOURCE_URI,
          { mimeType: RESOURCE_MIME_TYPE },
          async () => ({
            contents: [
              {
                uri: MCP_APPS_SHELL_RESOURCE_URI,
                mimeType: RESOURCE_MIME_TYPE,
                text: await loadAppShellHtml(),
                // Zero allowed domains: the shell may open no network
                // connection of its own. Every read and write goes back over
                // the MCP bridge through `execute-action`.
                _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
              },
            ],
          }),
        );
      }).pipe(
        Effect.withSpan("mcp.host.register_resource", {
          attributes: { "mcp.resource.uri": MCP_APPS_SHELL_RESOURCE_URI },
        }),
      );

      yield* Effect.sync(() =>
        registerAppTool(
          server,
          "create-artifact",
          {
            description: [
              "Render an interactive React UI component as an MCP app, and save it as a reusable artifact.",
              'Call `skills({ name: "create-artifact" })` for the full guide: the discovery-then-render protocol, TanStack Query rules, and every component already in scope. Call `skills({ name: "artifact-style" })` for how it must look — artifacts render inside the Executor console and must match its design system.',
              "Write a component named `App` in `code`. Do not import anything and do not paste fetched data into JSX — read it live with `useQuery(tools.<integration>.<tool>.queryOptions(args))`.",
              "Lay it out as an app, not a document: an artifact may be given the whole viewport, so make the root `flex h-full flex-col`, keep headers and filters as ordinary children, and give the one long table or list `flex-1 min-h-0 overflow-auto` — its header then stays put while the rows scroll under it.",
              "Artifact code addresses an INTEGRATION, never a connection: write `tools.vercel.domains.getDomains`, not the full `tools.vercel.user.personalVercel.domains.getDomains` address `execute` uses for discovery. The connection is bound when the artifact is saved, so it stays portable. Code containing a `.user.` or `.org.` segment is rejected.",
              'To use two accounts of the same integration, tag each call site with a role — `tools.linear("prod").issues.list` and `tools.linear("staging").issues.list` — and map every role in `connections`.',
              "All data access is declarative `tools.*`: `.queryOptions()` to read, `.infiniteQueryOptions()` to page through a cursor, `.mutationOptions()` to write. There is no `run()` and no arbitrary code — never hand-roll `useQuery({ queryKey, queryFn })`, or invalidation breaks.",
              "To read every page of a paginated tool, call `useInfiniteQuery(tools.<integration>.<tool>.infiniteQueryOptions(args, { cursorKey, getNextPageParam }))` once and render `data.pages`. Never call hooks inside a loop — a `useQuery` per page is rejected.",
              "To CHANGE an artifact that already exists — a tweak, a fix, a new column — pass its `artifactId` and it is updated in place. Fetch the current source with `show-artifact` first, edit that, and send the whole component back. Never create a second artifact for a revision of an existing one.",
              "Clients that cannot display MCP apps receive a link to the saved artifact instead; pass it to the user.",
            ].join("\n"),
            inputSchema: {
              code: z.string().trim().min(1).describe("The React component source. Export `App`."),
              artifactId: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe(
                  "The artifact to update in place, from `list-artifacts` or a previous create. Omit to create a new one. `code` fully replaces the stored source and the connection bindings are re-resolved from it, so send the complete component, not a fragment.",
                ),
              connections: z
                .record(z.string(), z.string())
                .optional()
                .describe(
                  'Which connection each integration role in `code` uses, as `<integration>.<user|org>.<connection>` (the address `connections.list` reports, minus the leading `tools.`). Keys are roles: the integration slug for an untagged `tools.linear.…`, or the tag for `tools.linear("prod").…`. Optional when you have exactly one connection per integration used — that one binds automatically. Required when you have several, and the error lists them.',
                ),
              title: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe(
                  'Short human-readable name for the artifact, e.g. "Active users dashboard". The user sees this and you match against it later. Required when creating; on an update, omit it to keep the current title.',
                ),
              description: z
                .string()
                .optional()
                .describe(
                  "What this UI shows, in a sentence. Used to find the artifact again on a later request. On an update, omit it to keep the current description.",
                ),
            },
            _meta: {
              ui: { resourceUri: MCP_APPS_SHELL_RESOURCE_URI, visibility: ["model"] },
            },
          },
          ({ code, title, description, connections, artifactId }) =>
            runToolEffect(createArtifact({ code, title, description, connections, artifactId })),
        ),
      ).pipe(
        Effect.withSpan("mcp.host.register_tool", {
          attributes: { "mcp.tool.name": "create-artifact" },
        }),
      );

      yield* Effect.sync(() =>
        server.registerTool(
          "list-artifacts",
          {
            description: [
              "List the saved UI artifacts for this account, newest first.",
              "Match the user's phrasing against the returned titles and descriptions, then call `show-artifact` with that id.",
            ].join("\n"),
            inputSchema: {},
          },
          () => runToolEffect(listArtifacts()),
        ),
      ).pipe(
        Effect.withSpan("mcp.host.register_tool", {
          attributes: { "mcp.tool.name": "list-artifacts" },
        }),
      );

      yield* Effect.sync(() =>
        registerAppTool(
          server,
          "show-artifact",
          {
            description: [
              "Re-render a saved UI artifact by id.",
              "Use `list-artifacts` first to find the id whose title or description matches what the user asked for.",
              "Clients that cannot display MCP apps receive a link to the artifact instead.",
            ].join("\n"),
            inputSchema: {
              id: z.string().trim().min(1).describe("The artifact id from `list-artifacts`."),
            },
            _meta: {
              ui: { resourceUri: MCP_APPS_SHELL_RESOURCE_URI, visibility: ["model"] },
            },
          },
          ({ id }) => runToolEffect(showArtifact(id)),
        ),
      ).pipe(
        Effect.withSpan("mcp.host.register_tool", {
          attributes: { "mcp.tool.name": "show-artifact" },
        }),
      );

      yield* Effect.sync(() => {
        executeActionTool = registerAppTool(
          server,
          "execute-action",
          {
            description:
              "Execute code from the UI shell. Used by interactive components to call tools and run mutations.",
            inputSchema: {
              code: z.string().trim().min(1),
              artifactId: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe(
                  "The artifact making the call. Its stored bindings resolve the integration role in `code` to a connection.",
                ),
            },
            _meta: {
              ui: { resourceUri: MCP_APPS_SHELL_RESOURCE_URI, visibility: ["app"] },
            },
          },
          ({ code, artifactId }) => runToolEffect(executeCodeFromApp(code, artifactId)),
        );

        executeActionResumeTool = registerAppTool(
          server,
          "execute-action-resume",
          {
            description: "Resume an interactive UI action after shell-owned user approval.",
            inputSchema: {
              executionId: z.string().describe("The execution ID from the paused UI action"),
              action: z
                .enum(["accept", "decline", "cancel"])
                .describe("How to respond to the interaction"),
              content: z
                .string()
                .describe("Optional JSON-encoded response content for form elicitations")
                .default("{}"),
            },
            _meta: {
              ui: { resourceUri: MCP_APPS_SHELL_RESOURCE_URI, visibility: ["app"] },
            },
          },
          ({ executionId, action, content: rawContent }, extra) =>
            runToolEffect(
              resumeExecution(executionId, action, parseJsonContent(rawContent), extra),
            ),
        );
      }).pipe(
        Effect.withSpan("mcp.host.register_tool", {
          attributes: { "mcp.tool.name": "execute-action" },
        }),
      );
    }

    // Client capabilities only exist after `initialize`, and `tools/list` is
    // answered from whatever is registered at that moment — so app-only tool
    // visibility has to be re-synced from the `oninitialized` hook rather than
    // decided at construction.
    const syncToolAvailability = () => {
      const clientCapabilities = server.server.getClientCapabilities();
      const uiCapability = getUiCapability(
        clientCapabilities as
          | (ClientCapabilities & { extensions?: Record<string, unknown> })
          | null,
      );
      appsEnabled = Boolean(uiCapability?.mimeTypes?.includes(RESOURCE_MIME_TYPE));

      // `execute-action` is only callable from inside a rendered app, so a
      // client that can't render one should never see it. `create-artifact`,
      // `list-artifacts` and `show-artifact` stay visible regardless: they
      // still persist, and still return something useful (a deep link).
      if (appsEnabled) {
        executeActionTool?.enable();
        executeActionResumeTool?.enable();
      } else {
        executeActionTool?.disable();
        executeActionResumeTool?.disable();
      }

      console.error(
        "[executor] MCP session mode",
        JSON.stringify({
          ...capabilitySnapshot(server),
          elicitationMode: elicitationMode.mode,
          resumeEnabled: elicitationMode.mode !== "native",
        }),
      );
      debugLog("tool.visibility", {
        clientCapabilities: clientCapabilities ?? null,
        elicitationSupport: getElicitationSupport(server),
        elicitationMode: elicitationMode.mode,
        resumeEnabled: elicitationMode.mode !== "native",
        appsSupport: uiCapability ?? null,
        appsEnabled,
        executeActionEnabled: appsEnabled,
      });
    };

    yield* Effect.sync(() => {
      syncToolAvailability();
      server.server.oninitialized = syncToolAvailability;
    }).pipe(Effect.withSpan("mcp.host.sync_tool_availability"));

    return server;
  }).pipe(Effect.withSpan("mcp.host.create_executor_server"));
