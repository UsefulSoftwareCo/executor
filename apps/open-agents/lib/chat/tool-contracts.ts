import type { LanguageModelUsage, ModelMessage, UIToolInvocation } from "ai";

type AppUITool<Input, Output> = {
  input: Input;
  output: Output;
};

export type ReadToolInput = {
  filePath: string;
  offset?: number;
  limit?: number;
};

export type ReadToolOutput =
  | {
      path: string;
      totalLines: number;
      content: string;
      truncated: boolean;
      nextOffset?: number;
    }
  | {
      error: string;
    };

export type WriteToolInput = {
  filePath: string;
  content: string;
};

export type WriteToolOutput =
  | {
      path: string;
      existed: boolean;
    }
  | {
      error: string;
    };

export type GlobToolInput = {
  pattern: string;
  path?: string;
  limit?: number;
};

export type GlobToolOutput =
  | {
      content: string;
      count: number;
      path: string;
      truncated: boolean;
    }
  | {
      error: string;
    };

export type GrepToolInput = {
  pattern: string;
  path: string;
  glob?: string;
  context?: number;
  ignoreCase?: boolean;
  limit?: number;
  literal?: boolean;
};

export type GrepToolOutput =
  | {
      content: string;
      matchCount: number;
      path: string;
      truncated: boolean;
    }
  | {
      error: string;
    };

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type TodoItem = {
  content: string;
  priority: "high" | "medium" | "low";
  status: TodoStatus;
};

export type TodoWriteToolInput = {
  todos?: TodoItem[];
};

export type TodoWriteToolOutput = {
  counts: {
    cancelled: number;
    completed: number;
    in_progress: number;
    pending: number;
    total: number;
  };
  todos: TodoItem[];
};

export type SkillToolInput = {
  skill: string;
  args?: string;
};

export type SkillToolOutput =
  | string
  | {
      error: string;
    };

export type WebFetchToolInput = {
  url: string;
  format?: "markdown" | "text" | "html";
  timeout?: number;
};

export type WebFetchToolOutput =
  | {
      content: string;
      contentType: string;
      url: string;
      truncated: boolean;
    }
  | {
      error: string;
    };

export type InlineQuestionOption = {
  id: string;
  label: string;
  description?: string;
};

export type AskUserQuestionInput = {
  prompt: string;
  options?: InlineQuestionOption[];
  allowFreeform?: boolean;
};

export type AskUserQuestionOutput =
  | {
      status: "answered" | "ignored";
      optionId?: string;
      text?: string;
    }
  | {
      error: string;
    };

export type BashToolInput = {
  command: string;
};

export type BashToolOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export type TaskPendingToolCall = {
  name: string;
  input: unknown;
};

export type TaskToolOutput = {
  pending?: TaskPendingToolCall;
  toolCallCount?: number;
  startedAt?: number;
  modelId?: string;
  final?: ModelMessage[];
  usage?: LanguageModelUsage;
};

export type TaskToolInput = {
  message: string;
  outputSchema?: unknown;
};

export type OpenAgentsUITools = {
  bash: AppUITool<BashToolInput, BashToolOutput>;
  read_file: AppUITool<ReadToolInput, ReadToolOutput>;
  write_file: AppUITool<WriteToolInput, WriteToolOutput>;
  glob: AppUITool<GlobToolInput, GlobToolOutput>;
  grep: AppUITool<GrepToolInput, GrepToolOutput>;
  agent: AppUITool<TaskToolInput, TaskToolOutput>;
  todo: AppUITool<TodoWriteToolInput, TodoWriteToolOutput>;
  ask_question: AppUITool<AskUserQuestionInput, AskUserQuestionOutput>;
  web_fetch: AppUITool<WebFetchToolInput, WebFetchToolOutput>;
  load_skill: AppUITool<SkillToolInput, SkillToolOutput>;
};

export type TaskToolUIPart = {
  type: "tool-agent";
} & UIToolInvocation<OpenAgentsUITools["agent"]>;
