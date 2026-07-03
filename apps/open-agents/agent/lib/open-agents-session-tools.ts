import { posix } from "node:path";
import { createOpenAgentsAuthz, parseActor, type Actor } from "@open-agents/authz";
import { connectSandbox, type Sandbox, type SandboxState } from "@open-agents/sandbox";
import { installConfiguredSessionClis } from "@open-agents/sandbox/session-clis.js";
import type { ToolContext, ToolDefinition } from "eve/tools";
import postgres from "postgres";

type BashToolInput = {
  command: string;
};

type BashToolOutput = {
  exitCode: number;
  stderr: string;
  stdout: string;
  truncated: boolean;
};

type ReadFileToolInput = {
  filePath: string;
  limit?: number;
  offset?: number;
};

type ReadFileToolOutput =
  | {
      content: string;
      nextOffset?: number;
      path: string;
      totalLines: number;
      truncated: boolean;
    }
  | { error: string };

type WriteFileToolInput = {
  content: string;
  filePath: string;
};

type WriteFileToolOutput =
  | {
      existed: boolean;
      path: string;
    }
  | { error: string };

type GlobToolInput = {
  limit?: number;
  path?: string;
  pattern: string;
};

type GlobToolOutput =
  | {
      content: string;
      count: number;
      path: string;
      truncated: boolean;
    }
  | { error: string };

type GrepToolInput = {
  context?: number;
  glob?: string;
  ignoreCase?: boolean;
  limit?: number;
  literal?: boolean;
  path?: string;
  pattern: string;
};

type GrepToolOutput =
  | {
      content: string;
      matchCount: number;
      path: string;
      truncated: boolean;
    }
  | { error: string };

type OpenAgentsSessionSandboxRow = {
  sandboxState: SandboxState | null;
  userId: string;
};

type OpenAgentsSessionToolSql = ReturnType<typeof postgres>;

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_READ_LIMIT = 2_000;
const MAX_LINE_LENGTH = 2_000;
const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SEARCH_LIMIT = 1_000;
const DB_POOL_MAX_CONNECTIONS = 1;
const DB_IDLE_TIMEOUT_SECONDS = 10;

const globalForOpenAgentsSessionTools = globalThis as typeof globalThis & {
  openAgentsSessionCliSetup?: Set<string>;
  openAgentsSessionToolSql?: OpenAgentsSessionToolSql;
};

function getSessionCliSetupCache(): Set<string> {
  return (globalForOpenAgentsSessionTools.openAgentsSessionCliSetup ??= new Set());
}

function getOpenAgentsSessionToolSql(): OpenAgentsSessionToolSql {
  return (globalForOpenAgentsSessionTools.openAgentsSessionToolSql ??= postgres(
    process.env.POSTGRES_URL!,
    {
      idle_timeout: DB_IDLE_TIMEOUT_SECONDS,
      max: DB_POOL_MAX_CONNECTIONS,
    },
  ));
}

function getStringAttribute(
  attributes: Readonly<Record<string, string | readonly string[]>> | undefined,
  key: string,
): string | undefined {
  const value = attributes?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getOpenAgentsActor(ctx: ToolContext): Actor | undefined {
  const auth = ctx.session.auth.initiator ?? ctx.session.auth.current;
  const actorId =
    getStringAttribute(auth?.attributes, "openAgentsActor") ?? auth?.subject ?? auth?.principalId;
  return actorId ? parseActor(actorId) : undefined;
}

function getOpenAgentsSessionId(ctx: ToolContext): string {
  const attributes = ctx.session.auth.initiator?.attributes ?? ctx.session.auth.current?.attributes;
  const sessionId = getStringAttribute(attributes, "openAgentsSessionId");
  if (!sessionId) {
    throw new Error("Open Agents session id is required for workspace tools");
  }
  return sessionId;
}

async function getOpenAgentsSessionSandbox(ctx: ToolContext): Promise<Sandbox> {
  const sessionId = getOpenAgentsSessionId(ctx);
  const actor = getOpenAgentsActor(ctx);
  const sql = getOpenAgentsSessionToolSql();
  const [session] = await sql<OpenAgentsSessionSandboxRow[]>`
    select
      user_id as "userId",
      sandbox_state as "sandboxState"
    from sessions
    where id = ${sessionId}
    limit 1
  `;

  if (!session) {
    throw new Error(`Open Agents session ${sessionId} was not found`);
  }

  if (!actor) {
    throw new Error("Open Agents actor is required for workspace tools");
  }

  const authz = createOpenAgentsAuthz({ sql });
  await createOpenAgentsAuthz({
    anonymousSlackOrgId: await authz.getDefaultOrgId(),
    sql,
  }).requireSessionAccess(actor, sessionId, "write");

  if (!session.sandboxState || session.sandboxState.type !== "vercel") {
    throw new Error(`Open Agents session ${sessionId} does not have an active Vercel sandbox`);
  }

  const setupCache = getSessionCliSetupCache();
  return connectSandbox(session.sandboxState, {
    hooks: {
      afterStart: async (sandbox) => {
        if (setupCache.has(sessionId)) {
          return;
        }
        await installConfiguredSessionClis(sandbox);
        setupCache.add(sessionId);
      },
    },
  });
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!value) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function normalizeSandboxPath(sandbox: Sandbox, rawPath: string | undefined): string {
  const root = posix.normalize(sandbox.workingDirectory);
  const input = rawPath?.trim() || root;
  const normalizedInput = input.replaceAll("\\", "/");
  const absolutePath = posix.isAbsolute(normalizedInput)
    ? posix.normalize(normalizedInput)
    : posix.normalize(posix.join(root, normalizedInput));

  if (absolutePath !== root && !absolutePath.startsWith(`${root}/`)) {
    throw new Error(`Path must be inside ${root}`);
  }

  return absolutePath;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function pathExists(sandbox: Sandbox, path: string): Promise<boolean> {
  try {
    await sandbox.stat(path);
    return true;
  } catch {
    return false;
  }
}

function lineCount(content: string): number {
  if (!content) {
    return 0;
  }
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

function formatNumberedLines(lines: string[], offset: number): string {
  return lines
    .map((line, index) => {
      const content = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...` : line;
      return `${offset + index}: ${content}`;
    })
    .join("\n");
}

const bashTool: ToolDefinition<BashToolInput, BashToolOutput> = {
  description: "Execute a shell command in the Open Agents session sandbox.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      command: {
        description: "The shell command to execute from the sandbox working directory.",
        type: "string",
      },
    },
    required: ["command"],
    type: "object",
  },
  outputSchema: {
    additionalProperties: false,
    properties: {
      exitCode: { type: "number" },
      stderr: { type: "string" },
      stdout: { type: "string" },
      truncated: { type: "boolean" },
    },
    required: ["exitCode", "stderr", "stdout", "truncated"],
    type: "object",
  },
  async execute(input, ctx) {
    const sandbox = await getOpenAgentsSessionSandbox(ctx);
    const result = await sandbox.exec(
      input.command,
      sandbox.workingDirectory,
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
    return {
      exitCode: result.exitCode ?? 1,
      stderr: result.stderr,
      stdout: result.stdout,
      truncated: result.truncated,
    };
  },
};

const readFileTool: ToolDefinition<ReadFileToolInput, ReadFileToolOutput> = {
  description:
    "Read a file from the Open Agents session sandbox. Paths are relative to the sandbox working directory unless absolute.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      filePath: { description: "File path to read.", type: "string" },
      limit: { description: "Maximum number of lines to return.", minimum: 1, type: "integer" },
      offset: {
        description: "1-based line number to start from.",
        minimum: 1,
        type: "integer",
      },
    },
    required: ["filePath"],
    type: "object",
  },
  async execute(input, ctx) {
    try {
      const sandbox = await getOpenAgentsSessionSandbox(ctx);
      const path = normalizeSandboxPath(sandbox, input.filePath);
      const content = await sandbox.readFile(path, "utf-8");
      if (content.includes("\0")) {
        return { error: "Binary files cannot be read" };
      }

      const offset = Math.max(Math.floor(input.offset ?? 1), 1);
      const limit = clampLimit(input.limit, DEFAULT_READ_LIMIT, DEFAULT_READ_LIMIT);
      const lines = content.split("\n");
      const totalLines = lineCount(content);
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const nextOffset =
        offset - 1 + selected.length < totalLines ? offset + selected.length : undefined;

      return {
        content: formatNumberedLines(selected, offset),
        ...(nextOffset ? { nextOffset } : {}),
        path,
        totalLines,
        truncated: nextOffset !== undefined,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
};

const writeFileTool: ToolDefinition<WriteFileToolInput, WriteFileToolOutput> = {
  description:
    "Create or replace a file in the Open Agents session sandbox. Paths are relative to the sandbox working directory unless absolute.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      content: { description: "Complete replacement file contents.", type: "string" },
      filePath: { description: "File path to write.", type: "string" },
    },
    required: ["filePath", "content"],
    type: "object",
  },
  async execute(input, ctx) {
    try {
      const sandbox = await getOpenAgentsSessionSandbox(ctx);
      const path = normalizeSandboxPath(sandbox, input.filePath);
      const existed = await pathExists(sandbox, path);
      await sandbox.mkdir(posix.dirname(path), { recursive: true });
      await sandbox.writeFile(path, input.content, "utf-8");
      return { existed, path };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
};

const globTool: ToolDefinition<GlobToolInput, GlobToolOutput> = {
  description: "Find files in the Open Agents session sandbox by bash glob pattern.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      limit: { maximum: MAX_SEARCH_LIMIT, minimum: 1, type: "integer" },
      path: {
        description: "Directory to search. Defaults to the sandbox working directory.",
        type: "string",
      },
      pattern: { description: "Bash glob pattern, for example **/*.ts.", type: "string" },
    },
    required: ["pattern"],
    type: "object",
  },
  async execute(input, ctx) {
    try {
      const sandbox = await getOpenAgentsSessionSandbox(ctx);
      const root = normalizeSandboxPath(sandbox, input.path);
      const limit = clampLimit(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      const command = [
        `ROOT=${quoteShell(root)}`,
        `PATTERN=${quoteShell(input.pattern)}`,
        `LIMIT=${limit}`,
        `cd "$ROOT"`,
        `count=0`,
        `while IFS= read -r -d '' file; do rel="\${file#./}"; if [[ "$rel" == $PATTERN ]]; then printf '%s\\n' "$rel"; count=$((count + 1)); if [ "$count" -ge "$LIMIT" ]; then break; fi; fi; done < <(find . -type f -print0 | sort -z)`,
      ].join("; ");
      const result = await sandbox.exec(command, root, DEFAULT_COMMAND_TIMEOUT_MS);
      const content = result.stdout.trim();
      const count = content ? content.split("\n").length : 0;
      return {
        content,
        count,
        path: root,
        truncated: count >= limit,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
};

const grepTool: ToolDefinition<GrepToolInput, GrepToolOutput> = {
  description: "Search file contents in the Open Agents session sandbox.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      context: { minimum: 0, type: "integer" },
      glob: { description: "Restrict search to matching file basenames.", type: "string" },
      ignoreCase: { type: "boolean" },
      limit: { maximum: MAX_SEARCH_LIMIT, minimum: 1, type: "integer" },
      literal: { type: "boolean" },
      path: {
        description: "Directory or file to search. Defaults to the sandbox working directory.",
        type: "string",
      },
      pattern: { description: "Regex or literal pattern to search for.", type: "string" },
    },
    required: ["pattern"],
    type: "object",
  },
  async execute(input, ctx) {
    try {
      const sandbox = await getOpenAgentsSessionSandbox(ctx);
      const root = normalizeSandboxPath(sandbox, input.path);
      const limit = clampLimit(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      const flags = ["-R", "-n", "-I"];
      if (input.ignoreCase) {
        flags.push("-i");
      }
      if (input.literal) {
        flags.push("-F");
      }
      if (input.context !== undefined) {
        flags.push("-C", String(Math.max(Math.floor(input.context), 0)));
      }
      const include = input.glob ? ` --include=${quoteShell(input.glob)}` : "";
      const command = `grep ${flags.join(" ")}${include} -- ${quoteShell(input.pattern)} ${quoteShell(root)} | head -n ${limit}`;
      const result = await sandbox.exec(command, root, DEFAULT_COMMAND_TIMEOUT_MS);
      const content = result.stdout.trim();
      const matchCount = content ? content.split("\n").length : 0;
      return {
        content,
        matchCount,
        path: root,
        truncated: matchCount >= limit,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
};

export const OPEN_AGENTS_SESSION_TOOLS = {
  bash: bashTool,
  glob: globTool,
  grep: grepTool,
  read_file: readFileTool,
  write_file: writeFileTool,
};
