import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
// Make sibling binaries (if any are added later) discoverable on $PATH so
// child processes spawned without an absolute path still find them.
const execDir = dirname(process.execPath);
if (process.env.PATH && !process.env.PATH.includes(execDir)) {
  process.env.PATH = `${execDir}:${process.env.PATH}`;
}

// Point the keychain plugin at the colocated @napi-rs/keyring binding.
// bun --compile doesn't include .node files in bunfs, so the loader's
// normal `require('@napi-rs/keyring-<plat>-<arch>')` walk fails inside the
// binary. We can't use NAPI_RS_NATIVE_LIBRARY_PATH because @napi-rs/keyring
// 1.2.0 has a bug where the env-var branch assigns to a local variable that
// gets overwritten before the binding is returned. build.ts copies the
// platform .node next to the executor; the keychain plugin reads this var
// and loads the file directly via createRequire, bypassing the broken
// loader.
const keyringNodeOnDisk = join(execDir, "keyring.node");
if (
  typeof Bun !== "undefined" &&
  !process.env.EXECUTOR_KEYRING_NATIVE_PATH &&
  (await Bun.file(keyringNodeOnDisk).exists())
) {
  process.env.EXECUTOR_KEYRING_NATIVE_PATH = keyringNodeOnDisk;
}

// Pre-load QuickJS WASM for compiled binaries — must run before server imports
const wasmOnDisk = join(execDir, "emscripten-module.wasm");
if (typeof Bun !== "undefined" && (await Bun.file(wasmOnDisk).exists())) {
  const { setQuickJSModule } = await import("@executor-js/runtime-quickjs");
  const { newQuickJSWASMModule } = await import("quickjs-emscripten");
  type QuickJSSyncVariant = import("quickjs-emscripten").QuickJSSyncVariant;
  const wasmBinary = await Bun.file(wasmOnDisk).arrayBuffer();
  const importFFI: QuickJSSyncVariant["importFFI"] = () =>
    import("@jitl/quickjs-wasmfile-release-sync/ffi").then((m) => m.QuickJSFFI);
  const importModuleLoader: QuickJSSyncVariant["importModuleLoader"] = async () => {
    const { default: original } =
      await import("@jitl/quickjs-wasmfile-release-sync/emscripten-module");
    return (moduleArg = {}) => original({ ...moduleArg, wasmBinary });
  };
  const variant: QuickJSSyncVariant = {
    type: "sync" as const,
    importFFI,
    importModuleLoader,
  };
  const mod = await newQuickJSWASMModule(variant);
  setQuickJSModule(mod);
}

import { Argument as Args, Command, Flag as Options } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient } from "effect/unstable/http";
import { FileSystem, Path as PlatformPath } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";

import { ExecutorApi } from "@executor-js/api";
import { startServer, runMcpStdioServer, getExecutor } from "@executor-js/local";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { fetchIntegrations } from "./integrations";
import {
  buildDaemonSpawnSpec,
  chooseDaemonPort,
  canAutoStartLocalDaemonForHost,
  isDevCliEntrypoint,
  parseDaemonBaseUrl,
  spawnDetached,
  waitForReachable,
  waitForUnreachable,
} from "./daemon";
import {
  acquireDaemonStartLock,
  canonicalDaemonHost,
  currentDaemonScopeId,
  isPidAlive,
  readDaemonPointer,
  readDaemonRecord,
  releaseDaemonStartLock,
  removeDaemonPointer,
  removeDaemonRecord,
  terminatePid,
  writeDaemonPointer,
  writeDaemonRecord,
} from "./daemon-state";
import {
  buildResumeContentTemplate,
  buildToolPath,
  buildDescribeToolCode,
  filterToolPathChildren,
  buildInvokeToolCode,
  buildListSourcesCode,
  buildSearchToolsCode,
  extractExecutionId,
  extractPausedInteraction,
  extractExecutionResult,
  inspectToolPath,
  normalizeCliErrorText,
  parseJsonObjectInput,
  sanitizeCliOutputText,
  shellQuoteArg,
} from "./tooling";

// Embedded web UI — baked into compiled binaries via `with { type: "file" }`
import embeddedWebUI from "./embedded-web-ui.gen";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const { version: CLI_VERSION } = await import("../package.json");
const DEFAULT_PORT = 4788;
const DEFAULT_BASE_URL = `http://localhost:${DEFAULT_PORT}`;
const DAEMON_BOOT_TIMEOUT_MS = 15_000;
const DAEMON_BOOT_POLL_MS = 150;
const DAEMON_STOP_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const waitForShutdownSignal = () =>
  Effect.callback<void, never>((resume) => {
    const shutdown = () => resume(Effect.void);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return Effect.sync(() => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    });
  });

// ---------------------------------------------------------------------------
// Background server management
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isServerReachable = (baseUrl: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() =>
    fetch(`${baseUrl}/api/scope`, { signal: AbortSignal.timeout(2000) }),
  ).pipe(
    Effect.flatMap((res) => {
      if (!res.ok) return Effect.succeed(false);
      return Effect.tryPromise(() => res.json()).pipe(
        Effect.map((payload) => {
          if (!isRecord(payload)) return false;
          return (
            typeof payload.id === "string" &&
            typeof payload.name === "string" &&
            typeof payload.dir === "string"
          );
        }),
        Effect.catchCause(() => Effect.succeed(false)),
      );
    }),
    Effect.catchCause(() => Effect.succeed(false)),
  );

const script = process.argv[1];
const isDevMode = isDevCliEntrypoint(script);
const cliPrefix = isDevMode ? `bun run ${script}` : "executor";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const parseDaemonUrl = (baseUrl: string) =>
  Effect.try({
    try: () => parseDaemonBaseUrl(baseUrl, DEFAULT_PORT),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(`Invalid base URL: ${String(cause)}`),
  });

const daemonBaseUrl = (hostname: string, port: number): string =>
  `http://${canonicalDaemonHost(hostname)}:${port}`;

const cleanupPointer = (input: { hostname: string; scopeId: string; port: number }) =>
  Effect.gen(function* () {
    yield* removeDaemonPointer({ hostname: input.hostname, scopeId: input.scopeId }).pipe(
      Effect.ignore,
    );
    yield* removeDaemonRecord({ hostname: input.hostname, port: input.port }).pipe(Effect.ignore);
  });

const resolveDaemonTarget = (baseUrl: string) =>
  Effect.gen(function* () {
    const parsed = yield* parseDaemonUrl(baseUrl);
    const host = canonicalDaemonHost(parsed.hostname);
    const scopeId = currentDaemonScopeId();
    const pointer = yield* readDaemonPointer({ hostname: host, scopeId });

    if (pointer) {
      const pointerUrl = daemonBaseUrl(pointer.hostname, pointer.port);
      if (isPidAlive(pointer.pid) && (yield* isServerReachable(pointerUrl))) {
        return {
          baseUrl: pointerUrl,
          hostname: pointer.hostname,
          port: pointer.port,
          scopeId,
        };
      }

      yield* cleanupPointer({ hostname: pointer.hostname, scopeId, port: pointer.port });
    }

    return {
      baseUrl: daemonBaseUrl(host, parsed.port),
      hostname: host,
      port: parsed.port,
      scopeId,
    };
  });

// Serialize daemon startup behind a filesystem lock so concurrent CLI invocations don't
// each spawn their own daemon. The post-lock pointer recheck catches the case where
// another invocation finished bootstrapping while we were waiting for the lock.
const spawnAndWaitForDaemon = (input: {
  host: string;
  scopeId: string;
  preferredPort: number;
  allowedHosts: ReadonlyArray<string>;
}): Effect.Effect<string, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const lock = yield* acquireDaemonStartLock({ hostname: input.host, scopeId: input.scopeId });

    try {
      const existing = yield* readDaemonPointer({ hostname: input.host, scopeId: input.scopeId });
      if (existing && isPidAlive(existing.pid)) {
        const existingUrl = daemonBaseUrl(existing.hostname, existing.port);
        if (yield* isServerReachable(existingUrl)) {
          return existingUrl;
        }
      }

      const selectedPort = yield* chooseDaemonPort({
        preferredPort: input.preferredPort,
        hostname: input.host,
      });

      if (selectedPort !== input.preferredPort) {
        console.error(
          `Port ${input.preferredPort} is in use. Starting daemon on available port ${selectedPort} instead.`,
        );
      }

      const spec = yield* Effect.try({
        try: () =>
          buildDaemonSpawnSpec({
            port: selectedPort,
            hostname: input.host,
            isDevMode,
            scriptPath: script,
            executablePath: process.execPath,
            allowedHosts: input.allowedHosts,
          }),
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error(`Failed to build daemon command: ${String(cause)}`),
      });

      const startBaseUrl = daemonBaseUrl(input.host, selectedPort);
      console.error(`Starting daemon on ${input.host}:${selectedPort}...`);
      yield* spawnDetached({
        command: spec.command,
        args: spec.args,
        env: process.env,
      });

      const ready = yield* waitForReachable({
        check: isServerReachable(startBaseUrl),
        timeoutMs: DAEMON_BOOT_TIMEOUT_MS,
        intervalMs: DAEMON_BOOT_POLL_MS,
      });

      if (!ready) {
        return yield* Effect.fail(
          new Error(
            [
              `Daemon did not become reachable at ${startBaseUrl} within ${DAEMON_BOOT_TIMEOUT_MS}ms.`,
              `Run in foreground to inspect logs: ${cliPrefix} daemon run --foreground --port ${selectedPort} --hostname ${input.host}`,
            ].join("\n"),
          ),
        );
      }

      return startBaseUrl;
    } finally {
      yield* releaseDaemonStartLock(lock).pipe(Effect.ignore);
    }
  });

// Auto-start a local daemon on demand so commands like `executor call` work without the
// user having to run `daemon run` first. Refuses non-local hosts because spawning a
// daemon process on the user's behalf only makes sense when "the user's machine" is
// also where the request will land.
const ensureDaemon = (
  baseUrl: string,
): Effect.Effect<string, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const resolvedTarget = yield* resolveDaemonTarget(baseUrl);
    if (yield* isServerReachable(resolvedTarget.baseUrl)) {
      return resolvedTarget.baseUrl;
    }

    const parsed = yield* parseDaemonUrl(baseUrl);
    const host = canonicalDaemonHost(parsed.hostname);

    if (!canAutoStartLocalDaemonForHost(host)) {
      return yield* Effect.fail(
        new Error(
          [
            `Executor daemon is not reachable at ${baseUrl}.`,
            "Auto-start is only supported for local hosts.",
            `Start it manually: ${cliPrefix} daemon run --port ${parsed.port} --hostname ${host}`,
          ].join("\n"),
        ),
      );
    }

    return yield* spawnAndWaitForDaemon({
      host,
      scopeId: resolvedTarget.scopeId,
      preferredPort: parsed.port,
      allowedHosts: [],
    });
  }).pipe(Effect.mapError(toError));

const stopDaemon = (
  baseUrl: string,
): Effect.Effect<void, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const target = yield* resolveDaemonTarget(baseUrl);
    const host = canonicalDaemonHost(target.hostname);
    const scopeId = target.scopeId;
    const record = yield* readDaemonRecord({ hostname: host, port: target.port });
    const reachable = yield* isServerReachable(target.baseUrl);

    if (!record) {
      if (reachable) {
        return yield* Effect.fail(
          new Error(
            [
              `Executor is reachable at ${target.baseUrl} but no daemon record exists.`,
              "It may not be managed by this CLI process.",
              "Stop it from the terminal/session where it was started.",
            ].join("\n"),
          ),
        );
      }
      console.log(`No daemon running at ${target.baseUrl}.`);
      return;
    }

    if (!isPidAlive(record.pid)) {
      yield* removeDaemonRecord({ hostname: host, port: target.port });
      yield* removeDaemonPointer({ hostname: host, scopeId }).pipe(Effect.ignore);
      if (reachable) {
        return yield* Effect.fail(
          new Error(
            [
              `Daemon record for ${target.baseUrl} points to dead pid ${record.pid}, but endpoint is still reachable.`,
              "Refusing to stop an unknown process without ownership metadata.",
            ].join("\n"),
          ),
        );
      }
      console.log(
        `No daemon running at ${target.baseUrl} (removed stale record for pid ${record.pid}).`,
      );
      return;
    }

    console.log(`Stopping daemon at ${target.baseUrl} (pid ${record.pid})...`);

    yield* terminatePid(record.pid);

    const stopped = yield* waitForUnreachable({
      check: isServerReachable(target.baseUrl),
      timeoutMs: DAEMON_STOP_TIMEOUT_MS,
      intervalMs: DAEMON_BOOT_POLL_MS,
    });

    if (!stopped) {
      return yield* Effect.fail(
        new Error(
          [
            `Daemon at ${target.baseUrl} did not stop within ${DAEMON_STOP_TIMEOUT_MS}ms.`,
            "Try terminating the process manually.",
          ].join("\n"),
        ),
      );
    }

    yield* removeDaemonRecord({ hostname: host, port: target.port });
    yield* removeDaemonPointer({ hostname: host, scopeId }).pipe(Effect.ignore);
    console.log(`Daemon stopped at ${target.baseUrl}.`);
  }).pipe(Effect.mapError(toError));

type ExecuteCodeOutcome =
  | {
      readonly status: "completed";
      readonly result: unknown;
    }
  | {
      readonly status: "paused";
      readonly text: string;
      readonly executionId: string | undefined;
      readonly interaction:
        | {
            readonly kind: "url" | "form";
            readonly message: string;
            readonly url?: string;
            readonly requestedSchema?: Record<string, unknown>;
          }
        | undefined;
    };

const executeCode = (input: {
  baseUrl: string;
  code: string;
}): Effect.Effect<ExecuteCodeOutcome, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const daemonUrl = yield* ensureDaemon(input.baseUrl);
    const client = yield* makeApiClient(daemonUrl);
    const response = yield* client.executions.execute({
      payload: {
        code: input.code,
      },
    });

    if (response.status === "paused") {
      return {
        status: "paused" as const,
        text: response.text,
        executionId: extractExecutionId(response.structured),
        interaction: extractPausedInteraction(response.structured),
      };
    }

    if (response.isError) {
      return yield* Effect.fail(new Error(response.text));
    }

    return {
      status: "completed" as const,
      result: extractExecutionResult(response.structured),
    };
  }).pipe(Effect.mapError(toError));

const printExecutionOutcome = (input: { baseUrl: string; outcome: ExecuteCodeOutcome }) =>
  Effect.sync(() => {
    if (input.outcome.status === "paused") {
      console.log(input.outcome.text);
      if (input.outcome.executionId) {
        const commandPrefix = `${cliPrefix} resume --execution-id ${input.outcome.executionId} --base-url ${input.baseUrl}`;
        if (input.outcome.interaction?.kind === "form") {
          const requestedSchema = input.outcome.interaction.requestedSchema;
          if (requestedSchema && Object.keys(requestedSchema).length > 0) {
            console.log(`\nRequested schema:\n${JSON.stringify(requestedSchema, null, 2)}`);
          }
          const template = buildResumeContentTemplate(requestedSchema);
          const contentArg = shellQuoteArg(JSON.stringify(template));
          console.log("\nResume commands:");
          console.log(`  ${commandPrefix} --action accept --content ${contentArg}`);
          console.log(`  ${commandPrefix} --action decline`);
          console.log(`  ${commandPrefix} --action cancel`);
        } else {
          console.log("\nResume command:");
          console.log(`  ${commandPrefix} --action accept`);
        }
      }
      return;
    }

    if (typeof input.outcome.result === "string") {
      console.log(input.outcome.result);
      return;
    }

    console.log(JSON.stringify(input.outcome.result, null, 2));
  });

// ---------------------------------------------------------------------------
// Typed API client
// ---------------------------------------------------------------------------

const makeApiClient = (baseUrl: string) =>
  HttpApiClient.make(ExecutorApi, { baseUrl: `${baseUrl}/api` }).pipe(
    Effect.provide(FetchHttpClient.layer),
  );

// ---------------------------------------------------------------------------
// Foreground session
// ---------------------------------------------------------------------------

const runForegroundSession = (input: {
  port: number;
  hostname: string;
  allowedHosts: ReadonlyArray<string>;
  authToken: string | undefined;
  authPassword: string | undefined;
}) =>
  Effect.gen(function* () {
    const server = yield* Effect.promise(() =>
      startServer({
        port: input.port,
        hostname: input.hostname,
        allowedHosts: input.allowedHosts,
        authToken: input.authToken,
        authPassword: input.authPassword,
        embeddedWebUI,
      }),
    );

    const displayHost =
      input.hostname === "0.0.0.0" || input.hostname === "::" ? "localhost" : input.hostname;
    const baseUrl = `http://${displayHost}:${server.port}`;
    console.log(`Executor is ready.`);
    console.log(`Web:     ${baseUrl}`);
    console.log(`MCP:     ${baseUrl}/mcp`);
    console.log(`OpenAPI: ${baseUrl}/api/docs`);
    if (input.hostname !== "127.0.0.1" && input.hostname !== "localhost") {
      console.log(
        `\n⚠  Listening on ${input.hostname}. Executor runs arbitrary commands — only expose on trusted networks.`,
      );
      if (input.allowedHosts.length > 0) {
        console.log(`   Extra allowed Host headers: ${input.allowedHosts.join(", ")}`);
      }
      if (input.authPassword) {
        console.log("   Basic authentication is enabled.");
      } else if (input.authToken) {
        console.log("   Token authentication is enabled.");
      }
    }
    console.log(`\nPress Ctrl+C to stop.`);

    yield* waitForShutdownSignal();
    yield* Effect.promise(() => server.stop());
  });

const runDaemonSession = (input: {
  port: number;
  hostname: string;
  allowedHosts: ReadonlyArray<string>;
  authToken: string | undefined;
  authPassword: string | undefined;
}) =>
  Effect.gen(function* () {
    const daemonHost = canonicalDaemonHost(input.hostname);
    const scopeId = currentDaemonScopeId();
    const existing = yield* readDaemonPointer({ hostname: daemonHost, scopeId });

    if (existing) {
      const existingUrl = daemonBaseUrl(existing.hostname, existing.port);
      if (isPidAlive(existing.pid) && (yield* isServerReachable(existingUrl))) {
        return yield* Effect.fail(
          new Error(
            [
              `A daemon is already running for scope ${scopeId} on ${daemonHost}.`,
              `Existing daemon: ${existingUrl} (pid ${existing.pid}).`,
              `Stop it first: ${cliPrefix} daemon stop`,
            ].join("\n"),
          ),
        );
      }
      yield* cleanupPointer({ hostname: existing.hostname, scopeId, port: existing.port });
    }

    const server = yield* Effect.promise(() =>
      startServer({
        port: input.port,
        hostname: input.hostname,
        allowedHosts: input.allowedHosts,
        authToken: input.authToken,
        authPassword: input.authPassword,
        embeddedWebUI,
      }),
    );

    const daemonPort = server.port;
    const token = randomUUID();

    yield* writeDaemonRecord({
      hostname: daemonHost,
      port: daemonPort,
      pid: process.pid,
      scopeDir: process.env.EXECUTOR_SCOPE_DIR ?? null,
    });
    yield* writeDaemonPointer({
      hostname: daemonHost,
      port: daemonPort,
      pid: process.pid,
      scopeId,
      scopeDir: process.env.EXECUTOR_SCOPE_DIR ?? null,
      token,
    });

    console.log(`Daemon ready on http://${daemonHost}:${daemonPort}`);
    if (input.authPassword) {
      console.log("Basic authentication is enabled.");
    } else if (input.authToken) {
      console.log("Token authentication is enabled.");
    }

    try {
      yield* waitForShutdownSignal();
    } finally {
      yield* Effect.promise(() => server.stop());
      yield* removeDaemonRecord({ hostname: daemonHost, port: daemonPort });
      yield* removeDaemonPointer({ hostname: daemonHost, scopeId }).pipe(Effect.ignore);
    }
  });

// `executor daemon run` defaults to detached so the user gets their shell back, but the
// command is idempotent: re-running while a daemon is already up should report success
// (matching the auto-start behaviour) rather than fail or spawn a duplicate.
const runBackgroundDaemonStart = (input: {
  port: number;
  hostname: string;
  allowedHosts: ReadonlyArray<string>;
}): Effect.Effect<void, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const host = canonicalDaemonHost(input.hostname);
    const requestedUrl = daemonBaseUrl(host, input.port);
    const target = yield* resolveDaemonTarget(requestedUrl);

    if (yield* isServerReachable(target.baseUrl)) {
      console.log(`Daemon already running at ${target.baseUrl}.`);
      return;
    }

    if (!canAutoStartLocalDaemonForHost(host)) {
      return yield* Effect.fail(
        new Error(
          [
            `Cannot background a daemon for non-local host ${host}.`,
            `Use --foreground or bind to localhost / 127.0.0.1.`,
          ].join("\n"),
        ),
      );
    }

    const startBaseUrl = yield* spawnAndWaitForDaemon({
      host,
      scopeId: target.scopeId,
      preferredPort: input.port,
      allowedHosts: input.allowedHosts,
    });

    console.log(`Daemon ready on ${startBaseUrl}`);
  }).pipe(Effect.mapError(toError));

// ---------------------------------------------------------------------------
// Stdio MCP session
// ---------------------------------------------------------------------------

const withStdoutReroutedToStderr = async <A>(body: () => Promise<A>): Promise<A> => {
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalDebug = console.debug;
  const stderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) =>
    stderrWrite(...args)) as typeof process.stdout.write;
  console.log = console.error.bind(console);
  console.info = console.error.bind(console);
  console.debug = console.error.bind(console);

  try {
    return await body();
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    console.info = originalInfo;
    console.debug = originalDebug;
  }
};

const runStdioMcpSession = () =>
  Effect.gen(function* () {
    const executor = yield* Effect.promise(() => withStdoutReroutedToStderr(() => getExecutor()));
    yield* Effect.promise(() =>
      runMcpStdioServer({ executor, codeExecutor: makeQuickJsExecutor() }),
    );
  });

const scope = Options.string("scope").pipe(
  Options.optional,
  Options.withDescription("Path to workspace directory containing executor.jsonc"),
);

const applyScope = (s: Option.Option<string>) => {
  const dir = Option.getOrUndefined(s);
  if (dir) process.env.EXECUTOR_SCOPE_DIR = resolve(dir);
};

const parseOptionalJsonObject = (
  raw: string | undefined,
): Effect.Effect<Record<string, unknown> | undefined, Error> =>
  raw === undefined
    ? Effect.succeed(undefined)
    : parseJsonObjectInput(raw).pipe(
        Effect.mapError((error) => new Error(`Invalid --content JSON: ${error.message}`)),
      );

const formatUnknownMessage = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = cause.message;
    if (typeof message === "string") return message;
  }
  return String(cause);
};

const readCliLogLevel = (argv: ReadonlyArray<string>): string | undefined => {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === "--log-level") {
      return argv[index + 1];
    }
    if (token.startsWith("--log-level=")) {
      return token.slice("--log-level=".length);
    }
  }
  return undefined;
};

const shouldPrintVerboseErrors = (argv: ReadonlyArray<string>): boolean => {
  const level = readCliLogLevel(argv)?.trim().toLowerCase();
  return level === "all" || level === "trace" || level === "debug";
};

const renderCliError = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause);
  const raw = formatUnknownMessage(squashed);
  const normalized = normalizeCliErrorText(raw);
  if (normalized.length === 0) return "Unknown error";
  if (normalized !== raw.trim()) {
    return `${normalized}\n(run with --log-level debug for full details)`;
  }
  return normalized;
};

const parsePositiveIntegerOption = (name: string, raw: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid --${name} value: ${raw}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name} value: ${raw}`);
  }
  return parsed;
};

interface ParsedCallHelpArgs {
  readonly pathParts: ReadonlyArray<string>;
  readonly baseUrl: string;
  readonly scopeDir: string | undefined;
  readonly match: string | undefined;
  readonly limit: number | undefined;
}

const HELP_FLAGS = new Set(["--help", "-h"]);

const isHelpFlag = (value: string): boolean => HELP_FLAGS.has(value);

const parseCallHelpArgs = (args: ReadonlyArray<string>): ParsedCallHelpArgs => {
  let baseUrl = DEFAULT_BASE_URL;
  let scopeDir: string | undefined = undefined;
  let match: string | undefined = undefined;
  let limit: number | undefined = undefined;
  const pathParts: Array<string> = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token || isHelpFlag(token)) continue;

    if (token === "--base-url") {
      const value = args[index + 1];
      if (!value) throw new Error("Missing value for --base-url");
      baseUrl = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--base-url=")) {
      baseUrl = token.slice("--base-url=".length);
      continue;
    }

    if (token === "--scope") {
      const value = args[index + 1];
      if (!value) throw new Error("Missing value for --scope");
      scopeDir = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--scope=")) {
      scopeDir = token.slice("--scope=".length);
      continue;
    }

    if (token === "--log-level") {
      const value = args[index + 1];
      if (!value) throw new Error("Missing value for --log-level");
      index += 1;
      continue;
    }
    if (token.startsWith("--log-level=")) {
      continue;
    }

    if (token === "--match") {
      const value = args[index + 1];
      if (!value) throw new Error("Missing value for --match");
      match = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--match=")) {
      match = token.slice("--match=".length);
      continue;
    }

    if (token === "--limit") {
      const value = args[index + 1];
      if (!value) throw new Error("Missing value for --limit");
      limit = parsePositiveIntegerOption("limit", value);
      index += 1;
      continue;
    }
    if (token.startsWith("--limit=")) {
      const raw = token.slice("--limit=".length);
      limit = parsePositiveIntegerOption("limit", raw);
      continue;
    }

    if (token.startsWith("-")) {
      throw new Error(`Unknown option for call help: ${token}`);
    }

    pathParts.push(token);
  }

  const maybeJsonArg = pathParts.at(-1)?.trim();
  if (maybeJsonArg && maybeJsonArg.startsWith("{")) {
    pathParts.pop();
  }

  return { pathParts, baseUrl, scopeDir, match, limit };
};

const printCallBrowseHelp = (input: {
  readonly prefixSegments: ReadonlyArray<string>;
  readonly children: ReadonlyArray<{
    readonly segment: string;
    readonly invokable: boolean;
    readonly hasChildren: boolean;
    readonly toolCount: number;
  }>;
  readonly totalChildren: number;
  readonly query: string | undefined;
  readonly limit: number | undefined;
  readonly exactTool:
    | {
        readonly id: string;
        readonly description?: string;
      }
    | undefined;
}) =>
  Effect.sync(() => {
    const prefixText = input.prefixSegments.join(" ");
    const commandPrefix = `${cliPrefix} call${prefixText.length > 0 ? ` ${prefixText}` : ""}`;
    const nextPlaceholder = input.prefixSegments.length === 0 ? "<namespace>" : "<subcommand>";
    const usageLines = [
      "Usage:",
      `  ${commandPrefix} ${nextPlaceholder} [<subcommand> ...] ['{"k":"v"}']`,
      `  ${commandPrefix} --help`,
      `  ${commandPrefix} --help [--match text] [--limit integer]`,
    ];

    if (input.exactTool) {
      usageLines.push(`  ${commandPrefix} ['{"k":"v"}']`);
    }

    console.log(usageLines.join("\n"));

    if (input.exactTool) {
      console.log(`\nCallable path: ${input.exactTool.id}`);
      if (input.exactTool.description) {
        console.log(sanitizeCliOutputText(input.exactTool.description));
      }
    }

    if (input.children.length === 0) {
      console.log("\nNo subcommands at this level.");
      return;
    }

    if (input.query && input.query.trim().length > 0) {
      console.log(`\nFiltered by: ${input.query}`);
    }
    if (input.children.length < input.totalChildren || input.limit) {
      const suffix = input.limit ? ` (limit ${input.limit})` : "";
      console.log(
        `Showing ${input.children.length} of ${input.totalChildren} subcommands${suffix}.`,
      );
    }

    const rows = input.children.map((child) => {
      const kind =
        child.invokable && child.hasChildren ? "tool+group" : child.invokable ? "tool" : "group";
      return {
        name: child.segment,
        meta: `${kind}, ${child.toolCount} path${child.toolCount === 1 ? "" : "s"}`,
      };
    });

    const width = rows.reduce((max, row) => Math.max(max, row.name.length), 0);
    console.log("\nSubcommands:");
    for (const row of rows) {
      console.log(`  ${row.name.padEnd(width)}  ${row.meta}`);
    }

    console.log(`\nDrill down: ${commandPrefix} ${nextPlaceholder} --help`);
  });

const printCallLeafHelp = (input: {
  readonly tool: {
    readonly id: string;
    readonly description?: string;
  };
  readonly schema:
    | {
        readonly inputTypeScript?: string;
        readonly outputTypeScript?: string;
      }
    | undefined;
}) =>
  Effect.sync(() => {
    const segments = input.tool.id.split(".");
    const callPath = `${cliPrefix} call ${segments.join(" ")}`;

    console.log(`Usage:\n  ${callPath}\n  ${callPath} '{"k":"v"}'`);
    console.log(`\nTool: ${input.tool.id}`);
    if (input.tool.description) {
      console.log(sanitizeCliOutputText(input.tool.description));
    }
    if (input.schema?.inputTypeScript) {
      console.log(`\nInput:\n${sanitizeCliOutputText(input.schema.inputTypeScript)}`);
    }
    if (input.schema?.outputTypeScript) {
      console.log(`\nOutput:\n${sanitizeCliOutputText(input.schema.outputTypeScript)}`);
    }
  });

const applyCallHelpChildFilters = (input: {
  readonly children: ReadonlyArray<{
    readonly segment: string;
    readonly invokable: boolean;
    readonly hasChildren: boolean;
    readonly toolCount: number;
  }>;
  readonly args: ParsedCallHelpArgs;
  readonly fallbackQuery: string | undefined;
}) => {
  const query = [input.fallbackQuery, input.args.match]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .trim();
  const filtered = filterToolPathChildren(input.children, query.length > 0 ? query : undefined);
  const children =
    input.args.limit && input.args.limit > 0 ? filtered.slice(0, input.args.limit) : filtered;

  return {
    query: query.length > 0 ? query : undefined,
    filteredCount: filtered.length,
    totalCount: input.children.length,
    children,
  };
};

const runCallHelp = (
  args: ParsedCallHelpArgs,
): Effect.Effect<void, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    if (args.scopeDir) process.env.EXECUTOR_SCOPE_DIR = resolve(args.scopeDir);

    const daemonUrl = yield* ensureDaemon(args.baseUrl);
    const client = yield* makeApiClient(daemonUrl);
    const scopeInfo = yield* client.scope.info();
    const tools = yield* client.tools.list({ params: { scopeId: scopeInfo.id } });
    const toolPaths = tools.map((tool) => tool.id);

    const inspection = yield* Effect.try({
      try: () =>
        inspectToolPath({
          toolPaths,
          rawPrefixParts: args.pathParts,
        }),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(`Invalid tool path: ${String(cause)}`),
    });

    if (inspection.matchingToolCount === 0) {
      const typed = inspection.prefixSegments.join(".");
      console.error(
        typed.length > 0
          ? `No tool path starts with "${typed}".`
          : "No tools are currently registered in this scope.",
      );

      let fallback = inspectToolPath({ toolPaths, rawPrefixParts: [] });
      let mismatchToken: string | undefined = undefined;

      for (let depth = inspection.prefixSegments.length - 1; depth >= 0; depth -= 1) {
        const candidatePrefix = inspection.prefixSegments.slice(0, depth);
        const candidate = inspectToolPath({
          toolPaths,
          rawPrefixParts: candidatePrefix,
        });
        if (candidate.matchingToolCount > 0) {
          fallback = candidate;
          mismatchToken = inspection.prefixSegments[depth];
          break;
        }
      }

      const filtered = applyCallHelpChildFilters({
        children: fallback.children,
        args,
        fallbackQuery: mismatchToken,
      });
      const children = filtered.children.length > 0 ? filtered.children : fallback.children;
      const fallbackPrefix = fallback.prefixSegments.join(".");
      if (
        mismatchToken &&
        fallbackPrefix.length > 0 &&
        filtered.query &&
        filtered.filteredCount > 0
      ) {
        console.error(`Showing subcommands under "${fallbackPrefix}" matching "${mismatchToken}".`);
      }

      yield* printCallBrowseHelp({
        prefixSegments: fallback.prefixSegments,
        children,
        totalChildren:
          filtered.children.length > 0 ? filtered.totalCount : fallback.children.length,
        query: filtered.children.length > 0 ? filtered.query : undefined,
        limit: filtered.children.length > 0 ? args.limit : undefined,
        exactTool: undefined,
      });
      process.exitCode = 1;
      return;
    }

    const exactTool = inspection.exactPath
      ? tools.find((tool) => tool.id === inspection.exactPath)
      : undefined;

    if (exactTool && inspection.children.length === 0) {
      const schema = yield* client.tools
        .schema({
          params: {
            scopeId: scopeInfo.id,
            toolId: exactTool.id,
          },
        })
        .pipe(
          Effect.map((result) => ({
            inputTypeScript: result.inputTypeScript,
            outputTypeScript: result.outputTypeScript,
          })),
          Effect.catchCause(() => Effect.succeed(undefined)),
        );

      yield* printCallLeafHelp({
        tool: {
          id: exactTool.id,
          description: exactTool.description,
        },
        schema,
      });
      return;
    }

    const filtered = applyCallHelpChildFilters({
      children: inspection.children,
      args,
      fallbackQuery: undefined,
    });

    yield* printCallBrowseHelp({
      prefixSegments: inspection.prefixSegments,
      children: filtered.children,
      totalChildren: filtered.totalCount,
      query: filtered.query,
      limit: args.limit,
      exactTool: exactTool
        ? {
            id: exactTool.id,
            description: exactTool.description,
          }
        : undefined,
    });
  }).pipe(Effect.mapError(toError));

const resolveToolInvocation = (input: {
  rawPathParts: ReadonlyArray<string>;
}): Effect.Effect<{ path: string; args: Record<string, unknown> }, Error> =>
  Effect.gen(function* () {
    if (!Array.isArray(input.rawPathParts)) {
      return yield* Effect.fail(
        new Error("Invalid tool invocation: path parts were not parsed as an array"),
      );
    }

    const maybeJsonArg = input.rawPathParts.at(-1)?.trim();
    const hasInlineJsonArg = maybeJsonArg !== undefined && maybeJsonArg.startsWith("{");
    const pathParts = hasInlineJsonArg ? input.rawPathParts.slice(0, -1) : input.rawPathParts;
    const args = hasInlineJsonArg ? yield* parseJsonObjectInput(maybeJsonArg) : {};

    if (pathParts.some((part) => part.trim().startsWith("-"))) {
      return yield* Effect.fail(
        new Error(
          "Tool invocation no longer accepts flags. Use: executor call <path...> '{...json...}'",
        ),
      );
    }

    const path = yield* Effect.try({
      try: () => buildToolPath(pathParts),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(`Invalid tool path: ${String(cause)}`),
    });

    return { path, args };
  });

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const callCommand = Command.make(
  "call",
  {
    pathParts: Args.string("tool-path-segment").pipe(Args.variadic({})),
    baseUrl: Options.string("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
    scope,
  },
  ({ pathParts, baseUrl, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const { path, args } = yield* resolveToolInvocation({
        rawPathParts: pathParts,
      });
      const code = yield* Effect.try({
        try: () => buildInvokeToolCode(path, args),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(`Invalid tool path: ${String(cause)}`),
      });

      const outcome = yield* executeCode({ baseUrl, code });
      yield* printExecutionOutcome({ baseUrl, outcome });
    }),
).pipe(
  Command.withDescription(
    'Invoke a tool path (e.g. `executor call github issues create \'{"title":"Hi"}\'`). Use `--help` to browse by namespace/path (`--match`, `--limit`).',
  ),
);

const resumeCommand = Command.make(
  "resume",
  {
    executionId: Options.string("execution-id").pipe(
      Options.withDescription("Execution ID returned by a paused call"),
    ),
    action: Options.choice("action", ["accept", "decline", "cancel"] as const).pipe(
      Options.withDefault("accept"),
      Options.withDescription("Interaction response action"),
    ),
    content: Options.string("content").pipe(
      Options.optional,
      Options.withDescription("JSON object to send when action=accept"),
    ),
    baseUrl: Options.string("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
    scope,
  },
  ({ executionId, action, content, baseUrl, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const daemonUrl = yield* ensureDaemon(baseUrl);

      const contentObj = yield* parseOptionalJsonObject(Option.getOrUndefined(content));

      const client = yield* makeApiClient(daemonUrl);
      const result = yield* client.executions.resume({
        params: { executionId },
        payload: { action, content: contentObj },
      });

      if (result.isError) {
        if (shouldPrintVerboseErrors(process.argv)) {
          console.error(result.text);
        } else {
          const normalized = normalizeCliErrorText(result.text);
          console.error(
            normalized.length > 0
              ? normalized
              : "Resume failed (run with --log-level debug for full details).",
          );
        }
        process.exit(1);
      } else {
        console.log(result.text);
        process.exit(0);
      }
    }),
).pipe(Command.withDescription("Resume a paused execution"));

const toolsSearchCommand = Command.make(
  "search",
  {
    query: Args.string("query"),
    namespace: Options.string("namespace").pipe(Options.optional),
    limit: Options.integer("limit").pipe(Options.withDefault(12)),
    baseUrl: Options.string("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
    scope,
  },
  ({ query, namespace, limit, baseUrl, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const code = buildSearchToolsCode({
        query,
        namespace: Option.getOrUndefined(namespace),
        limit,
      });

      const outcome = yield* executeCode({ baseUrl, code });
      yield* printExecutionOutcome({ baseUrl, outcome });
    }),
).pipe(Command.withDescription("Search tools by natural-language query"));

const toolsSourcesCommand = Command.make(
  "sources",
  {
    query: Options.string("query").pipe(Options.optional),
    limit: Options.integer("limit").pipe(Options.withDefault(50)),
    baseUrl: Options.string("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
    scope,
  },
  ({ query, limit, baseUrl, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const code = buildListSourcesCode({
        query: Option.getOrUndefined(query),
        limit,
      });

      const outcome = yield* executeCode({ baseUrl, code });
      yield* printExecutionOutcome({ baseUrl, outcome });
    }),
).pipe(Command.withDescription("List configured sources and tool counts"));

const toolsDescribeCommand = Command.make(
  "describe",
  {
    path: Args.string("path"),
    baseUrl: Options.string("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
    scope,
  },
  ({ path, baseUrl, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const code = buildDescribeToolCode(path);
      const outcome = yield* executeCode({ baseUrl, code });
      yield* printExecutionOutcome({ baseUrl, outcome });
    }),
).pipe(Command.withDescription("Describe a tool's TypeScript and JSON schema"));

const toolsCommand = Command.make("tools").pipe(
  Command.withSubcommands([toolsSearchCommand, toolsSourcesCommand, toolsDescribeCommand] as const),
  Command.withDescription("Discover available tools and sources"),
);

const webCommand = Command.make(
  "web",
  {
    port: Options.integer("port").pipe(Options.withDefault(DEFAULT_PORT)),
    hostname: Options.string("hostname")
      .pipe(Options.withDefault("127.0.0.1"))
      .pipe(Options.withDescription("Bind address. Use 0.0.0.0 to listen on all interfaces.")),
    allowedHost: Options.string("allowed-host")
      .pipe(Options.atLeast(0))
      .pipe(
        Options.withDescription(
          "Additional hostname permitted in the Host header (repeatable). localhost/127.0.0.1 are always allowed.",
        ),
      ),
    authToken: Options.string("auth-token")
      .pipe(Options.optional)
      .pipe(Options.withDescription("Bearer token required for requests.")),
    authPassword: Options.string("auth-password")
      .pipe(Options.optional)
      .pipe(Options.withDescription("Basic auth password required for requests.")),
    scope,
  },
  ({ port, scope, hostname, allowedHost, authToken, authPassword }) =>
    Effect.gen(function* () {
      applyScope(scope);
      yield* runForegroundSession({
        port,
        hostname,
        allowedHosts: allowedHost,
        authToken: Option.getOrUndefined(authToken),
        authPassword: Option.getOrUndefined(authPassword),
      });
    }),
).pipe(Command.withDescription("Start a foreground web session"));

const daemonRunCommand = Command.make(
  "run",
  {
    port: Options.integer("port").pipe(Options.withDefault(DEFAULT_PORT)),
    hostname: Options.string("hostname")
      .pipe(Options.withDefault("127.0.0.1"))
      .pipe(Options.withDescription("Bind address. Keep this local unless you trust the network.")),
    allowedHost: Options.string("allowed-host")
      .pipe(Options.atLeast(0))
      .pipe(
        Options.withDescription(
          "Additional hostname permitted in the Host header (repeatable). localhost/127.0.0.1 are always allowed.",
        ),
      ),
    authToken: Options.string("auth-token")
      .pipe(Options.optional)
      .pipe(Options.withDescription("Bearer token required for requests.")),
    authPassword: Options.string("auth-password")
      .pipe(Options.optional)
      .pipe(Options.withDescription("Basic auth password required for requests.")),
    foreground: Options.boolean("foreground")
      .pipe(Options.withDefault(false))
      .pipe(
        Options.withDescription(
          "Run the daemon in this process instead of detaching. Useful for inspecting logs.",
        ),
      ),
    scope,
  },
  ({ port, scope, hostname, allowedHost, authToken, authPassword, foreground }) =>
    Effect.gen(function* () {
      applyScope(scope);
      if (foreground) {
        yield* runDaemonSession({
          port,
          hostname,
          allowedHosts: allowedHost,
          authToken: Option.getOrUndefined(authToken),
          authPassword: Option.getOrUndefined(authPassword),
        });
      } else {
        yield* runBackgroundDaemonStart({ port, hostname, allowedHosts: allowedHost });
      }
    }),
).pipe(Command.withDescription("Run the local executor daemon (background by default)"));

const daemonStatusCommand = Command.make(
  "status",
  {
    baseUrl: Options.string("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
  },
  ({ baseUrl }) =>
    Effect.gen(function* () {
      const target = yield* resolveDaemonTarget(baseUrl);
      const host = canonicalDaemonHost(target.hostname);

      const [record, reachable] = yield* Effect.all([
        readDaemonRecord({ hostname: host, port: target.port }),
        isServerReachable(target.baseUrl),
      ]);

      if (!record) {
        if (reachable) {
          console.log(`Daemon reachable at ${target.baseUrl} (no local ownership record).`);
        } else {
          console.log(`Daemon not running at ${target.baseUrl}.`);
        }
        return;
      }

      if (!isPidAlive(record.pid)) {
        if (!reachable) {
          yield* removeDaemonRecord({ hostname: host, port: target.port });
          yield* removeDaemonPointer({ hostname: host, scopeId: target.scopeId }).pipe(
            Effect.ignore,
          );
          console.log(
            `Daemon not running at ${target.baseUrl} (removed stale record for pid ${record.pid}).`,
          );
          return;
        }
        console.log(
          `Daemon reachable at ${target.baseUrl}, but recorded pid ${record.pid} is not alive (ownership mismatch).`,
        );
        return;
      }

      const state = reachable ? "running" : "unreachable";
      console.log(`Daemon ${state} at ${target.baseUrl} (pid ${record.pid}).`);
      if (target.baseUrl !== baseUrl) {
        console.log(`Requested: ${baseUrl}`);
      }
      if (record.scopeDir) {
        console.log(`Scope: ${record.scopeDir}`);
      }
    }),
).pipe(Command.withDescription("Show daemon status"));

const daemonStopCommand = Command.make(
  "stop",
  {
    baseUrl: Options.string("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
  },
  ({ baseUrl }) => stopDaemon(baseUrl),
).pipe(Command.withDescription("Stop the local daemon"));

const daemonRestartCommand = Command.make(
  "restart",
  {
    baseUrl: Options.string("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
    scope,
  },
  ({ baseUrl, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      yield* stopDaemon(baseUrl);
      const daemonUrl = yield* ensureDaemon(baseUrl);
      console.log(`Daemon restarted at ${daemonUrl}.`);
    }),
).pipe(Command.withDescription("Restart the local daemon"));

const daemonCommand = Command.make("daemon").pipe(
  Command.withSubcommands([
    daemonRunCommand,
    daemonStatusCommand,
    daemonStopCommand,
    daemonRestartCommand,
  ] as const),
  Command.withDescription("Manage the local daemon"),
);

const mcpCommand = Command.make("mcp", { scope }, ({ scope }) =>
  Effect.gen(function* () {
    applyScope(scope);
    yield* runStdioMcpSession();
  }),
).pipe(Command.withDescription("Start an MCP server over stdio"));

// ---------------------------------------------------------------------------
// Root command
// ---------------------------------------------------------------------------

const root = Command.make("executor").pipe(
  Command.withSubcommands([
    callCommand,
    resumeCommand,
    toolsCommand,
    webCommand,
    daemonCommand,
    mcpCommand,
  ] as const),
  Command.withDescription("Executor local CLI"),
);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const runCli = Command.run(root, {
  version: CLI_VERSION,
});

if (process.argv.includes("-v")) {
  console.log(CLI_VERSION);
  process.exit(0);
}

const isCallHelpInvocation =
  process.argv[2] === "call" && process.argv.slice(3).some((arg) => isHelpFlag(arg));

// Kick off the integrations.sh registry fetch on a sidecar runtime — see
// `./integrations`. Skipped on `-v` (short-circuits earlier).
fetchIntegrations();

const program = (
  isCallHelpInvocation
    ? Effect.gen(function* () {
        const args = yield* Effect.try({
          try: () => parseCallHelpArgs(process.argv.slice(3)),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });
        yield* runCallHelp(args);
      })
    : runCli
).pipe(
  Effect.provide(BunServices.layer),
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      if (shouldPrintVerboseErrors(process.argv)) {
        console.error(Cause.pretty(cause));
      } else {
        console.error(renderCliError(cause));
      }
      process.exitCode = 1;
    }),
  ),
);

BunRuntime.runMain(program as Effect.Effect<void, never, never>);
