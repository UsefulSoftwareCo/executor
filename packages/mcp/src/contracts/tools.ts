/** Compose the public MCP surface from its area contracts. */
import type { Effect } from "effect";
import { type McpServer, Toolkit } from "effect/ai";
import type { BrowserDelivery } from "./browser.ts";
import { BrowserCallTool, BrowserExecuteTool, BrowserResumeTool } from "./browser-tools.ts";
import type { McpBackend } from "./backend.ts";
import type { ElicitationMode } from "./elicitation.ts";
import {
  CallTool,
  DescribeTool,
  ExecuteTool,
  NativeCallTool,
  NativeExecuteTool,
  ResumeTool,
  SearchTool,
  type McpLimits,
  type ExecutionRejected,
  type InteractionRecords,
} from "./execute.ts";
import { SkillsTool, type SkillDocument } from "./skills.ts";

/**
 * Public MCP tools and their handler requirements. Declaring them performs no I/O. Search,
 * describe and call expose the catalog a program reaches, so simple work needs no program.
 */
export const McpToolkit = Toolkit.make(
  SkillsTool,
  SearchTool,
  DescribeTool,
  CallTool,
  ExecuteTool,
  ResumeTool,
);

/** Native-mode clients answer prompts directly and cannot submit model-side resume decisions. */
export const NativeMcpToolkit = Toolkit.make(
  SkillsTool,
  SearchTool,
  DescribeTool,
  NativeCallTool,
  NativeExecuteTool,
);

/** Browser mode exposes a collector-only resume tool. */
export const BrowserMcpToolkit = Toolkit.make(
  SkillsTool,
  SearchTool,
  DescribeTool,
  BrowserCallTool,
  BrowserExecuteTool,
  BrowserResumeTool,
);

/** Hosts supply authorized operations and documentation I/O. */
export interface McpOptions {
  /** The server name clients show for this connection; Executor when unset. */
  readonly name?: string;
  readonly backend: McpBackend<Error>;
  /** Admit each new program once. Resumes never call this hook. */
  readonly beforeExecute?: Effect.Effect<void, ExecutionRejected>;
  readonly browser?: BrowserDelivery;
  /** Authenticated principal that owns model and native executions across its MCP sessions. Browser approvals also include the session ID. */
  readonly caller: Effect.Effect<string>;
  /** Sent as the server instructions when a client connects. Hosts send the Executor app's intro. */
  readonly instructions: string;
  readonly limits: McpLimits;
  /**
   * Record a document the skills tool read on the current span. Hosts name only the Executor app's
   * own skills; any other app's skill names are customer data and stay out of telemetry.
   */
  readonly annotateSkillRead: (document: typeof SkillDocument.Type) => Effect.Effect<void>;
  /**
   * Keeps each mode's protocol sessions beyond the host's memory, so a client continues its
   * session after the host restarts. A session belongs to the mode it was opened in. Without
   * one, a restart forgets every session and clients initialize again.
   */
  readonly sessions?: (mode: ElicitationMode) => McpServer.SessionStore;
  /**
   * Keeps a record of the requests the host issued beyond its memory, so a resume after a restart
   * says whether its request expired, was answered or was lost with its program. Without one, a
   * restart forgets them and a late resume reads as `not-found`.
   */
  readonly interactions?: InteractionRecords;
}
