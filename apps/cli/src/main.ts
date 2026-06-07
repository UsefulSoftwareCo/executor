// MUST be first: publishes the colocated libSQL/keyring native `.node` paths
// before any import (e.g. `@executor-js/local` → libSQL) eagerly loads them.
import "./native-bindings";

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
// Make sibling binaries (if any are added later) discoverable on $PATH so
// child processes spawned without an absolute path still find them.
const execDir = dirname(process.execPath);
if (process.env.PATH && !process.env.PATH.includes(execDir)) {
  process.env.PATH = `${execDir}:${process.env.PATH}`;
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
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { FileSystem, Path as PlatformPath } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";

import { ExecutorApi } from "@executor-js/api";
import {
  DEFAULT_EXECUTOR_SERVER_USERNAME,
  getExecutorServerAuthorizationHeader,
  normalizeExecutorServerConnection,
  type ExecutorLocalServerKind,
  type ExecutorLocalServerManifest,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
} from "@executor-js/sdk/shared";
import { startServer, runMcpStdioServer, getExecutor } from "@executor-js/local";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { fetchIntegrations } from "./integrations";
import {
  buildDaemonSpawnSpec,
  chooseDaemonPort,
  canAutoStartLocalDaemonForHost,
  isExecutorServerReachable,
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
  canAutoStartCliServerConnection,
  chooseCliServerConnectionWithActiveLocal,
  parseCliExecutorServerConnection,
  type CliServerConnectionSource,
  withCliServerAuthFallback,
} from "./server-connection";
import {
  acquireLocalServerStartLock,
  readLocalServerManifest,
  releaseLocalServerStartLock,
  removeLocalServerManifestIfOwnedBy,
  resolveExecutorDataDir,
  writeLocalServerManifest,
} from "./local-server-manifest";
import {
  defaultCliServerConnectionProfile,
  findCliServerConnectionProfile,
  readCliServerConnectionStore,
  removeCliServerConnectionProfile,
  setDefaultCliServerConnectionProfile,
  upsertCliServerConnectionProfile,
  validateCliServerConnectionProfileName,
} from "./server-profile";
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

const isServerReachable = (baseUrl: string, authorization?: string): Effect.Effect<boolean> =>
  isExecutorServerReachable({ baseUrl, authorization });

const readActiveLocalServerManifest = (): Effect.Effect<
  ExecutorLocalServerManifest | null,
  Error,
  FileSystem.FileSystem | PlatformPath.Path
> =>
  Effect.gen(function* () {
    const manifest = yield* readLocalServerManifest();
    if (!manifest) return null;

    if (!isPidAlive(manifest.pid)) {
      yield* removeLocalServerManifestIfOwnedBy({ pid: manifest.pid }).pipe(Effect.ignore);
      return null;
    }

    const authorization = getExecutorServerAuthorizationHeader(manifest.connection) ?? undefined;
    if (yield* isServerReachable(manifest.connection.origin, authorization)) {
      return manifest;
    }

    return yield* Effect.fail(
      new Error(
        [
          `A local Executor ${manifest.kind} is registered at ${manifest.connection.origin} (pid ${manifest.pid}) but is not reachable.`,
          "Refusing to start another local server against the same data directory.",
          "Stop the existing process or remove the stale server-control manifest after verifying the process is not using the database.",
        ].join("\n"),
      ),
    );
  });

const normalizeDaemonScopeDir = (dir: string): string => {
  const resolved = resolve(dir);
  return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
};

const currentScopeDirForManifest = (): string | null =>
  process.env.EXECUTOR_SCOPE_DIR ? normalizeDaemonScopeDir(process.env.EXECUTOR_SCOPE_DIR) : null;

const script = process.argv[1];
const isDevMode = isDevCliEntrypoint(script);
const cliPrefix = isDevMode ? `bun run ${script}` : "executor";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

interface ServerTarget {
  readonly baseUrl?: string;
  readonly serverName?: string;
}

interface RequestedExecutorServerConnection {
  readonly connection: ExecutorServerConnection;
  readonly source: CliServerConnectionSource;
}

interface ExecuteCodeResult {
  readonly connection: ExecutorServerConnection;
  readonly outcome: ExecuteCodeOutcome;
}

const parseDaemonUrl = (baseUrl: string) =>
  Effect.try({
    try: () => parseDaemonBaseUrl(baseUrl, DEFAULT_PORT),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(`Invalid base URL: ${String(cause)}`),
  });

const parseExecutorServerConnection = (baseUrl: string) =>
  Effect.try({
    try: () => parseCliExecutorServerConnection(baseUrl),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(`Invalid server URL: ${String(cause)}`),
  });

const daemonBaseUrl = (hostname: string, port: number): string =>
  `http://${canonicalDaemonHost(hostname)}:${port}`;

const serverAuthFromInputs = (input: {
  readonly authToken: string | undefined;
  readonly authPassword: string | undefined;
}): ExecutorServerConnection["auth"] | undefined => {
  if (input.authPassword) {
    return {
      kind: "basic",
      username: DEFAULT_EXECUTOR_SERVER_USERNAME,
      password: input.authPassword,
    };
  }
  if (input.authToken) return { kind: "bearer", token: input.authToken };
  return undefined;
};

const makeLocalServerManifest = (input: {
  readonly kind: ExecutorLocalServerKind;
  readonly connection: ExecutorServerConnection;
}): Effect.Effect<ExecutorLocalServerManifest, never, PlatformPath.Path> =>
  Effect.gen(function* () {
    const path = yield* PlatformPath.Path;
    return {
      version: 1,
      kind: input.kind,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      dataDir: resolveExecutorDataDir(path),
      scopeDir: currentScopeDirForManifest(),
      connection: input.connection,
      owner: {
        client: "cli",
        version: CLI_VERSION,
        executablePath: isDevMode ? (script ?? null) : process.execPath,
      },
    };
  });

const assertNoOtherActiveLocalServer = (): Effect.Effect<
  void,
  Error,
  FileSystem.FileSystem | PlatformPath.Path
> =>
  Effect.gen(function* () {
    const active = yield* readActiveLocalServerManifest();
    if (!active || active.pid === process.pid) return;
    return yield* Effect.fail(
      new Error(
        [
          `A local Executor ${active.kind} is already running at ${active.connection.origin} (pid ${active.pid}).`,
          `It owns the current data directory: ${active.dataDir}`,
          "Stop it before starting another local server.",
        ].join("\n"),
      ),
    );
  });

const publishLocalServerManifest = (input: {
  readonly kind: ExecutorLocalServerKind;
  readonly connection: ExecutorServerConnection;
}): Effect.Effect<void, PlatformError, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const manifest = yield* makeLocalServerManifest(input);
    yield* writeLocalServerManifest(manifest);
  });

const installDefaultExecutorWebBaseUrl = (baseUrl: string): (() => void) => {
  if (process.env.EXECUTOR_WEB_BASE_URL !== undefined) {
    return () => {};
  }

  process.env.EXECUTOR_WEB_BASE_URL = baseUrl;
  return () => {
    delete process.env.EXECUTOR_WEB_BASE_URL;
  };
};

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
          fromPointer: true,
        };
      }

      yield* cleanupPointer({ hostname: pointer.hostname, scopeId, port: pointer.port });
    }

    return {
      baseUrl: daemonBaseUrl(host, parsed.port),
      hostname: host,
      port: parsed.port,
      scopeId,
      fromPointer: false,
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
    if (resolvedTarget.fromPointer && (yield* isServerReachable(resolvedTarget.baseUrl))) {
      return resolvedTarget.baseUrl;
    }

    const active = yield* readActiveLocalServerManifest();
    const activeOrigin = active
      ? normalizeExecutorServerConnection({ origin: active.connection.origin }).origin
      : null;
    const targetOrigin = normalizeExecutorServerConnection({
      origin: resolvedTarget.baseUrl,
    }).origin;
    if (activeOrigin === targetOrigin) {
      return resolvedTarget.baseUrl;
    }

    if (active && activeOrigin !== targetOrigin) {
      return yield* Effect.fail(
        new Error(
          [
            `A local Executor ${active.kind} is already running at ${active.connection.origin} (pid ${active.pid}).`,
            `It owns the current data directory: ${active.dataDir}`,
            "Refusing to start another local daemon against the same database.",
          ].join("\n"),
        ),
      );
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

const resolveRequestedExecutorServerConnection = (
  target: ServerTarget,
): Effect.Effect<
  RequestedExecutorServerConnection,
  Error,
  FileSystem.FileSystem | PlatformPath.Path
> =>
  Effect.gen(function* () {
    if (target.baseUrl && target.serverName) {
      return yield* Effect.fail(new Error("Use either --server or --base-url, not both."));
    }

    if (target.serverName) {
      const store = yield* readCliServerConnectionStore();
      const profile = findCliServerConnectionProfile(store, target.serverName);
      if (!profile) {
        return yield* Effect.fail(new Error(`No server profile named "${target.serverName}".`));
      }
      return { connection: withCliServerAuthFallback(profile.connection), source: "explicit" };
    }

    if (!target.baseUrl) {
      const store = yield* readCliServerConnectionStore();
      const profile = defaultCliServerConnectionProfile(store);
      if (profile) {
        return {
          connection: withCliServerAuthFallback(profile.connection),
          source: "default-profile",
        };
      }

      const active = yield* readActiveLocalServerManifest();
      if (active) return { connection: active.connection, source: "active-local" };
    }

    return {
      connection: yield* parseExecutorServerConnection(target.baseUrl ?? DEFAULT_BASE_URL),
      source: target.baseUrl ? "explicit" : "implicit-default",
    };
  });

const resolveExecutorServerConnection = (
  target: ServerTarget,
): Effect.Effect<ExecutorServerConnection, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const requestedResult = yield* resolveRequestedExecutorServerConnection(target);
    const active = yield* readActiveLocalServerManifest();
    const decision = chooseCliServerConnectionWithActiveLocal({
      requested: requestedResult.connection,
      source: requestedResult.source,
      active,
    });

    if (decision.kind === "conflict") {
      return yield* Effect.fail(
        new Error(
          [
            `A local Executor ${decision.active.kind} is already running at ${decision.active.connection.origin} (pid ${decision.active.pid}).`,
            `It owns the current data directory: ${decision.active.dataDir}`,
            "Refusing to auto-start another local server against the same database.",
            `Use the active server, or stop it before starting ${cliPrefix} daemon run.`,
          ].join("\n"),
        ),
      );
    }

    const requested = decision.connection;
    if (decision.kind === "use-active") return requested;

    if (!canAutoStartCliServerConnection(requested)) {
      const authorization = getExecutorServerAuthorizationHeader(requested) ?? undefined;
      if (yield* isServerReachable(requested.origin, authorization)) {
        return requested;
      }
      return yield* Effect.fail(
        new Error(
          [
            `Executor server is not reachable at ${requested.origin}.`,
            "For hosted Executor, set EXECUTOR_API_KEY to a bearer API key.",
            "For password-protected local or desktop servers, set EXECUTOR_AUTH_PASSWORD.",
            "For unauthenticated local Executor, use an http://localhost or http://127.0.0.1 server URL.",
          ].join("\n"),
        ),
      );
    }

    const daemonUrl = yield* ensureDaemon(requested.origin);
    return normalizeExecutorServerConnection({
      ...requested,
      origin: daemonUrl,
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
    yield* removeLocalServerManifestIfOwnedBy({ pid: record.pid }).pipe(Effect.ignore);
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
      readonly approvalUrl: string | undefined;
      readonly interaction:
        | {
            readonly kind: "url" | "form";
            readonly message: string;
            readonly url?: string;
            readonly requestedSchema?: Record<string, unknown>;
          }
        | undefined;
    };

const buildResumeApprovalUrl = (baseUrl: string, executionId: string): string => {
  const url = new URL(`/resume/${encodeURIComponent(executionId)}`, baseUrl);
  return url.toString();
};

const executeCode = (input: {
  target: ServerTarget;
  code: string;
}): Effect.Effect<ExecuteCodeResult, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const connection = yield* resolveExecutorServerConnection(input.target);
    const client = yield* makeApiClient(connection);
    const response = yield* client.executions.execute({
      payload: {
        code: input.code,
      },
    });

    if (response.status === "paused") {
      const executionId = extractExecutionId(response.structured);
      return {
        connection,
        outcome: {
          status: "paused" as const,
          text: response.text,
          executionId,
          approvalUrl: executionId
            ? buildResumeApprovalUrl(connection.origin, executionId)
            : undefined,
          interaction: extractPausedInteraction(response.structured),
        },
      };
    }

    if (response.isError) {
      return yield* Effect.fail(new Error(response.text));
    }

    return {
      connection,
      outcome: {
        status: "completed" as const,
        result: extractExecutionResult(response.structured),
      },
    };
  }).pipe(Effect.mapError(toError));

const serverTargetResumeFlag = (
  target: ServerTarget,
  connection: ExecutorServerConnection,
): string =>
  target.serverName
    ? `--server ${shellQuoteArg(target.serverName)}`
    : `--base-url ${shellQuoteArg(target.baseUrl ?? connection.origin)}`;

const printExecutionOutcome = (input: {
  target: ServerTarget;
  connection: ExecutorServerConnection;
  outcome: ExecuteCodeOutcome;
}) =>
  Effect.sync(() => {
    if (input.outcome.status === "paused") {
      console.log(input.outcome.text);
      if (input.outcome.executionId) {
        if (input.outcome.approvalUrl) {
          console.log("\nApprove in browser:");
          console.log(`  ${input.outcome.approvalUrl}`);
        }
        const commandPrefix = `${cliPrefix} resume --execution-id ${input.outcome.executionId} ${serverTargetResumeFlag(input.target, input.connection)}`;
        if (input.outcome.interaction?.kind === "form") {
          const requestedSchema = input.outcome.interaction.requestedSchema;
          if (requestedSchema && Object.keys(requestedSchema).length > 0) {
            console.log(`\nRequested schema:\n${JSON.stringify(requestedSchema, null, 2)}`);
          }
          const template = buildResumeContentTemplate(requestedSchema);
          const contentArg = shellQuoteArg(JSON.stringify(template));
          console.log("\nCLI fallback:");
          console.log(`  ${commandPrefix} --action accept --content ${contentArg}`);
          console.log(`  ${commandPrefix} --action decline`);
          console.log(`  ${commandPrefix} --action cancel`);
        } else {
          console.log("\nCLI fallback:");
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

const makeApiClient = (connection: ExecutorServerConnection) => {
  const authorization = getExecutorServerAuthorizationHeader(connection);
  return HttpApiClient.make(ExecutorApi, {
    baseUrl: connection.apiBaseUrl,
    ...(authorization
      ? {
          transformClient: HttpClient.mapRequest((request) =>
            HttpClientRequest.setHeader(request, "authorization", authorization),
          ),
        }
      : {}),
  }).pipe(Effect.provide(FetchHttpClient.layer));
};

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
    const displayHost =
      input.hostname === "0.0.0.0" || input.hostname === "::" ? "localhost" : input.hostname;
    const restoreWebBaseUrl = installDefaultExecutorWebBaseUrl(
      `http://${displayHost}:${input.port}`,
    );

    try {
      const startupLock = yield* acquireLocalServerStartLock();
      let server: Awaited<ReturnType<typeof startServer>> | null = null;
      let baseUrl: string | null = null;

      try {
        yield* assertNoOtherActiveLocalServer();
        server = yield* Effect.promise(() =>
          startServer({
            port: input.port,
            hostname: input.hostname,
            allowedHosts: input.allowedHosts,
            authToken: input.authToken,
            authPassword: input.authPassword,
            embeddedWebUI,
          }),
        );
        baseUrl = `http://${displayHost}:${server.port}`;
        yield* publishLocalServerManifest({
          kind: "foreground",
          connection: normalizeExecutorServerConnection({
            kind: "http",
            origin: baseUrl,
            displayName: "CLI web",
            auth: serverAuthFromInputs(input),
          }),
        });
      } finally {
        yield* releaseLocalServerStartLock(startupLock).pipe(Effect.ignore);
      }

      if (!server || !baseUrl) {
        return yield* Effect.fail(new Error("Failed to start local Executor server."));
      }

      try {
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
      } finally {
        yield* Effect.promise(() => server.stop());
        yield* removeLocalServerManifestIfOwnedBy({ pid: process.pid }).pipe(Effect.ignore);
      }
    } finally {
      restoreWebBaseUrl();
    }
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
    const restoreWebBaseUrl = installDefaultExecutorWebBaseUrl(
      daemonBaseUrl(daemonHost, input.port),
    );
    const scopeId = currentDaemonScopeId();

    try {
      const startupLock = yield* acquireLocalServerStartLock();
      let server: Awaited<ReturnType<typeof startServer>> | null = null;
      let daemonPort: number | null = null;
      let token: string | null = null;

      try {
        yield* assertNoOtherActiveLocalServer();

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

        server = yield* Effect.promise(() =>
          startServer({
            port: input.port,
            hostname: input.hostname,
            allowedHosts: input.allowedHosts,
            authToken: input.authToken,
            authPassword: input.authPassword,
            embeddedWebUI,
          }),
        );

        daemonPort = server.port;
        token = randomUUID();
        const daemonUrl = daemonBaseUrl(daemonHost, daemonPort);
        yield* publishLocalServerManifest({
          kind: "cli-daemon",
          connection: normalizeExecutorServerConnection({
            kind: "http",
            origin: daemonUrl,
            displayName: "CLI daemon",
            auth: serverAuthFromInputs(input),
          }),
        });
      } finally {
        yield* releaseLocalServerStartLock(startupLock).pipe(Effect.ignore);
      }

      if (!server || daemonPort === null || token === null) {
        return yield* Effect.fail(new Error("Failed to start local Executor daemon."));
      }

      try {
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

        yield* waitForShutdownSignal();
      } finally {
        yield* Effect.promise(() => server.stop());
        yield* removeDaemonRecord({ hostname: daemonHost, port: daemonPort });
        yield* removeDaemonPointer({ hostname: daemonHost, scopeId }).pipe(Effect.ignore);
        yield* removeLocalServerManifestIfOwnedBy({ pid: process.pid }).pipe(Effect.ignore);
      }
    } finally {
      restoreWebBaseUrl();
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

const runStdioMcpSession = (input: { readonly elicitationMode: "browser" | "model" }) =>
  Effect.gen(function* () {
    const startupLock = yield* acquireLocalServerStartLock();
    let web: Awaited<
      ReturnType<
        typeof withStdoutReroutedToStderr<{
          readonly executor: Awaited<ReturnType<typeof getExecutor>>;
          readonly server: Awaited<ReturnType<typeof startServer>>;
          readonly baseUrl: string;
          readonly restoreWebBaseUrl: () => void;
        }>
      >
    > | null = null;

    try {
      yield* assertNoOtherActiveLocalServer();
      web = yield* Effect.promise(() =>
        withStdoutReroutedToStderr(async () => {
          const host = "127.0.0.1";
          const port = await Effect.runPromise(
            chooseDaemonPort({ preferredPort: DEFAULT_PORT, hostname: host }),
          );
          const baseUrl = `http://localhost:${port}`;
          const restoreWebBaseUrl = installDefaultExecutorWebBaseUrl(baseUrl);

          try {
            const executor = await getExecutor();
            const server = await startServer({
              port,
              hostname: host,
              embeddedWebUI,
            });
            const serverBaseUrl = `http://localhost:${server.port}`;
            return { executor, server, baseUrl: serverBaseUrl, restoreWebBaseUrl };
          } catch (cause) {
            restoreWebBaseUrl();
            throw cause;
          }
        }),
      );
      yield* publishLocalServerManifest({
        kind: "foreground",
        connection: normalizeExecutorServerConnection({
          kind: "http",
          origin: web.baseUrl,
          displayName: "CLI MCP",
        }),
      });
    } finally {
      yield* releaseLocalServerStartLock(startupLock).pipe(Effect.ignore);
    }

    if (!web) return yield* Effect.fail(new Error("Failed to start local Executor MCP server."));

    try {
      yield* Effect.promise(() =>
        runMcpStdioServer({
          executor: web.executor,
          codeExecutor: makeQuickJsExecutor(),
          elicitationMode:
            input.elicitationMode === "browser"
              ? {
                  mode: "browser" as const,
                  approvalUrl: (executionId) =>
                    `${web.baseUrl}/resume/${encodeURIComponent(executionId)}`,
                }
              : { mode: input.elicitationMode },
        }),
      );
    } finally {
      web.restoreWebBaseUrl();
      yield* Effect.promise(() => web.server.stop());
      yield* removeLocalServerManifestIfOwnedBy({ pid: process.pid }).pipe(Effect.ignore);
    }
  });

const scope = Options.string("scope").pipe(
  Options.optional,
  Options.withDescription("Path to workspace directory containing executor.jsonc"),
);

const serverBaseUrl = Options.string("base-url").pipe(
  Options.optional,
  Options.withDescription(
    "Executor server origin. Overrides the default profile; local URLs auto-start the daemon.",
  ),
);

const serverProfile = Options.string("server").pipe(
  Options.optional,
  Options.withDescription("Named Executor server profile."),
);

const daemonBaseUrlOption = Options.string("base-url").pipe(
  Options.withDefault(DEFAULT_BASE_URL),
  Options.withDescription("Local daemon origin."),
);

const serverTargetFromOptions = (input: {
  readonly baseUrl: Option.Option<string>;
  readonly server: Option.Option<string>;
}): ServerTarget => ({
  baseUrl: Option.getOrUndefined(input.baseUrl),
  serverName: Option.getOrUndefined(input.server),
});

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
  readonly baseUrl: string | undefined;
  readonly serverName: string | undefined;
  readonly scopeDir: string | undefined;
  readonly match: string | undefined;
  readonly limit: number | undefined;
}

const HELP_FLAGS = new Set(["--help", "-h"]);

const isHelpFlag = (value: string): boolean => HELP_FLAGS.has(value);

const parseCallHelpArgs = (args: ReadonlyArray<string>): ParsedCallHelpArgs => {
  let baseUrl: string | undefined = undefined;
  let serverName: string | undefined = undefined;
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

    if (token === "--server") {
      const value = args[index + 1];
      if (!value) throw new Error("Missing value for --server");
      serverName = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--server=")) {
      serverName = token.slice("--server=".length);
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

  return { pathParts, baseUrl, serverName, scopeDir, match, limit };
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

    const connection = yield* resolveExecutorServerConnection({
      baseUrl: args.baseUrl,
      serverName: args.serverName,
    });
    const client = yield* makeApiClient(connection);
    const tools = yield* client.tools.list({ query: {} });
    const toolPaths = tools.map((tool) => tool.address);

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
      ? tools.find((tool) => tool.address === inspection.exactPath)
      : undefined;

    if (exactTool && inspection.children.length === 0) {
      const schema = yield* client.tools
        .schema({
          query: {
            address: exactTool.address,
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
          id: exactTool.address,
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
            id: exactTool.address,
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
    baseUrl: serverBaseUrl,
    server: serverProfile,
    scope,
  },
  ({ pathParts, baseUrl, server, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const target = serverTargetFromOptions({ baseUrl, server });
      const { path, args } = yield* resolveToolInvocation({
        rawPathParts: pathParts,
      });
      const code = yield* Effect.try({
        try: () => buildInvokeToolCode(path, args),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(`Invalid tool path: ${String(cause)}`),
      });

      const result = yield* executeCode({ target, code });
      yield* printExecutionOutcome({
        target,
        connection: result.connection,
        outcome: result.outcome,
      });
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
    baseUrl: serverBaseUrl,
    server: serverProfile,
    scope,
  },
  ({ executionId, action, content, baseUrl, server, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const target = serverTargetFromOptions({ baseUrl, server });
      const connection = yield* resolveExecutorServerConnection(target);

      const contentObj = yield* parseOptionalJsonObject(Option.getOrUndefined(content));

      const client = yield* makeApiClient(connection);
      const result = yield* client.executions.resume({
        params: { executionId },
        payload: { action, content: contentObj },
      });

      if (result.status === "paused") {
        console.log(result.text);
        const nextExecutionId = extractExecutionId(result.structured);
        if (nextExecutionId) {
          console.log("");
          console.log("Approval required:");
          console.log(buildResumeApprovalUrl(connection.origin, nextExecutionId));
        }
        process.exit(0);
      }

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
    baseUrl: serverBaseUrl,
    server: serverProfile,
    scope,
  },
  ({ query, namespace, limit, baseUrl, server, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const target = serverTargetFromOptions({ baseUrl, server });
      const code = buildSearchToolsCode({
        query,
        namespace: Option.getOrUndefined(namespace),
        limit,
      });

      const result = yield* executeCode({ target, code });
      yield* printExecutionOutcome({
        target,
        connection: result.connection,
        outcome: result.outcome,
      });
    }),
).pipe(Command.withDescription("Search tools by natural-language query"));

const toolsSourcesCommand = Command.make(
  "sources",
  {
    query: Options.string("query").pipe(Options.optional),
    limit: Options.integer("limit").pipe(Options.withDefault(50)),
    baseUrl: serverBaseUrl,
    server: serverProfile,
    scope,
  },
  ({ query, limit, baseUrl, server, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const target = serverTargetFromOptions({ baseUrl, server });
      const code = buildListSourcesCode({
        query: Option.getOrUndefined(query),
        limit,
      });

      const result = yield* executeCode({ target, code });
      yield* printExecutionOutcome({
        target,
        connection: result.connection,
        outcome: result.outcome,
      });
    }),
).pipe(Command.withDescription("List configured sources and tool counts"));

const toolsDescribeCommand = Command.make(
  "describe",
  {
    path: Args.string("path"),
    baseUrl: serverBaseUrl,
    server: serverProfile,
    scope,
  },
  ({ path, baseUrl, server, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const target = serverTargetFromOptions({ baseUrl, server });
      const code = buildDescribeToolCode(path);
      const result = yield* executeCode({ target, code });
      yield* printExecutionOutcome({
        target,
        connection: result.connection,
        outcome: result.outcome,
      });
    }),
).pipe(Command.withDescription("Describe a tool's TypeScript and JSON schema"));

const toolsCommand = Command.make("tools").pipe(
  Command.withSubcommands([toolsSearchCommand, toolsSourcesCommand, toolsDescribeCommand] as const),
  Command.withDescription("Discover available tools and sources"),
);

const profileConnectionInput = (input: {
  readonly origin: string;
  readonly displayName: Option.Option<string>;
  readonly kind: Option.Option<"http" | "desktop-sidecar">;
}): ExecutorServerConnectionInput => {
  const selectedKind = Option.getOrUndefined(input.kind);
  const displayName = Option.getOrUndefined(input.displayName);
  return {
    kind: selectedKind ?? "http",
    origin: input.origin,
    ...(displayName ? { displayName } : {}),
  };
};

const printServerProfiles = () =>
  Effect.gen(function* () {
    const store = yield* readCliServerConnectionStore();
    if (store.profiles.length === 0) {
      console.log("No server profiles configured.");
      console.log(`Add one: ${cliPrefix} server add local ${DEFAULT_BASE_URL} --default`);
      return;
    }

    const rows = store.profiles.map((profile) => ({
      marker: profile.name === store.defaultProfile ? "*" : " ",
      name: profile.name,
      kind: profile.connection.kind,
      origin: profile.connection.origin,
      displayName: profile.connection.displayName,
      auth: profile.connection.auth ? "stored-auth" : "env-auth",
    }));
    const nameWidth = rows.reduce((max, row) => Math.max(max, row.name.length), 4);
    const kindWidth = rows.reduce((max, row) => Math.max(max, row.kind.length), 4);

    for (const row of rows) {
      console.log(
        `${row.marker} ${row.name.padEnd(nameWidth)}  ${row.kind.padEnd(kindWidth)}  ${row.origin}  ${row.displayName}  ${row.auth}`,
      );
    }
  });

const serverAddCommand = Command.make(
  "add",
  {
    name: Args.string("name"),
    origin: Args.string("origin"),
    displayName: Options.string("display-name").pipe(
      Options.optional,
      Options.withDescription("Display label for this server profile."),
    ),
    kind: Options.choice("kind", ["http", "desktop-sidecar"] as const).pipe(
      Options.optional,
      Options.withDescription("Server kind. Defaults to http."),
    ),
    makeDefault: Options.boolean("default").pipe(
      Options.withDefault(false),
      Options.withDescription("Make this profile the default server."),
    ),
  },
  ({ name, origin, displayName, kind, makeDefault }) =>
    Effect.gen(function* () {
      const profileName = validateCliServerConnectionProfileName(name);
      const store = yield* upsertCliServerConnectionProfile({
        name: profileName,
        connection: profileConnectionInput({ origin, displayName, kind }),
        makeDefault,
      });
      const profile = findCliServerConnectionProfile(store, profileName);
      if (!profile) return yield* Effect.fail(new Error(`Failed to save "${profileName}".`));
      console.log(`Saved server profile "${profile.name}" (${profile.connection.origin}).`);
      if (store.defaultProfile === profile.name) {
        console.log(`Default server profile: ${profile.name}`);
      }
    }),
).pipe(Command.withDescription("Add or update a named Executor server profile"));

const serverListCommand = Command.make("list", {}, () => printServerProfiles()).pipe(
  Command.withDescription("List configured Executor server profiles"),
);

const serverUseCommand = Command.make(
  "use",
  {
    name: Args.string("name"),
  },
  ({ name }) =>
    Effect.gen(function* () {
      const store = yield* setDefaultCliServerConnectionProfile(name);
      const profile = defaultCliServerConnectionProfile(store);
      if (!profile) return yield* Effect.fail(new Error(`No server profile named "${name}".`));
      console.log(`Default server profile: ${profile.name} (${profile.connection.origin}).`);
    }),
).pipe(Command.withDescription("Set the default Executor server profile"));

const serverRemoveCommand = Command.make(
  "remove",
  {
    name: Args.string("name"),
  },
  ({ name }) =>
    Effect.gen(function* () {
      const profileName = validateCliServerConnectionProfileName(name);
      const store = yield* readCliServerConnectionStore();
      const profile = findCliServerConnectionProfile(store, profileName);
      if (!profile) {
        return yield* Effect.fail(new Error(`No server profile named "${profileName}".`));
      }
      const nextStore = yield* removeCliServerConnectionProfile(profileName);
      console.log(`Removed server profile "${profileName}".`);
      if (nextStore.defaultProfile === null) {
        console.log("No default server profile is configured.");
      }
    }),
).pipe(Command.withDescription("Remove an Executor server profile"));

const serverCommand = Command.make("server").pipe(
  Command.withSubcommands([
    serverAddCommand,
    serverListCommand,
    serverUseCommand,
    serverRemoveCommand,
  ] as const),
  Command.withDescription("Manage named Executor server profiles"),
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
    baseUrl: daemonBaseUrlOption,
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
    baseUrl: daemonBaseUrlOption,
  },
  ({ baseUrl }) => stopDaemon(baseUrl),
).pipe(Command.withDescription("Stop the local daemon"));

const daemonRestartCommand = Command.make(
  "restart",
  {
    baseUrl: daemonBaseUrlOption,
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

const mcpCommand = Command.make(
  "mcp",
  {
    scope,
    elicitationMode: Options.choice("elicitation-mode", ["browser", "model"] as const)
      .pipe(Options.withDefault("model"))
      .pipe(
        Options.withDescription(
          "Choose the stdio approval flow: browser approval or a CLI resume tool exposed to the model.",
        ),
      ),
  },
  ({ scope, elicitationMode }) =>
    Effect.gen(function* () {
      applyScope(scope);
      yield* runStdioMcpSession({ elicitationMode });
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
    serverCommand,
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
