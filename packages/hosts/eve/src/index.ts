// ---------------------------------------------------------------------------
// @executor-js/host-eve: expose Executor to a Vercel `eve` agent.
//
// `eve` agents discover one typed tool per file under `agent/tools/*.ts`, where
// the filename becomes the tool name. This host mirrors the Executor MCP host
// (`@executor-js/host-mcp`): instead of projecting Executor's (large) catalog as
// hundreds of eve tool files, it exposes Executor's codemode surface as two
// tools the model drives directly:
//
//   - `execute` runs TypeScript against Executor's sandboxed tools runtime
//     (`tools.search(...)`, `tools.describe.tool(...)`, `tools.github.issues.list(...)`).
//   - `resume` answers an auth/approval pause raised mid-execution, using the
//     `executionId` the paused `execute` result returned.
//
// Both tools are plain objects shaped to satisfy eve's `defineTool` argument, so
// this package never imports `eve` at runtime (it is a beta peer the consuming
// agent already depends on). The factory returns BOTH tools sharing ONE engine:
// a paused execution lives in that engine instance's memory, so `execute` and
// `resume` must be built from the same engine or a resume can never find its
// pause.
// ---------------------------------------------------------------------------

import * as z from "zod/v4";
import { Option, Schema } from "effect";
import type * as Cause from "effect/Cause";
import type { CodeExecutionError, ExecuteResult } from "@executor-js/codemode-core";

import {
  createExecutionEngine,
  formatExecuteResult,
  formatPausedExecution,
  type ExecutionEngine,
  type ExecutionEngineConfig,
  type PausedExecution,
} from "@executor-js/execution/promise";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * What every Executor eve tool returns. `text` is the model-facing render (the
 * same envelope text the MCP host surfaces); `data` is the full structured
 * payload, preserved for eve Agent Runs / `outputSchema` consumers. `toModelOutput`
 * projects this down to just `text` so the model reads the rendered view.
 */
export type ExecutorToolEnvelope = {
  readonly status: string;
  readonly text: string;
  readonly data: Record<string, unknown>;
};

/**
 * A tool definition structurally compatible with eve's `defineTool` argument.
 * Drop one into `agent/tools/<name>.ts` with
 * `export default defineTool(executorTools.execute)`.
 */
export type ExecutorEveTool<Input> = {
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly execute: (input: Input) => Promise<ExecutorToolEnvelope>;
  readonly toModelOutput: (output: ExecutorToolEnvelope) => {
    readonly type: "text";
    readonly value: string;
  };
};

const executeInputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .describe(
      "TypeScript to run against the Executor tools runtime. Discover with " +
        "`tools.search({ query })`, inspect with `tools.describe.tool({ path })`, " +
        "then call typed tools like `tools.github.issues.list({ owner, repo })`. " +
        "Return a value to send it to the model.",
    ),
});

const resumeInputSchema = z.object({
  executionId: z.string().min(1).describe("The executionId returned by a paused execute result."),
  action: z
    .enum(["accept", "decline", "cancel"])
    .describe("How to answer the paused interaction (auth/approval/form)."),
  content: z
    .string()
    .default("{}")
    .describe("Optional JSON object response for form elicitations; defaults to none."),
});

export type ExecuteToolInput = z.infer<typeof executeInputSchema>;
export type ResumeToolInput = z.infer<typeof resumeInputSchema>;

export type ExecutorEveTools = {
  readonly execute: ExecutorEveTool<ExecuteToolInput>;
  readonly resume: ExecutorEveTool<ResumeToolInput>;
};

type SharedConfig = {
  /**
   * Override the `execute` tool description. When omitted, the dynamic
   * description (workflow + configured namespaces) is read from the engine via
   * `getDescription()` and baked in at build time.
   */
  readonly description?: string;
  /**
   * Called when a tool body throws an unexpected defect (not a domain failure,
   * which is already returned as an error envelope). Defaults to `console.error`.
   * The model only ever sees an opaque `Internal tool error [id]`.
   */
  readonly onDefect?: (error: unknown, correlationId: string) => void;
};

export type ExecutorEveToolsConfig<E extends Cause.YieldableError = CodeExecutionError> =
  | ({ readonly engine: ExecutionEngine } & SharedConfig)
  | (ExecutionEngineConfig<E> & SharedConfig);

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

const RESUME_DESCRIPTION = [
  "Resume an Executor execution that paused for auth, approval, or a form.",
  "Call this with the executionId from a paused execute result. Use action",
  '"accept" to proceed (with content matching any requested schema), or',
  '"decline"/"cancel" to reject. After a browser/URL flow, call with "accept".',
].join(" ");

const toCompletedEnvelope = (result: ExecuteResult): ExecutorToolEnvelope => {
  const formatted = formatExecuteResult(result);
  const status =
    typeof formatted.structured.status === "string" ? formatted.structured.status : "completed";
  return { status, text: formatted.text, data: formatted.structured };
};

const toPausedEnvelope = (execution: PausedExecution): ExecutorToolEnvelope => {
  const formatted = formatPausedExecution(execution);
  return { status: "waiting_for_interaction", text: formatted.text, data: formatted.structured };
};

// A paused execution lives in the engine's memory: it expires after a few
// minutes and dies if the host restarts. Either way the recovery is the same,
// so tell the model rather than hand it a bare miss.
const missingExecutionEnvelope = (executionId: string): ExecutorToolEnvelope => ({
  status: "execution_not_found",
  text: [
    `No paused execution: ${executionId}.`,
    "It expired or was lost when its session restarted (paused executions stay resumable only briefly).",
    "Re-run execute with the original code to get a fresh executionId.",
  ].join(" "),
  data: { status: "execution_not_found", executionId, recovery: "re_execute" },
});

const toModelOutput = (
  output: ExecutorToolEnvelope,
): { readonly type: "text"; readonly value: string } => ({
  type: "text",
  value: output.text,
});

const newCorrelationId = (): string =>
  Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0");

const defaultOnDefect = (error: unknown, correlationId: string): void => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: best-effort defect logging must tolerate non-serializable causes
  try {
    console.error(`[executor:eve] tool defect correlation_id=${correlationId}`, error);
  } catch {
    /* ignore logger failures */
  }
};

// `execute`/`resume` failures reaching the eve host are infra defects. Domain
// failures from tools come back as success-channel error envelopes via
// `formatExecuteResult`. Emit an opaque generic plus a correlation id and log
// the cause out-of-band so the model can't read internal context off it.
const runEnvelope = async (
  onDefect: (error: unknown, correlationId: string) => void,
  run: () => Promise<ExecutorToolEnvelope>,
): Promise<ExecutorToolEnvelope> => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the Promise engine orphans typed errors as rejections; catch to keep the agent's tool loop alive
  try {
    return await run();
  } catch (error) {
    const correlationId = newCorrelationId();
    onDefect(error, correlationId);
    const text = `Internal tool error [${correlationId}]`;
    return { status: "error", text: `Error: ${text}`, data: { status: "error", error: text } };
  }
};

// Tool input is model-authored JSON. Decode it through Effect Schema (no
// JSON.parse / try-catch in domain code): the Record schema rejects arrays and
// scalars, and a decode failure (malformed or non-object) degrades to "no
// content" rather than failing the resume. Mirrors the MCP host's parser.
const JsonObjectFromString = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonObjectString = Schema.decodeUnknownOption(JsonObjectFromString);

const parseJsonContent = (raw: string): Record<string, unknown> | undefined => {
  if (raw === "{}") return undefined;
  const parsed = decodeJsonObjectString(raw);
  return Option.isSome(parsed) ? parsed.value : undefined;
};

// ---------------------------------------------------------------------------
// Tool builders
// ---------------------------------------------------------------------------

const buildExecuteTool = (
  engine: ExecutionEngine,
  description: string,
  onDefect: (error: unknown, correlationId: string) => void,
): ExecutorEveTool<ExecuteToolInput> => ({
  description,
  inputSchema: executeInputSchema,
  execute: ({ code }) =>
    runEnvelope(onDefect, async () => {
      const outcome = await engine.executeWithPause(code);
      return outcome.status === "completed"
        ? toCompletedEnvelope(outcome.result)
        : toPausedEnvelope(outcome.execution);
    }),
  toModelOutput,
});

const buildResumeTool = (
  engine: ExecutionEngine,
  onDefect: (error: unknown, correlationId: string) => void,
): ExecutorEveTool<ResumeToolInput> => ({
  description: RESUME_DESCRIPTION,
  inputSchema: resumeInputSchema,
  execute: ({ executionId, action, content }) =>
    runEnvelope(onDefect, async () => {
      const outcome = await engine.resume(executionId, {
        action,
        content: parseJsonContent(content),
      });
      if (outcome === null) return missingExecutionEnvelope(executionId);
      return outcome.status === "completed"
        ? toCompletedEnvelope(outcome.result)
        : toPausedEnvelope(outcome.execution);
    }),
  toModelOutput,
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the Executor `execute` + `resume` tools for a Vercel `eve` agent.
 *
 * Pass either a pre-built Promise engine (`{ engine }`) or the pieces to build
 * one (`{ executor, codeExecutor }`, from `@executor-js/execution/promise`).
 * Both returned tools share the one engine, so a `resume` can always find the
 * pause its `execute` raised.
 *
 * Async because the `execute` description is read from the engine once and
 * baked in (ESM top-level `await` resolves it before eve reads the module's
 * default export). Pass `description` to skip that and stay synchronous-shaped.
 */
export const createExecutorEveTools = async <E extends Cause.YieldableError = CodeExecutionError>(
  config: ExecutorEveToolsConfig<E>,
): Promise<ExecutorEveTools> => {
  const engine = "engine" in config ? config.engine : createExecutionEngine(config);
  const description = config.description ?? (await engine.getDescription());
  const onDefect = config.onDefect ?? defaultOnDefect;
  return {
    execute: buildExecuteTool(engine, description, onDefect),
    resume: buildResumeTool(engine, onDefect),
  };
};
