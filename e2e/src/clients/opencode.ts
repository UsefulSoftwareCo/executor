// Drive the REAL installed OpenCode binary as an MCP client, hermetically:
// its own XDG dirs, a project dir whose opencode.json points at the target's
// /mcp, and an `open`(1) shim on PATH so the OAuth browser hop becomes a file
// we can read instead of a window. What OpenCode does with discovery, scopes,
// tokens, and refresh is entirely its own code — that is the point.
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Whether the real OpenCode binary is installed — the "opencode" capability. */
export const hasOpenCode = (): boolean => spawnSync("opencode", ["--version"]).status === 0;

export interface OpenCodeHome {
  /** Working directory holding opencode.json (OpenCode reads config from cwd). */
  readonly projectDir: string;
  /** Environment that isolates this OpenCode from the machine's real one. */
  readonly env: Record<string, string>;
  /** Every URL OpenCode tried to open in a browser, in order. */
  readonly openedUrls: () => ReadonlyArray<string>;
  /** OpenCode's own MCP token store (undefined until it persists a grant). */
  readonly storedTokens: (
    serverName: string,
  ) => { accessToken?: string; refreshToken?: string; expiresAt?: number } | undefined;
}

/** A throwaway OpenCode installation configured with one remote MCP server.
 *
 *  With `chatBrainUrl` set, the config also declares a `replay` provider
 *  pointing OpenCode's LLM traffic at a local replay brain
 *  (clients/replay-brain.ts) and selects it as the model — real agent,
 *  scripted conversation. Tool permissions are pre-allowed so the recorded
 *  TUI session flows without approval dialogs.
 *
 *  Pass `root` to make the home persistent/reattachable (multi-turn CLI use)
 *  instead of a fresh temp dir; an existing root's config is left alone. */
export const makeOpenCodeHome = (
  serverName: string,
  mcpUrl: string,
  options?: { readonly chatBrainUrl?: string; readonly root?: string },
): OpenCodeHome => {
  const root = options?.root ?? mkdtempSync(join(tmpdir(), "e2e-opencode-"));
  const projectDir = join(root, "project");
  const dataDir = join(root, "data");
  const binDir = join(root, "bin");
  const openedUrlsFile = join(root, "opened-urls.txt");
  const fresh = !existsSync(projectDir);
  for (const dir of [projectDir, dataDir, binDir]) mkdirSync(dir, { recursive: true });

  if (fresh) {
    writeFileSync(
      join(projectDir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: { [serverName]: { type: "remote", url: mcpUrl } },
        ...(options?.chatBrainUrl
          ? {
              autoupdate: false,
              share: "disabled",
              model: "replay/replay-model",
              permission: { "*": "allow" },
              provider: {
                replay: {
                  name: "Replay",
                  npm: "@ai-sdk/openai-compatible",
                  options: { baseURL: options.chatBrainUrl, apiKey: "replay-key" },
                  models: { "replay-model": { name: "Replay Model" } },
                },
              },
            }
          : {}),
      }),
    );
  }
  // OpenCode launches the OAuth URL via `open`; the shim records it instead.
  writeFileSync(join(binDir, "open"), `#!/bin/sh\necho "$@" >> ${openedUrlsFile}\nexit 0\n`, {
    mode: 0o755,
  });

  return {
    projectDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      XDG_DATA_HOME: dataDir,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
    },
    openedUrls: () =>
      existsSync(openedUrlsFile)
        ? readFileSync(openedUrlsFile, "utf8").split("\n").filter(Boolean)
        : [],
    storedTokens: (name) => {
      const file = join(dataDir, "opencode", "mcp-auth.json");
      if (!existsSync(file)) return undefined;
      const store = JSON.parse(readFileSync(file, "utf8")) as Record<
        string,
        { tokens?: { accessToken?: string; refreshToken?: string; expiresAt?: number } }
      >;
      return store[name]?.tokens;
    },
  };
};

/**
 * Run OpenCode's one-time first-run work (database migration) off camera so
 * a recorded session starts clean. Runs in a bare project with NO MCP
 * servers configured: `mcp auth` errors with "Unexpected status: needs_auth"
 * if an earlier `mcp list` already probed the server, so the warm-up must
 * never touch it.
 */
export const warmUp = (home: OpenCodeHome): void => {
  const bare = join(home.projectDir, "..", "warmup");
  mkdirSync(bare, { recursive: true });
  writeFileSync(join(bare, "opencode.json"), "{}");
  spawnSync("opencode", ["mcp", "list"], { cwd: bare, env: home.env, timeout: 60_000 });
};

/**
 * Play the signed-in human for an OAuth flow OpenCode just started: wait for
 * it to "open the browser" (the shim records the URL instead), then follow
 * the authorize URL with login_hint — the emulator's consent redirects the
 * code straight to OpenCode's localhost callback.
 */
export const completeOAuthConsent = async (
  home: OpenCodeHome,
  email: string,
  sinceIndex: number,
): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const url = home.openedUrls()[sinceIndex];
    if (url) {
      const response = await fetch(`${url}&login_hint=${encodeURIComponent(email)}`);
      if (!response.ok) throw new Error(`consent redirect chain failed (${response.status})`);
      return;
    }
    await new Promise((tick) => setTimeout(tick, 250));
  }
  throw new Error("opencode never opened an authorization URL");
};

// ---------------------------------------------------------------------------
// One-shot / multi-turn headless runs (`bun run cli opencode`)
// ---------------------------------------------------------------------------

const hostAuthFile = (): string => join(homedir(), ".local", "share", "opencode", "auth.json");

export const hasOpenCodeCredential = (): boolean => existsSync(hostAuthFile());

export interface OpenCodeRunOptions {
  readonly prompt: string;
  /** `provider/model`, e.g. `opencode/deepseek-v4-flash` (the default). */
  readonly model?: string;
  /** Continue the home's most recent session (multi-turn). */
  readonly continueSession?: boolean;
  /** Reuse a prior run's home (REQUIRED for continueSession to see it). */
  readonly home?: OpenCodeHome;
  /** Expose one remote MCP server to the model (OpenCode's native client).
   *  OAuth, if the server needs it, is the caller's job (mcp auth + consent
   *  — see the mcp-opencode-real scenario). */
  readonly mcp?: { readonly serverName: string; readonly url: string };
  readonly timeoutMs?: number;
}

export interface OpenCodeRunResult {
  readonly answerText: string;
  /** Raw JSONL events (--format json), parsed, for grading/artifacts. */
  readonly events: readonly Record<string, unknown>[];
  readonly home: OpenCodeHome;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stderr: string;
}

/** Drive the real OpenCode binary headless and hermetic: its own XDG home
 *  seeded with the machine's subscription credential. Pass `home` +
 *  `continueSession` for multi-turn; pass `mcp` to use OpenCode's native MCP
 *  client against one of our targets. */
export const runOpenCode = async (options: OpenCodeRunOptions): Promise<OpenCodeRunResult> => {
  if (!hasOpenCodeCredential()) {
    throw new Error(
      `opencode: no credential at ${hostAuthFile()} — run \`opencode auth login\` once on this machine`,
    );
  }
  const PLACEHOLDER_MCP = "http://127.0.0.1:9/";
  const home =
    options.home ??
    makeOpenCodeHome(options.mcp?.serverName ?? "none", options.mcp?.url ?? PLACEHOLDER_MCP);
  const configPath = join(home.projectDir, "opencode.json");
  if (!options.mcp && readFileSync(configPath, "utf8").includes(PLACEHOLDER_MCP)) {
    // makeOpenCodeHome always writes an mcp block; a plain run wants none.
    writeFileSync(
      configPath,
      JSON.stringify({ $schema: "https://opencode.ai/config.json", share: "disabled" }),
    );
  }
  // Seed the subscription credential into the hermetic home.
  const authDir = join(home.env.XDG_DATA_HOME ?? "", "opencode");
  mkdirSync(authDir, { recursive: true });
  copyFileSync(hostAuthFile(), join(authDir, "auth.json"));

  const args = [
    "run",
    "-m",
    options.model ?? "opencode/deepseek-v4-flash",
    "--format",
    "json",
    ...(options.continueSession ? ["--continue"] : []),
    options.prompt,
  ];
  const startedAt = Date.now();
  const child = spawn("opencode", args, {
    cwd: home.projectDir,
    env: { ...home.env, PWD: home.projectDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exitCode = await new Promise<number | null>((resolve) => {
    const killer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 240_000);
    child.once("exit", (code) => {
      clearTimeout(killer);
      resolve(code);
    });
  });

  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-json-parse -- boundary: tolerant parse of opencode's JSONL stream
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Non-JSON line — keep going.
    }
  }
  const answerText = events
    .filter(
      (event) =>
        event.type === "text" &&
        typeof (event.part as { text?: string } | undefined)?.text === "string",
    )
    .map((event) => (event.part as { text: string }).text)
    .join("\n");

  return { answerText, events, home, exitCode, durationMs: Date.now() - startedAt, stderr };
};
