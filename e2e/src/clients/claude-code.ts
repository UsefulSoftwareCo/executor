// Hermetic driver for the REAL Claude Code native binary. The process gets a
// throwaway HOME and CLAUDE_CONFIG_DIR, explicit MCP config, and a loopback-only
// Anthropic replay endpoint. No ambient login or paid Anthropic credential can
// cross this boundary.
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Data, Effect } from "effect";

export const DEFAULT_CLAUDE_CODE_BINARY = "claude";
export const DEFAULT_CLAUDE_CODE_VERSION = "2.1.195";
export const CLAUDE_CODE_REQUIRED_ENV = "E2E_CLAUDE_CODE_REQUIRED";
export const CLAUDE_CODE_VERSION_ENV = "E2E_CLAUDE_CODE_VERSION";

export interface ClaudeCodeServer {
  readonly url: string;
  readonly authorizationHeader?: string;
}

export interface ClaudeCodeHome {
  readonly rootDir: string;
  readonly homeDir: string;
  readonly configDir: string;
  readonly projectDir: string;
  readonly mcpConfigPath: string;
  readonly serverName: string;
  readonly binaryPath: string;
  readonly version: string | undefined;
  readonly env: Readonly<Record<string, string>>;
}

export interface ClaudeCodeRunInput {
  readonly brainBaseUrl: string;
  readonly prompt: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export interface ClaudeCodeRunResult {
  readonly result: string;
  readonly raw: unknown;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly reportedDurationMs: number | undefined;
  readonly totalCostUsd: number | undefined;
  readonly claudeCodeVersion: string;
}

export class ClaudeCodeInvocationError extends Data.TaggedError("ClaudeCodeInvocationError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
}> {}

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const inheritedEnvironment = () => {
  const names = [
    "PATH",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TERM",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
  ] as const;
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value] as const];
    }),
  );
};

const controlledEnvironment = (
  rootDir: string,
  homeDir: string,
  configDir: string,
): Readonly<Record<string, string>> => {
  const tempDir = join(rootDir, "tmp");
  const xdgDir = join(rootDir, "xdg");
  for (const dir of [tempDir, xdgDir]) mkdirSync(dir, { recursive: true });
  return {
    ...inheritedEnvironment(),
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLAUDE_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: join(xdgDir, "config"),
    XDG_DATA_HOME: join(xdgDir, "data"),
    XDG_STATE_HOME: join(xdgDir, "state"),
    XDG_CACHE_HOME: join(xdgDir, "cache"),
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
    CI: "1",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_UPDATES: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
};

const mcpConfig = (serverName: string, server: ClaudeCodeServer) => ({
  mcpServers: {
    [serverName]: {
      type: "http",
      url: server.url,
      ...(server.authorizationHeader
        ? { headers: { Authorization: server.authorizationHeader } }
        : {}),
    },
  },
});

const writeMcpConfig = (home: ClaudeCodeHome, server: ClaudeCodeServer) => {
  writeFileSync(
    home.mcpConfigPath,
    `${JSON.stringify(mcpConfig(home.serverName, server), null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
};

export const claudeCodeBinaryPath = () =>
  process.env.E2E_CLAUDE_CODE_BIN ?? DEFAULT_CLAUDE_CODE_BINARY;

export const expectedClaudeCodeVersion = () =>
  process.env[CLAUDE_CODE_VERSION_ENV] ?? DEFAULT_CLAUDE_CODE_VERSION;

export const isClaudeCodeRequired = () => process.env[CLAUDE_CODE_REQUIRED_ENV] === "1";

export const installedClaudeCodeVersion = (binaryPath = claudeCodeBinaryPath()) => {
  const probe = spawnSync(binaryPath, ["--version"], {
    env: controlledEnvironmentForProbe(),
    encoding: "utf8",
    timeout: 10_000,
  });
  if (probe.error || probe.status !== 0) return undefined;
  return /^(\S+)/.exec(probe.stdout.trim())?.[1];
};

export const hasClaudeCode = () => installedClaudeCodeVersion() === expectedClaudeCodeVersion();

const controlledEnvironmentForProbe = () => {
  const homeDir = join(tmpdir(), "executor-e2e-claude-version-probe");
  return {
    ...inheritedEnvironment(),
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLAUDE_CONFIG_DIR: join(homeDir, "config"),
    XDG_CONFIG_HOME: join(homeDir, "xdg-config"),
    XDG_DATA_HOME: join(homeDir, "xdg-data"),
    XDG_STATE_HOME: join(homeDir, "xdg-state"),
    XDG_CACHE_HOME: join(homeDir, "xdg-cache"),
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_UPDATES: "1",
  };
};

export const makeClaudeCodeHome = (
  serverName: string,
  server: ClaudeCodeServer,
): ClaudeCodeHome => {
  const rootDir = mkdtempSync(join(tmpdir(), "executor-e2e-claude-"));
  const homeDir = join(rootDir, "home");
  const configDir = join(rootDir, "claude-config");
  const projectDir = join(rootDir, "project");
  const mcpConfigPath = join(rootDir, "mcp.json");
  for (const dir of [homeDir, configDir, projectDir]) mkdirSync(dir, { recursive: true });
  const home: ClaudeCodeHome = {
    rootDir,
    homeDir,
    configDir,
    projectDir,
    mcpConfigPath,
    serverName,
    binaryPath: claudeCodeBinaryPath(),
    version: installedClaudeCodeVersion(),
    env: controlledEnvironment(rootDir, homeDir, configDir),
  };
  writeMcpConfig(home, server);
  return home;
};

export const readClaudeCodeMcpConfig = (home: ClaudeCodeHome): unknown =>
  JSON.parse(readFileSync(home.mcpConfigPath, "utf8"));

export const removeClaudeCodeHome = (home: ClaudeCodeHome) => {
  rmSync(home.rootDir, { recursive: true, force: true });
};

const invokeClaudeCode = (
  home: ClaudeCodeHome,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
) =>
  Effect.callback<{ readonly stdout: string; readonly stderr: string }, ClaudeCodeInvocationError>(
    (resume) => {
      const child = execFile(
        home.binaryPath,
        [...args],
        {
          cwd: home.projectDir,
          env: { ...env },
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
        },
        (cause, stdout, stderr) => {
          if (cause) {
            resume(
              Effect.fail(
                new ClaudeCodeInvocationError({
                  message: `Claude Code exited unsuccessfully: ${cause.message}`,
                  cause,
                  stdout,
                  stderr,
                }),
              ),
            );
            return;
          }
          resume(Effect.succeed({ stdout, stderr }));
        },
      );
      return Effect.sync(() => child.kill("SIGKILL"));
    },
  );

const loopbackReplayUrl = (value: string) =>
  Effect.try({
    try: () => new URL(value),
    catch: (cause) =>
      new ClaudeCodeInvocationError({
        message: `Invalid Anthropic replay URL: ${value}`,
        cause,
      }),
  }).pipe(
    Effect.filterOrFail(
      (url) =>
        url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]"),
      () =>
        new ClaudeCodeInvocationError({
          message: `Refusing non-loopback Anthropic replay URL: ${value}`,
        }),
    ),
  );

export const runClaudeCode = (home: ClaudeCodeHome, input: ClaudeCodeRunInput) =>
  Effect.gen(function* () {
    const expectedVersion = expectedClaudeCodeVersion();
    const observedVersion = installedClaudeCodeVersion(home.binaryPath);
    if (observedVersion !== expectedVersion) {
      return yield* new ClaudeCodeInvocationError({
        message: `Claude Code ${expectedVersion} is required, found ${observedVersion ?? "no runnable binary"}`,
      });
    }
    const replayUrl = yield* loopbackReplayUrl(input.brainBaseUrl);
    const startedAt = Date.now();
    const invocation = yield* invokeClaudeCode(
      home,
      [
        "--bare",
        "--mcp-config",
        home.mcpConfigPath,
        "--strict-mcp-config",
        "--print",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--no-chrome",
        "--model",
        input.model ?? "claude-sonnet-4-6",
        "--tools",
        "",
        "--allowed-tools",
        `mcp__${home.serverName}__*`,
        "--permission-mode",
        "dontAsk",
        "--system-prompt",
        "Follow the user request using only the explicitly configured MCP tools.",
        input.prompt,
      ],
      {
        ...home.env,
        ANTHROPIC_BASE_URL: replayUrl.origin,
        ANTHROPIC_API_KEY: "executor-e2e-replay-key",
      },
      input.timeoutMs ?? 90_000,
    );
    const raw = yield* Effect.try({
      try: () => JSON.parse(invocation.stdout.trim()),
      catch: (cause) =>
        new ClaudeCodeInvocationError({
          message: "Claude Code returned non-JSON output",
          cause,
          stdout: invocation.stdout,
          stderr: invocation.stderr,
        }),
    });
    if (!isUnknownRecord(raw) || typeof raw.result !== "string") {
      return yield* new ClaudeCodeInvocationError({
        message: "Claude Code JSON output did not contain a string result",
        stdout: invocation.stdout,
        stderr: invocation.stderr,
      });
    }
    return {
      result: raw.result,
      raw,
      stdout: invocation.stdout,
      stderr: invocation.stderr,
      durationMs: Date.now() - startedAt,
      reportedDurationMs: typeof raw.duration_ms === "number" ? raw.duration_ms : undefined,
      totalCostUsd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : undefined,
      claudeCodeVersion: observedVersion,
    } satisfies ClaudeCodeRunResult;
  });

export const runClaudeCodeMcp = (
  home: ClaudeCodeHome,
  args: ReadonlyArray<string>,
  timeoutMs = 30_000,
) =>
  invokeClaudeCode(
    home,
    ["--bare", "--mcp-config", home.mcpConfigPath, "--strict-mcp-config", "mcp", ...args],
    home.env,
    timeoutMs,
  );

/**
 * Reuse one Claude MCP server name for another account or endpoint. Clear any
 * OAuth grant under that name before replacing the explicit config so a client
 * process can never silently retain the previous account.
 */
export const replaceClaudeCodeServer = (
  home: ClaudeCodeHome,
  server: ClaudeCodeServer,
  options: { readonly clearOAuthCredentials?: boolean } = {},
) =>
  Effect.gen(function* () {
    if (options.clearOAuthCredentials !== false) {
      yield* runClaudeCodeMcp(home, ["logout", home.serverName]).pipe(Effect.ignore);
    }
    yield* Effect.sync(() => writeMcpConfig(home, server));
  });
