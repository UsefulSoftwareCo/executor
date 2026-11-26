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

export const McpToolkit = Toolkit.make(
  SkillsTool,
  SearchTool,
  DescribeTool,
  CallTool,
  ExecuteTool,
  ResumeTool,
);

export const NativeMcpToolkit = Toolkit.make(
  SkillsTool,
  SearchTool,
  DescribeTool,
  NativeCallTool,
  NativeExecuteTool,
);

export const BrowserMcpToolkit = Toolkit.make(
  SkillsTool,
  SearchTool,
  DescribeTool,
  BrowserCallTool,
  BrowserExecuteTool,
  BrowserResumeTool,
);

export interface McpOptions {
  readonly backend: McpBackend<Error>;
  readonly beforeExecute?: Effect.Effect<void, ExecutionRejected>;
  readonly browser?: BrowserDelivery;
  readonly caller: Effect.Effect<string>;
  readonly mode: Effect.Effect<ElicitationMode>;
  readonly instructions: string;
  readonly limits: McpLimits;
  readonly annotateSkillRead: (document: typeof SkillDocument.Type) => Effect.Effect<void>;
  readonly sessions?: (mode: ElicitationMode) => McpServer.SessionStore;
  readonly maxSessions?: number;
  readonly interactions?: InteractionRecords;
}
