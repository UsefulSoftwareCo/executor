// Dependency-free guest payload for the Linux KVM desktop journey. The same
// source runs a bearer-specific remote account fixture, an Anthropic Messages
// replay boundary, and the pinned Claude Code binary inside the disposable VM.

import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KVM_ACCOUNT_FIXTURES = [
  {
    name: "Remote account A",
    token: "desktop-profile-account-a",
    marker: "Wire catalog alpha",
    slug: "fixture-account-a",
  },
  {
    name: "Remote account B",
    token: "desktop-profile-account-b",
    marker: "Wire catalog beta",
    slug: "fixture-account-b",
  },
] as const;

export const KVM_CLAUDE_EXPECTED_RESULT = "42";
export const KVM_CLAUDE_EXECUTE_CODE = "return 6 * 7;";
export const KVM_REPLAY_API_KEY = "executor-e2e-replay-key";

interface AccountFixtureRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
}

interface ReplayToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

interface ReplayMessage {
  readonly role: string;
  readonly text: string;
  readonly toolResults: ReadonlyArray<ReplayToolResult>;
}

interface ReplayRequest {
  readonly path: string;
  readonly model: string;
  readonly messages: ReadonlyArray<ReplayMessage>;
  readonly toolNames: ReadonlyArray<string>;
  readonly stream: boolean;
}

export interface KvmGuestRuntimeState {
  readonly pid: number;
  readonly accountOrigin: string;
  readonly brainOrigin: string;
  readonly accountLedgerPath: string;
  readonly replayLedgerPath: string;
}

export interface KvmGuestClaudeConfig {
  readonly binaryPath: string;
  readonly expectedVersion: string;
  readonly homeDir: string;
  readonly mcpUrl: string;
  readonly authorizationHeader: string;
  readonly brainBaseUrl: string;
  readonly outputPath: string;
}

export interface KvmGuestClaudeResult {
  readonly binaryPath: string;
  readonly expectedVersion: string;
  readonly observedVersion?: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly structuredResult?: unknown;
  readonly mcpServerName: "executor";
  readonly mcpOrigin: string;
  readonly replayOrigin: string;
}

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`guest runtime requires ${key}`);
  }
  return value;
};

const parseClaudeConfig = (value: unknown): KvmGuestClaudeConfig => {
  if (!isUnknownRecord(value)) throw new Error("guest Claude config must be an object");
  return {
    binaryPath: requiredString(value, "binaryPath"),
    expectedVersion: requiredString(value, "expectedVersion"),
    homeDir: requiredString(value, "homeDir"),
    mcpUrl: requiredString(value, "mcpUrl"),
    authorizationHeader: requiredString(value, "authorizationHeader"),
    brainBaseUrl: requiredString(value, "brainBaseUrl"),
    outputPath: requiredString(value, "outputPath"),
  };
};

const writeJsonAtomic = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
};

const writeJson = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};

const listen = (server: ReturnType<typeof createServer>, host: string) =>
  new Promise<number>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: node:http listen callbacks cannot return an Effect failure
        reject(new Error("guest fixture server did not publish a TCP address"));
        return;
      }
      resolveListen(address.port);
    });
  });

const close = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolveClose) => server.close(() => resolveClose()));

const accountIntegration = (authorization: string | null) => {
  const account = KVM_ACCOUNT_FIXTURES.find(
    (candidate) => authorization === `Bearer ${candidate.token}`,
  );
  if (!account) return undefined;
  return {
    slug: account.slug,
    name: account.marker,
    description: `Bearer-specific catalog for ${account.name}`,
    kind: "fixture",
    canRemove: false,
    canRefresh: false,
    authMethods: [],
  };
};

export const createKvmAccountFixture = (ledgerPath: string) => {
  const requests: AccountFixtureRequest[] = [];
  writeJsonAtomic(ledgerPath, requests);
  return createServer((request, response) => {
    const method = request.method ?? "GET";
    const url = request.url ?? "/";
    const authorization = request.headers.authorization ?? null;
    requests.push({ method, url, authorization });
    writeJsonAtomic(ledgerPath, requests);

    response.setHeader("access-control-allow-origin", request.headers.origin ?? "*");
    response.setHeader(
      "access-control-allow-headers",
      request.headers["access-control-request-headers"] ??
        "authorization, content-type, x-executor-org, traceparent, baggage",
    );
    response.setHeader("access-control-allow-methods", "GET, OPTIONS");
    response.setHeader("access-control-allow-private-network", "true");
    response.setHeader("cache-control", "no-store");
    response.setHeader("vary", "Origin, Access-Control-Request-Headers");

    if (method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const pathname = new URL(url, "http://executor-kvm-account-fixture").pathname;
    if (method !== "GET" || pathname !== "/api/integrations") {
      writeJson(response, 404, { message: "Not found" });
      return;
    }
    const integration = accountIntegration(authorization);
    if (!integration) {
      writeJson(response, 401, { message: "Invalid bearer" });
      return;
    }
    writeJson(response, 200, [integration]);
  });
};

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isUnknownRecord(part) && part.type === "text" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
};

const toolResultsFrom = (content: unknown): ReadonlyArray<ReplayToolResult> => {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!isUnknownRecord(part) || part.type !== "tool_result") return [];
    return [
      {
        toolUseId: typeof part.tool_use_id === "string" ? part.tool_use_id : "",
        content: contentText(part.content),
        isError: part.is_error === true,
      },
    ];
  });
};

const messagesFrom = (body: Record<string, unknown>): ReadonlyArray<ReplayMessage> => {
  if (!Array.isArray(body.messages)) return [];
  return body.messages.flatMap((message) => {
    if (!isUnknownRecord(message)) return [];
    return [
      {
        role: typeof message.role === "string" ? message.role : "",
        text: contentText(message.content),
        toolResults: toolResultsFrom(message.content),
      },
    ];
  });
};

const toolNamesFrom = (body: Record<string, unknown>): ReadonlyArray<string> => {
  if (!Array.isArray(body.tools)) return [];
  return body.tools.flatMap((tool) =>
    isUnknownRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
  );
};

const writeEvent = (response: ServerResponse, event: string, data: unknown) => {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
};

const resolveExecuteTool = (offered: ReadonlyArray<string>) =>
  offered.find((name) => name === "execute") ?? offered.find((name) => name.endsWith("__execute"));

const writeReplayResponse = (
  response: ServerResponse,
  requestIndex: number,
  model: string,
  toolNames: ReadonlyArray<string>,
  toolResults: ReadonlyArray<ReplayToolResult>,
  errors: string[],
) => {
  const toolName = toolResults.length === 0 ? resolveExecuteTool(toolNames) : undefined;
  if (toolResults.length === 0 && !toolName) {
    errors.push(
      `request ${requestIndex}: Executor execute was not offered (${toolNames.join(", ")})`,
    );
  }
  const text = toolResults.length > 0 ? `executor-result:${toolResults.at(-1)?.content ?? ""}` : "";
  const messageId = `msg_kvm_replay_${requestIndex}`;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeEvent(response, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });

  let blockIndex = 0;
  if (text) {
    writeEvent(response, "content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "" },
    });
    writeEvent(response, "content_block_delta", {
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text },
    });
    writeEvent(response, "content_block_stop", {
      type: "content_block_stop",
      index: blockIndex,
    });
    blockIndex += 1;
  }

  if (toolName) {
    const toolUseId = `toolu_kvm_replay_${requestIndex}`;
    writeEvent(response, "content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "tool_use", id: toolUseId, name: toolName, input: {} },
    });
    writeEvent(response, "content_block_delta", {
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({ code: KVM_CLAUDE_EXECUTE_CODE }),
      },
    });
    writeEvent(response, "content_block_stop", {
      type: "content_block_stop",
      index: blockIndex,
    });
  }

  writeEvent(response, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: toolName ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: 1 },
  });
  writeEvent(response, "message_stop", { type: "message_stop" });
  response.end();
};

const readRequestBody = (request: IncomingMessage) =>
  new Promise<string>((resolveBody, reject) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => resolveBody(raw));
    request.on("error", reject);
  });

export const createKvmReplayBrain = (ledgerPath: string) => {
  const ledger: { requests: ReplayRequest[]; errors: string[] } = { requests: [], errors: [] };
  writeJsonAtomic(ledgerPath, ledger);
  return createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "POST") {
        writeJson(response, 405, { error: { type: "method_not_allowed" } });
        return;
      }
      if (requestUrl.pathname === "/v1/messages/count_tokens") {
        writeJson(response, 200, { input_tokens: 1 });
        return;
      }
      if (requestUrl.pathname !== "/v1/messages") {
        ledger.errors.push(`unexpected request path: ${request.method} ${requestUrl.pathname}`);
        writeJsonAtomic(ledgerPath, ledger);
        writeJson(response, 404, { error: { type: "not_found" } });
        return;
      }

      const raw = await readRequestBody(request);
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw || "{}");
      } catch (error) {
        ledger.errors.push(`request JSON decode failed: ${String(error)}`);
        writeJsonAtomic(ledgerPath, ledger);
        writeJson(response, 400, { error: { type: "invalid_request_error" } });
        return;
      }
      if (!isUnknownRecord(decoded)) {
        ledger.errors.push("request body was not a JSON object");
        writeJsonAtomic(ledgerPath, ledger);
        writeJson(response, 400, { error: { type: "invalid_request_error" } });
        return;
      }

      const messages = messagesFrom(decoded);
      const toolNames = toolNamesFrom(decoded);
      const toolResults = messages.flatMap((message) => message.toolResults);
      const model = typeof decoded.model === "string" ? decoded.model : "replay-model";
      const requestIndex = ledger.requests.length;
      ledger.requests.push({
        path: `${requestUrl.pathname}${requestUrl.search}`,
        model,
        messages,
        toolNames,
        stream: decoded.stream === true,
      });
      writeReplayResponse(response, requestIndex, model, toolNames, toolResults, ledger.errors);
      writeJsonAtomic(ledgerPath, ledger);
    })().catch((error) => {
      ledger.errors.push(`replay request failed: ${String(error)}`);
      writeJsonAtomic(ledgerPath, ledger);
      if (!response.headersSent) writeJson(response, 500, { error: { type: "fixture_error" } });
      else response.end();
    });
  });
};

const parseServeArguments = (args: ReadonlyArray<string>) => {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error(`invalid serve argument: ${name}`);
    values.set(name, value);
  }
  const stateDir = values.get("--state-dir");
  const accountHost = values.get("--account-host");
  if (!stateDir || !accountHost) throw new Error("serve requires --state-dir and --account-host");
  return { stateDir, accountHost };
};

export const serveKvmGuestFixtures = async (input: {
  readonly stateDir: string;
  readonly accountHost: string;
}) => {
  rmSync(input.stateDir, { force: true, recursive: true });
  mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
  const accountLedgerPath = join(input.stateDir, "account-fixture-ledger.json");
  const replayLedgerPath = join(input.stateDir, "anthropic-replay-ledger.json");
  const accountServer = createKvmAccountFixture(accountLedgerPath);
  const brainServer = createKvmReplayBrain(replayLedgerPath);
  const accountPort = await listen(accountServer, "0.0.0.0");
  const brainPort = await listen(brainServer, "127.0.0.1");
  const state: KvmGuestRuntimeState = {
    pid: process.pid,
    accountOrigin: `http://${input.accountHost}:${accountPort}`,
    brainOrigin: `http://127.0.0.1:${brainPort}`,
    accountLedgerPath,
    replayLedgerPath,
  };
  writeJsonAtomic(join(input.stateDir, "runtime.json"), state);

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void Promise.all([close(accountServer), close(brainServer)]).then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return state;
};

export const isLoopbackHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
};

const invoke = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
) =>
  new Promise<{
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>((resolveInvocation) => {
    execFile(
      binaryPath,
      [...args],
      {
        cwd: options.cwd,
        env: { ...options.env },
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error && "code" in error && typeof error.code === "number" ? error.code : null;
        resolveInvocation({ exitCode: error ? (code ?? 1) : 0, stdout, stderr });
      },
    );
  });

const claudeEnvironment = (homeDir: string, brainOrigin: string) => {
  const configDir = join(homeDir, "claude-config");
  const xdgDir = join(homeDir, "xdg");
  const tempDir = join(homeDir, "tmp");
  for (const directory of [
    homeDir,
    configDir,
    join(homeDir, "project"),
    join(xdgDir, "config"),
    join(xdgDir, "data"),
    join(xdgDir, "state"),
    join(xdgDir, "cache"),
    tempDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  return {
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
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
    ANTHROPIC_BASE_URL: brainOrigin,
    ANTHROPIC_API_KEY: KVM_REPLAY_API_KEY,
  };
};

const probeVersion = (binaryPath: string, env: Readonly<Record<string, string>>) =>
  new Promise<string | undefined>((resolveVersion) => {
    execFile(
      binaryPath,
      ["--version"],
      { env: { ...env }, encoding: "utf8", timeout: 10_000 },
      (error, stdout) => {
        resolveVersion(error ? undefined : /^(\S+)/.exec(stdout.trim())?.[1]);
      },
    );
  });

export const runKvmGuestClaude = async (config: KvmGuestClaudeConfig) => {
  if (!isLoopbackHttpUrl(config.brainBaseUrl)) {
    throw new Error(`refusing non-loopback Anthropic replay URL: ${config.brainBaseUrl}`);
  }
  if (!isLoopbackHttpUrl(config.mcpUrl)) {
    throw new Error(`refusing non-loopback desktop MCP URL: ${config.mcpUrl}`);
  }
  rmSync(config.homeDir, { force: true, recursive: true });
  const environment = claudeEnvironment(config.homeDir, new URL(config.brainBaseUrl).origin);
  const projectDir = join(config.homeDir, "project");
  const mcpConfigPath = join(config.homeDir, "mcp.json");
  writeJsonAtomic(mcpConfigPath, {
    mcpServers: {
      executor: {
        type: "http",
        url: config.mcpUrl,
        headers: { Authorization: config.authorizationHeader },
      },
    },
  });
  const observedVersion = await probeVersion(config.binaryPath, environment);
  if (observedVersion !== config.expectedVersion) {
    const result: KvmGuestClaudeResult = {
      binaryPath: config.binaryPath,
      expectedVersion: config.expectedVersion,
      observedVersion,
      durationMs: 0,
      exitCode: 1,
      stdout: "",
      stderr: `Claude Code ${config.expectedVersion} is required, found ${observedVersion ?? "no runnable binary"}`,
      mcpServerName: "executor",
      mcpOrigin: new URL(config.mcpUrl).origin,
      replayOrigin: new URL(config.brainBaseUrl).origin,
    };
    writeJsonAtomic(config.outputPath, result);
    return result;
  }

  const startedAt = Date.now();
  const invocation = await invoke(
    config.binaryPath,
    [
      "--bare",
      "--mcp-config",
      mcpConfigPath,
      "--strict-mcp-config",
      "--print",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--no-chrome",
      "--model",
      "claude-sonnet-4-6",
      "--tools",
      "",
      "--allowed-tools",
      "mcp__executor__*",
      "--permission-mode",
      "dontAsk",
      "--system-prompt",
      "Follow the user request using only the explicitly configured MCP tools.",
      "Use Executor to calculate six times seven.",
    ],
    { cwd: projectDir, env: environment },
  );
  let structuredResult: unknown;
  try {
    structuredResult = JSON.parse(invocation.stdout.trim());
  } catch {
    structuredResult = undefined;
  }
  const result: KvmGuestClaudeResult = {
    binaryPath: config.binaryPath,
    expectedVersion: config.expectedVersion,
    observedVersion,
    durationMs: Date.now() - startedAt,
    exitCode: invocation.exitCode,
    stdout: invocation.stdout,
    stderr: invocation.stderr,
    structuredResult,
    mcpServerName: "executor",
    mcpOrigin: new URL(config.mcpUrl).origin,
    replayOrigin: new URL(config.brainBaseUrl).origin,
  };
  writeJsonAtomic(config.outputPath, result);
  return result;
};

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "serve") {
    await serveKvmGuestFixtures(parseServeArguments(args));
    return;
  }
  if (command === "claude") {
    const configPath = args[0];
    if (!configPath) throw new Error("claude requires a config path");
    const config = parseClaudeConfig(JSON.parse(readFileSync(configPath, "utf8")));
    const result = await runKvmGuestClaude(config);
    if (result.exitCode !== 0) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown guest runtime command: ${command ?? ""}`);
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
