// Dev-time inference through a REAL agent harness: drive pi
// (@earendil-works/pi-coding-agent) headless, one shot, hermetically. The
// model is reached through the machine's OpenCode Zen subscription (the
// gateway is OpenAI-compatible; pi gets it via a generated provider
// extension), so an agent working in this repo can ask a real model a
// question — or let it use tools in a scratch dir — without any new
// credentials and without touching anyone's pi/OpenCode state.
//
// Consumers:
//   - `bun run cli pi "..."` — the interactive command (scripts/cli.ts).
//   - future eval tiers — fan out runPi() trials and grade the results.
//
// This is deliberately NOT the OpenCode binary: pi's headless mode is built
// for this (clean JSONL events, --no-tools, hermetic config dir via env),
// while OpenCode stays what it already is in this suite — the MCP-native
// real-client actor (src/clients/opencode.ts).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// The subscription credential (OpenCode Zen — an OpenAI-compatible gateway)
// ---------------------------------------------------------------------------

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";

const zenAuthFile = (): string => join(homedir(), ".local", "share", "opencode", "auth.json");

export const zenApiKey = (): string | undefined => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-json-parse -- boundary: optional host credential file
  try {
    const auth = JSON.parse(readFileSync(zenAuthFile(), "utf8")) as {
      opencode?: { key?: string };
    };
    return auth.opencode?.key;
  } catch {
    return undefined;
  }
};

export const hasInferenceCredential = (): boolean => zenApiKey() !== undefined;

/** Models on the Zen subscription (see the gateway's own docs for quotas).
 *  Any other id is passed through untouched — the registry just supplies
 *  display metadata for the known ones. */
export const ZEN_MODELS = [
  "deepseek-v4-flash", // cheap + fast: the default
  "glm-5.1",
  "kimi-k2.5",
  "minimax-m2.5",
] as const;

export const DEFAULT_MODEL: string = ZEN_MODELS[0];

// ---------------------------------------------------------------------------
// Result shape — distilled from pi's JSONL event stream
// ---------------------------------------------------------------------------

export interface PiToolCall {
  readonly name: string;
  readonly args: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
}

export interface PiRunResult {
  /** All assistant text parts of the final answer, joined. */
  readonly answerText: string;
  /** The model's reasoning text, when the model emits it. */
  readonly thinkingText: string;
  readonly toolCalls: readonly PiToolCall[];
  /** Every JSONL event pi emitted, parsed, in order — for grading/artifacts. */
  readonly events: readonly Record<string, unknown>[];
  readonly usage?: { readonly input: number; readonly output: number };
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** Raw stderr — populated on failures (provider errors land here). */
  readonly stderr: string;
}

export interface PiRunOptions {
  readonly prompt: string;
  /** Zen model id (see ZEN_MODELS). Default: cheap + fast. */
  readonly model?: string;
  /** Give the agent pi's coding tools (read/bash/edit/write) in `cwd`.
   *  Default false — plain question → answer, no side effects possible. */
  readonly tools?: boolean;
  /** Working directory for tool use. Default: a fresh empty temp dir, so a
   *  tool-using model explores nothing it wasn't given. */
  readonly cwd?: string;
  /** Replace pi's coding system prompt. */
  readonly systemPrompt?: string;
  /** Resume/create a named persistent session (multi-turn). Sessions live in
   *  `sessionDir` (default e2e/.dev/pi-sessions), so a follow-up call with
   *  the same name continues the conversation. Omit for a one-shot. */
  readonly session?: string;
  readonly sessionDir?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

const defaultSessionDir = (): string =>
  fileURLToPath(new URL("../../.dev/pi-sessions/", import.meta.url));

/** pi wants a UUID session id; derive one stably from the friendly name. */
const sessionUuid = (name: string): string => {
  const hex = createHash("sha256").update(name).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// The provider extension pi loads at startup. The key travels via env
// (referenced as $OPENCODE_ZEN_API_KEY) — never written to disk.
const providerExtension = (modelIds: readonly string[]): string => `export default function (pi) {
  pi.registerProvider("zen", {
    name: "OpenCode Zen",
    baseUrl: ${JSON.stringify(ZEN_BASE_URL)},
    apiKey: "$OPENCODE_ZEN_API_KEY",
    api: "openai-completions",
    models: ${JSON.stringify(modelIds)}.map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    })),
  });
}
`;

export const runPi = async (options: PiRunOptions): Promise<PiRunResult> => {
  const key = zenApiKey();
  if (!key) {
    throw new Error(
      `inference: no Zen credential at ${zenAuthFile()} — run \`opencode auth login\` once on this machine`,
    );
  }
  const model = options.model ?? DEFAULT_MODEL;

  // Hermetic everything: pi's config dir, the session-less run, and (unless
  // the caller passes cwd) an empty project dir, so a tool-using model acts
  // only on what it was given instead of wandering a repo.
  const scratch = mkdtempSync(join(tmpdir(), "executor-agent-"));
  const configDir = join(scratch, "pi");
  mkdirSync(configDir, { recursive: true });
  const extensionPath = join(scratch, "zen-provider.mjs");
  // Unknown model ids still work — register them alongside the known set.
  const modelIds = (ZEN_MODELS as readonly string[]).includes(model)
    ? ZEN_MODELS
    : [...ZEN_MODELS, model];
  writeFileSync(extensionPath, providerExtension(modelIds));

  // Named sessions persist (and resume) under sessionDir; one-shots don't.
  // pi session ids are PROJECT-scoped, so a named session also pins its cwd —
  // otherwise every call's fresh scratch dir would start a new conversation.
  const sessionRoot = options.session
    ? join(options.sessionDir ?? defaultSessionDir(), options.session)
    : undefined;
  const sessionArgs = sessionRoot
    ? [
        "--session-id",
        sessionUuid(options.session!),
        "--session-dir",
        join(sessionRoot, "sessions"),
      ]
    : ["--no-session"];
  const cwd =
    options.cwd ?? (sessionRoot ? join(sessionRoot, "project") : join(scratch, "project"));
  mkdirSync(cwd, { recursive: true });

  const args = [
    "--extension",
    extensionPath,
    "--provider",
    "zen",
    "--model",
    model,
    ...sessionArgs,
    "--mode",
    "json",
    ...(options.tools ? [] : ["--no-tools"]),
    ...(options.systemPrompt ? ["--system-prompt", options.systemPrompt] : []),
    "-p",
    options.prompt,
  ];

  const startedAt = Date.now();
  const child = spawn("pi", args, {
    cwd,
    env: {
      ...process.env,
      PWD: cwd,
      PI_CODING_AGENT_DIR: configDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      OPENCODE_ZEN_API_KEY: key,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

  let spawnError: NodeJS.ErrnoException | undefined;
  const exitCode = await new Promise<number | null>((resolve) => {
    const killer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(killer);
      spawnError = error;
      resolve(null);
    });
    child.once("exit", (code) => {
      clearTimeout(killer);
      resolve(code);
    });
  });
  if (spawnError) {
    throw spawnError.code === "ENOENT"
      ? new Error(
          "inference: the `pi` binary is not installed — `npm install -g @earendil-works/pi-coding-agent`",
        )
      : spawnError;
  }

  return { ...distill(stdout), exitCode, durationMs: Date.now() - startedAt, stderr };
};

// ---------------------------------------------------------------------------
// Event distillation
// ---------------------------------------------------------------------------

interface MessagePart {
  readonly type?: string;
  readonly text?: string;
  readonly thinking?: string;
}

interface AgentEndEvent {
  readonly type?: string;
  readonly messages?: ReadonlyArray<{
    readonly role?: string;
    readonly content?: readonly MessagePart[];
    readonly usage?: { readonly input?: number; readonly output?: number };
  }>;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly args?: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
}

const distill = (
  jsonl: string,
): Pick<PiRunResult, "answerText" | "thinkingText" | "toolCalls" | "events" | "usage"> => {
  const events: Record<string, unknown>[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-json-parse -- boundary: tolerant parse of pi's JSONL stream
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Non-JSON line (warning/banner) — keep going.
    }
  }

  const toolCalls = new Map<string, PiToolCall>();
  let answerText = "";
  let thinkingText = "";
  let usage: PiRunResult["usage"];

  for (const event of events as readonly AgentEndEvent[]) {
    if (event.type === "tool_execution_start" && event.toolCallId) {
      toolCalls.set(event.toolCallId, { name: event.toolName ?? "?", args: event.args });
    }
    if (event.type === "tool_execution_end" && event.toolCallId) {
      const started = toolCalls.get(event.toolCallId);
      toolCalls.set(event.toolCallId, {
        name: event.toolName ?? started?.name ?? "?",
        args: started?.args,
        result: event.result,
        isError: event.isError,
      });
    }
    if (event.type === "agent_end") {
      for (const message of event.messages ?? []) {
        if (message.role !== "assistant") continue;
        for (const part of message.content ?? []) {
          if (part.type === "text" && part.text) answerText += part.text;
          if (part.type === "thinking" && part.thinking) thinkingText += part.thinking;
        }
        if (message.usage) {
          usage = { input: message.usage.input ?? 0, output: message.usage.output ?? 0 };
        }
      }
    }
  }

  return { answerText, thinkingText, toolCalls: [...toolCalls.values()], events, usage };
};
