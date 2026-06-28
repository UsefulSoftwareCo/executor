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

const sentryDsn = process.env.EXECUTOR_SENTRY_DSN;
if (sentryDsn) {
  const Sentry = await import("@sentry/bun");
  Sentry.init({
    dsn: sentryDsn,
    release: process.env.EXECUTOR_SENTRY_RELEASE,
    environment: process.env.EXECUTOR_SENTRY_ENVIRONMENT ?? "production",
    tracesSampleRate: 0,
    initialScope: {
      tags: {
        process: "daemon",
        platform: process.platform,
        arch: process.arch,
        ...(process.env.EXECUTOR_RUN_ID ? { runId: process.env.EXECUTOR_RUN_ID } : {}),
      },
    },
  });
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
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { ExecutorApi, checkForUpdate } from "@executor-js/api";
import {
  getExecutorServerAuthorizationHeader,
  normalizeExecutorServerConnection,
  normalizeExecutorServerOrigin,
  type ExecutorLocalServerKind,
  type ExecutorLocalServerManifest,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
} from "@executor-js/sdk/shared";
import {
  decodeAccessTokenClaims,
  discoverCliLogin,
  openBrowser,
  pollForDeviceTokens,
  refreshDeviceTokens,
  requestDeviceCode,
} from "./device-login";
import {
  startServer,
  rotateLocalAuthToken,
  localAuthTokenPath,
  findDataDirOwnershipHeld,
  type ServerInstance,
  type StartServerOptions,
} from "@executor-js/local";
import { fetchIntegrations } from "./integrations";
import {
  buildDaemonSpawnSpec,
  chooseDaemonPort,
  canAutoStartLocalDaemonForHost,
  isExecutorServerReachable,
  isDevCliEntrypoint,
  parseDaemonBaseUrl,
  planServiceInstall,
  spawnDetached,
  terminateSpawnedDetachedProcess,
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
  readLocalServerManifest,
  removeLocalServerManifestIfOwnedBy,
  resolveExecutorDataDir,
  writeLocalServerManifest,
} from "./local-server-manifest";
import {
  DEFAULT_SERVICE_PORT,
  getServiceBackend,
  SERVICE_LABEL,
  stopWindowsExecutorListenersOnPort,
} from "./service";
import {
  defaultCliServerConnectionProfile,
  findCliServerConnectionProfile,
  readCliServerConnectionStore,
  removeCliServerConnectionProfile,
  setDefaultCliServerConnectionProfile,
  upsertCliServerConnectionProfile,
  validateCliServerConnectionProfileName,
  type CliServerConnectionStore,
} from "./server-profile";
import {
  buildResumeContentTemplate,
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
  resolveToolInvocation,
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
/** Canonical public docs (Mintlify), matching the web shell's DEFAULT_DOCS_URL. */
const DOCS_URL = "https://executor.sh/docs";
const DEFAULT_BASE_URL = `http://localhost:${DEFAULT_PORT}`;
const DESKTOP_SIDECAR_READY_SENTINEL = "EXECUTOR_READY";
const DESKTOP_SIDECAR_ATTACHED_SENTINEL = "EXECUTOR_ATTACHED";
const DAEMON_BOOT_TIMEOUT_MS = 15_000;
const DAEMON_BOOT_POLL_MS = 150;
const DAEMON_STOP_TIMEOUT_MS = 10_000;
const SERVICE_BOOT_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const shouldEmitDesktopSidecarSentinels = (): boolean => process.env.EXECUTOR_CLIENT === "desktop";

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

const isServerReachable = (baseUrl: string): Effect.Effect<boolean> =>
  isExecutorServerReachable({ baseUrl });

const readReachableLocalServerHint = (): Effect.Effect<
  ExecutorLocalServerManifest | null,
  never,
  FileSystem.FileSystem | PlatformPath.Path
> =>
  Effect.gen(function* () {
    const manifest = yield* readLocalServerManifest();
    if (!manifest) return null;

    if (yield* isServerReachable(manifest.connection.origin)) {
      return manifest;
    }

    if (!isPidAlive(manifest.pid)) {
      yield* removeLocalServerManifestIfOwnedBy({ pid: manifest.pid }).pipe(Effect.ignore);
      return null;
    }

    return null;
  });

const readActiveLocalServerManifest = readReachableLocalServerHint;

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

type LocalServerStartResult =
  | { readonly kind: "started"; readonly server: ServerInstance }
  | { readonly kind: "attached"; readonly manifest: ExecutorLocalServerManifest };

const attachToOwnedDataDirServerOrFail = (input: {
  readonly lockPath: string;
}): Effect.Effect<ExecutorLocalServerManifest, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const manifest = yield* readReachableLocalServerHint();
    if (manifest) return manifest;

    const path = yield* PlatformPath.Path;
    const dataDir = resolveExecutorDataDir(path);
    return yield* Effect.fail(
      new Error(
        [
          "Executor data directory is owned by another live process, but no reachable local server was advertised.",
          `Data directory: ${dataDir}`,
          `Ownership lock: ${input.lockPath}`,
          "Wait for the existing process to finish starting, or stop it and retry.",
        ].join("\n"),
      ),
    );
  });

const startServerOrAttachOwnedDataDir = (
  options: StartServerOptions,
): Effect.Effect<LocalServerStartResult, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.tryPromise({
    try: () => startServer(options),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((server) => ({ kind: "started" as const, server })),
    Effect.catch((cause) => {
      const ownership = findDataDirOwnershipHeld(cause);
      if (!ownership) return Effect.fail(toError(cause));
      return attachToOwnedDataDirServerOrFail({ lockPath: ownership.lockPath }).pipe(
        Effect.map((manifest) => ({ kind: "attached" as const, manifest })),
      );
    }),
  );

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
        client: process.env.EXECUTOR_CLIENT === "desktop" ? "desktop" : "cli",
        version: CLI_VERSION,
        executablePath: isDevMode ? (script ?? null) : process.execPath,
      },
    };
  });

// Friendly, intentionally racy fast-path: it reads the server.json hint to fail
// early with a helpful message when another local server is already up. It is
// NOT the ownership gate — the DB ownership lock inside startServer
// (openOwnedLocalDatabase) is. A stale/missing manifest only costs the nice
// message; the kernel lock still refuses a second owner.
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

const takeOverActiveLocalServer = (input?: {
  readonly onlyKind?: ExecutorLocalServerKind;
}): Effect.Effect<
  ExecutorLocalServerManifest | null,
  Error,
  FileSystem.FileSystem | PlatformPath.Path
> =>
  Effect.gen(function* () {
    const manifest = yield* readLocalServerManifest();
    if (!manifest) return null;
    if (input?.onlyKind && manifest.kind !== input.onlyKind) return null;

    if (!isPidAlive(manifest.pid) || manifest.pid === process.pid) {
      yield* removeLocalServerManifestIfOwnedBy({ pid: manifest.pid }).pipe(Effect.ignore);
      return null;
    }

    yield* terminatePid(manifest.pid).pipe(Effect.ignore);
    const stopped = yield* waitForUnreachable({
      check: isServerReachable(manifest.connection.origin),
      timeoutMs: DAEMON_STOP_TIMEOUT_MS,
      intervalMs: DAEMON_BOOT_POLL_MS,
    });
    if (!stopped) {
      return yield* Effect.fail(
        new Error(
          [
            `The existing Executor ${manifest.kind} at ${manifest.connection.origin} (pid ${manifest.pid}) did not stop within ${DAEMON_STOP_TIMEOUT_MS / 1000}s.`,
            "Stop it manually and re-run.",
          ].join("\n"),
        ),
      );
    }

    yield* removeLocalServerManifestIfOwnedBy({ pid: manifest.pid }).pipe(Effect.ignore);
    return manifest;
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

const waitForDaemonStartupTarget = (input: {
  readonly requestedBaseUrl: string;
}): Effect.Effect<string | null, never, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    let readyBaseUrl: string | null = null;
    let requestedFallbackBaseUrl: string | null = null;
    const ready = yield* waitForReachable({
      check: Effect.gen(function* () {
        // Prefer the manifest: it is written after the server has opened the
        // owned DB and started serving, and it carries the bearer token the next
        // API call needs. A bare health response on the requested URL is only a
        // last-ditch fallback; keep polling for the manifest so tool calls do
        // not race ahead without auth.
        const manifest = yield* readReachableLocalServerHint();
        if (manifest) {
          readyBaseUrl = manifest.connection.origin;
          return true;
        }

        if (yield* isServerReachable(input.requestedBaseUrl)) {
          requestedFallbackBaseUrl = input.requestedBaseUrl;
        }

        return false;
      }),
      timeoutMs: DAEMON_BOOT_TIMEOUT_MS,
      intervalMs: DAEMON_BOOT_POLL_MS,
    });

    return ready ? readyBaseUrl : requestedFallbackBaseUrl;
  });

// Serialize daemon startup behind a filesystem lock so concurrent CLI invocations don't
// each spawn their own daemon. The post-lock pointer recheck catches the case where
// another invocation finished bootstrapping while we were waiting for the lock.
// A storm of concurrent cold starts should elect ONE owner with the rest
// attaching, never N-1 hard failures. Each attempt either wins the per-scope
// start lock and spawns the daemon, or waits for the current holder's manifest.
// Re-acquiring after a wait timeout is what recovers the one window the wait
// alone cannot: acquireDaemonStartLock reclaims a STALE lock at acquisition, so
// a holder that took the lock then died BEFORE spawning (no daemon, no manifest)
// is recovered when a loser loops back and re-acquires.
const MAX_DAEMON_ELECTION_ATTEMPTS = 3;

/** The stable message acquireDaemonStartLock fails with on genuine lock
 * contention. Only this should be treated as "another process is electing";
 * any other failure (e.g. an unwritable data dir) must propagate, not masquerade
 * as a race the caller should wait out. */
const isStartLockContention = (error: Error): boolean =>
  error.message.includes("Another daemon startup is already in progress");

const spawnDaemonAsLockHolder = (input: {
  host: string;
  scopeId: string;
  preferredPort: number;
  allowedHosts: ReadonlyArray<string>;
}): Effect.Effect<string, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
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
    const child = yield* spawnDetached({
      command: spec.command,
      args: spec.args,
      env: process.env,
    });

    const readyBaseUrl = yield* waitForDaemonStartupTarget({ requestedBaseUrl: startBaseUrl });

    if (!readyBaseUrl) {
      yield* terminateSpawnedDetachedProcess(child).pipe(Effect.ignore);
      return yield* Effect.fail(
        new Error(
          [
            `Daemon did not become reachable at ${startBaseUrl} and no reachable local server manifest appeared within ${DAEMON_BOOT_TIMEOUT_MS}ms.`,
            `Run in foreground to inspect logs: ${cliPrefix} daemon run --foreground --port ${selectedPort} --hostname ${input.host}`,
          ].join("\n"),
        ),
      );
    }

    return readyBaseUrl;
  });

const spawnAndWaitForDaemon = (input: {
  host: string;
  scopeId: string;
  preferredPort: number;
  allowedHosts: ReadonlyArray<string>;
}): Effect.Effect<string, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const requestedBaseUrl = daemonBaseUrl(input.host, input.preferredPort);

    for (let attempt = 1; attempt <= MAX_DAEMON_ELECTION_ATTEMPTS; attempt++) {
      const acquired = yield* acquireDaemonStartLock({
        hostname: input.host,
        scopeId: input.scopeId,
      }).pipe(
        Effect.map((lock) => ({ held: true as const, lock })),
        Effect.catch((error) =>
          isStartLockContention(error)
            ? Effect.succeed({ held: false as const, lock: null })
            : Effect.fail(error),
        ),
      );

      if (acquired.held) {
        const lock = acquired.lock;
        return yield* spawnDaemonAsLockHolder(input).pipe(
          Effect.ensuring(releaseDaemonStartLock(lock).pipe(Effect.ignore)),
        );
      }

      // Lost the lock: wait for the current holder to advertise a manifest.
      const ready = yield* waitForDaemonStartupTarget({ requestedBaseUrl });
      if (ready) return ready;
      // Timed out with no manifest. The holder may have died mid-startup; loop to
      // re-acquire, which reclaims its now-stale lock.
    }

    return yield* Effect.fail(
      new Error(
        [
          `Could not elect or attach to a local Executor daemon after ${MAX_DAEMON_ELECTION_ATTEMPTS} attempts.`,
          "A daemon startup may be stuck. Stop any partial daemon and retry, or run it in the foreground:",
          `${cliPrefix} daemon run --foreground --port ${input.preferredPort} --hostname ${input.host}`,
        ].join("\n"),
      ),
    );
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

// Refresh an `oauth` (device-login) credential a minute before it expires, so
// `executor call` against a hosted server keeps working long after the browser
// login. The refreshed tokens are written back to the originating profile.
const OAUTH_REFRESH_SKEW_SECONDS = 60;

const profileNameFromKey = (key: string): string | null =>
  key.startsWith("profile:") ? key.slice("profile:".length) : null;

const refreshOAuthConnection = (
  connection: ExecutorServerConnection,
): Effect.Effect<ExecutorServerConnection, never, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const auth = connection.auth;
    if (!auth || auth.kind !== "oauth") return connection;
    const now = Math.floor(Date.now() / 1000);
    if (auth.expiresAt && auth.expiresAt - now > OAUTH_REFRESH_SKEW_SECONDS) return connection;
    // Destructure so the narrowed string types survive into the deferred
    // `tryPromise` callback (where TS would otherwise re-widen the fields).
    const { refreshToken, tokenEndpoint, clientId } = auth;
    if (!refreshToken || !tokenEndpoint || !clientId) return connection;

    const refreshed = yield* Effect.tryPromise({
      try: () => refreshDeviceTokens({ tokenEndpoint, clientId, refreshToken }),
      catch: toError,
      // On a failed refresh, keep the existing token and let the eventual 401
      // surface, better than blocking the command on a transient hiccup.
    }).pipe(Effect.option);
    if (Option.isNone(refreshed)) return connection;

    const next = refreshed.value;
    const nextConnection = normalizeExecutorServerConnection({
      ...connection,
      auth: {
        kind: "oauth",
        accessToken: next.accessToken,
        refreshToken: next.refreshToken ?? refreshToken,
        ...(next.expiresAt ? { expiresAt: next.expiresAt } : {}),
        tokenEndpoint,
        clientId,
      },
    });

    const profileName = profileNameFromKey(connection.key);
    if (profileName) {
      yield* upsertCliServerConnectionProfile({
        name: profileName,
        connection: nextConnection,
        makeDefault: false,
      }).pipe(Effect.ignore);
    }
    return nextConnection;
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

    const requested = yield* refreshOAuthConnection(decision.connection);
    if (decision.kind === "use-active") return requested;

    if (!canAutoStartCliServerConnection(requested)) {
      // An authenticated remote connection (oauth device-login, bearer key, or
      // basic password): use it directly. The /api/health liveness probe is only
      // a gate for the local auto-start decision and isn't necessarily exposed
      // by hosted servers, the real API call surfaces any connectivity/auth
      // error with proper context.
      if (requested.auth) return requested;
      if (yield* isServerReachable(requested.origin)) {
        return requested;
      }
      return yield* Effect.fail(
        new Error(
          [
            `Executor server is not reachable at ${requested.origin}.`,
            "For hosted Executor, set EXECUTOR_API_KEY to a bearer API key.",
            "For local or desktop servers, set EXECUTOR_AUTH_TOKEN to the server's bearer token.",
          ].join("\n"),
        ),
      );
    }

    const daemonUrl = yield* ensureDaemon(requested.origin);
    // The daemon we just ensured published a manifest carrying its bearer token
    // (minted into auth.json). Prefer that authed connection — otherwise the
    // next API call hits the now-gated server with no credential and 401s.
    const started = yield* readActiveLocalServerManifest().pipe(Effect.orElseSucceed(() => null));
    const daemonOrigin = normalizeExecutorServerConnection({ origin: daemonUrl }).origin;
    const startedOrigin = started
      ? normalizeExecutorServerConnection({ origin: started.connection.origin }).origin
      : null;
    if (started && startedOrigin === daemonOrigin) {
      return started.connection;
    }
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
}) =>
  Effect.gen(function* () {
    const displayHost =
      input.hostname === "0.0.0.0" || input.hostname === "::" ? "localhost" : input.hostname;
    const restoreWebBaseUrl = installDefaultExecutorWebBaseUrl(
      `http://${displayHost}:${input.port}`,
    );

    try {
      // No process-level startup lock: the DB ownership lock acquired inside
      // startServer (openOwnedLocalDatabase) is the real gate. server.json is
      // only an attach hint, and assertNoOtherActiveLocalServer is a friendly
      // fast-path that may race without being unsafe.
      yield* assertNoOtherActiveLocalServer();
      const startResult = yield* startServerOrAttachOwnedDataDir({
        port: input.port,
        hostname: input.hostname,
        allowedHosts: input.allowedHosts,
        authToken: input.authToken,
        embeddedWebUI,
      });
      if (startResult.kind === "attached") {
        console.log(`Executor is already running at ${startResult.manifest.connection.origin}.`);
        return;
      }
      const server = startResult.server;
      const baseUrl = `http://${displayHost}:${server.port}`;
      yield* publishLocalServerManifest({
        kind: "foreground",
        connection: normalizeExecutorServerConnection({
          kind: "http",
          origin: baseUrl,
          displayName: "CLI web",
          auth: { kind: "bearer", token: server.authToken },
        }),
      });

      try {
        console.log(`Executor is ready.`);
        console.log(`Open:    ${baseUrl}/?_token=${server.authToken}`);
        console.log(`Web:     ${baseUrl}`);
        console.log(`MCP:     ${baseUrl}/mcp`);
        console.log(`OpenAPI: ${baseUrl}/api/docs`);
        if (input.hostname !== "127.0.0.1" && input.hostname !== "localhost") {
          console.log(
            `\n⚠  Listening on ${input.hostname}. Executor runs arbitrary commands — only expose on trusted networks.`,
          );
          if (input.allowedHosts.length > 0) {
            console.log(`   Extra CORS origins: ${input.allowedHosts.join(", ")}`);
          }
        }

        // Best-effort upgrade nudge. `checkForUpdate` never throws and bounds
        // its own registry fetch, so a slow or offline registry just yields no
        // notice rather than stalling the prompt. Quiet when up to date or when
        // EXECUTOR_DISABLE_UPDATE_CHECK is set.
        const update = yield* Effect.promise(() => checkForUpdate(CLI_VERSION));
        if (update.updateAvailable && update.latestVersion) {
          console.log(`\nUpdate available: ${update.currentVersion} -> ${update.latestVersion}`);
          console.log(`Run ${update.command} to update.`);
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
}) =>
  Effect.gen(function* () {
    const daemonHost = canonicalDaemonHost(input.hostname);
    const restoreWebBaseUrl = installDefaultExecutorWebBaseUrl(
      daemonBaseUrl(daemonHost, input.port),
    );
    const scopeId = currentDaemonScopeId();

    try {
      // No process-level startup lock: the DB ownership lock acquired inside
      // startServer (openOwnedLocalDatabase) is the real gate. server.json and
      // the daemon pointer are attach/dedup hints, and the checks below are
      // friendly fast-paths that may race without being unsafe.

      // A supervised daemon (launchd/systemd) is the OS-guaranteed singleton
      // — kickstart -k kills the old instance before starting the new — so any
      // server.json from a previous boot is stale. Reclaim it rather than
      // refusing: across a reboot the recorded pid may have been recycled by
      // an unrelated process, which would otherwise make the "is one already
      // running?" check treat it as alive-but-unreachable, refuse to start,
      // and crash-loop under KeepAlive. (Found by a real reboot test with
      // integration data in the DB.)
      if (process.env.EXECUTOR_SUPERVISED) {
        yield* takeOverActiveLocalServer().pipe(Effect.ignore);
      } else {
        yield* assertNoOtherActiveLocalServer();
      }

      const existing = yield* readDaemonPointer({ hostname: daemonHost, scopeId });

      if (existing) {
        const existingUrl = daemonBaseUrl(existing.hostname, existing.port);
        if (isPidAlive(existing.pid) && (yield* isServerReachable(existingUrl))) {
          if (process.env.EXECUTOR_SUPERVISED) {
            yield* terminatePid(existing.pid).pipe(Effect.ignore);
            const stopped = yield* waitForUnreachable({
              check: isServerReachable(existingUrl),
              timeoutMs: DAEMON_STOP_TIMEOUT_MS,
              intervalMs: DAEMON_BOOT_POLL_MS,
            });
            if (!stopped) {
              return yield* Effect.fail(
                new Error(
                  [
                    `The existing daemon for scope ${scopeId} at ${existingUrl} (pid ${existing.pid}) did not stop within ${DAEMON_STOP_TIMEOUT_MS / 1000}s.`,
                    "Stop it manually and re-run.",
                  ].join("\n"),
                ),
              );
            }
          } else {
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
        }
        yield* cleanupPointer({ hostname: existing.hostname, scopeId, port: existing.port });
      }

      const startResult = yield* startServerOrAttachOwnedDataDir({
        port: input.port,
        hostname: input.hostname,
        allowedHosts: input.allowedHosts,
        authToken: input.authToken,
        embeddedWebUI,
      });
      if (startResult.kind === "attached") {
        if (shouldEmitDesktopSidecarSentinels()) {
          console.log(DESKTOP_SIDECAR_ATTACHED_SENTINEL);
        }
        console.log(`Daemon already running at ${startResult.manifest.connection.origin}.`);
        return;
      }
      const server = startResult.server;
      const daemonPort = server.port;
      const token = randomUUID();
      const daemonUrl = daemonBaseUrl(daemonHost, daemonPort);
      yield* publishLocalServerManifest({
        kind: "cli-daemon",
        connection: normalizeExecutorServerConnection({
          kind: "http",
          origin: daemonUrl,
          displayName: "CLI daemon",
          auth: { kind: "bearer", token: server.authToken },
        }),
      });

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

        if (shouldEmitDesktopSidecarSentinels()) {
          console.log(`${DESKTOP_SIDECAR_READY_SENTINEL}:${daemonPort}`);
        }
        console.log(`Daemon ready on http://${daemonHost}:${daemonPort}`);

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
// Stdio MCP session: a pure stdio <-> HTTP bridge to the owning local daemon.
// ---------------------------------------------------------------------------

const mcpUrlForActiveLocalServer = (
  connection: ExecutorServerConnection,
  elicitationMode: "browser" | "model",
): URL => {
  const url = new URL("/mcp", connection.origin);
  if (elicitationMode === "browser") {
    url.searchParams.set("elicitation_mode", "browser");
  }
  return url;
};

/**
 * Bridge a stdio MCP client to a local server's HTTP `/mcp` endpoint. `executor
 * mcp` owns NO database: it forwards JSON-RPC between the client's stdin/stdout
 * and the daemon over Streamable HTTP. That keeps any number of MCP clients (plus
 * the web UI and the desktop app) attached to the single owning daemon at once,
 * and means a transient MCP client exiting never takes the server down. Resolves
 * when stdin closes or the daemon connection drops; close is best-effort.
 */
const runMcpHttpBridge = async (input: {
  readonly manifest: ExecutorLocalServerManifest;
  readonly elicitationMode: "browser" | "model";
}): Promise<void> => {
  const stdio = new StdioServerTransport();
  const authorization = getExecutorServerAuthorizationHeader(input.manifest.connection);
  const http = new StreamableHTTPClientTransport(
    mcpUrlForActiveLocalServer(input.manifest.connection, input.elicitationMode),
    authorization ? { requestInit: { headers: { Authorization: authorization } } } : undefined,
  );

  let finished = false;
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let resolveExit: () => void = () => {};
  const waitForExit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const finish = () => {
    if (finished) return;
    finished = true;
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    process.stdin.off("end", shutdown);
    process.stdin.off("close", shutdown);
    resolveExit();
  };

  const closeBoth = (): Promise<void> => {
    if (!closePromise) {
      closing = true;
      closePromise = Promise.allSettled([stdio.close(), http.close()]).then(() => undefined);
    }
    return closePromise;
  };

  function shutdown() {
    finish();
    void closeBoth();
  }

  const isAbortDuringClose = (error: Error): boolean =>
    error.name === "AbortError" || error.message.toLowerCase().includes("aborted");

  const reportError = (context: string, cause: unknown) => {
    const error = toError(cause);
    if (closing && isAbortDuringClose(error)) return;
    console.error(`Executor MCP bridge ${context}: ${error.message}`);
  };

  const forwardMessage =
    (send: (message: JSONRPCMessage) => Promise<void>, context: string) =>
    (message: JSONRPCMessage) => {
      void send(message).then(undefined, (cause: unknown) => {
        reportError(context, cause);
        shutdown();
      });
    };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);

  stdio.onclose = shutdown;
  http.onclose = shutdown;
  stdio.onerror = (error) => reportError("stdio transport error", error);
  http.onerror = (error) => reportError("daemon transport error", error);
  stdio.onmessage = forwardMessage((message) => http.send(message), "failed to send to daemon");
  http.onmessage = forwardMessage((message) => stdio.send(message), "failed to send to stdio");

  try {
    await http.start();
    await stdio.start();
    await waitForExit;
  } finally {
    finish();
    await closeBoth();
  }
};

const runStdioMcpSession = (input: { readonly elicitationMode: "browser" | "model" }) =>
  Effect.gen(function* () {
    // `executor mcp` never owns the local database. If a local server is already
    // running, bridge this stdio client to it; otherwise ensure a durable
    // background daemon is up and bridge to that. ensureDaemon is the race-safe
    // election: concurrent cold starts elect one owner and the losers wait for
    // its manifest (waitForDaemonStartupTarget) rather than failing. Bridging
    // means many MCP clients, the web UI, and the desktop app share one owner,
    // and that owner's lifetime is never tied to a transient MCP client.
    const active = yield* readActiveLocalServerManifest();
    if (active) {
      yield* Effect.promise(() =>
        runMcpHttpBridge({ manifest: active, elicitationMode: input.elicitationMode }),
      );
      return;
    }

    // No reachable owner yet: ensure one. If we lose the election (another
    // process became owner first), ensureDaemon may fail, but the winner's
    // manifest is then reachable, so re-read it and bridge to that instead.
    const elected = yield* ensureDaemon(DEFAULT_BASE_URL).pipe(
      Effect.flatMap(() => readActiveLocalServerManifest()),
      Effect.catch((error) =>
        readActiveLocalServerManifest().pipe(
          Effect.flatMap((manifest) => (manifest ? Effect.succeed(manifest) : Effect.fail(error))),
        ),
      ),
    );
    if (!elected) {
      return yield* Effect.fail(
        new Error("The local Executor daemon started but did not advertise a reachable manifest."),
      );
    }
    yield* Effect.promise(() =>
      runMcpHttpBridge({ manifest: elected, elicitationMode: input.elicitationMode }),
    );
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

const serverRotateTokenCommand = Command.make("rotate-token", {}, () =>
  Effect.gen(function* () {
    const token = rotateLocalAuthToken();
    console.log("Rotated the local server bearer token.");
    console.log(`Stored in ${localAuthTokenPath()}`);

    const manifest = yield* readLocalServerManifest();
    if (manifest && isPidAlive(manifest.pid)) {
      console.log(
        `\n⚠  A local server is running at ${manifest.connection.origin} (pid ${manifest.pid}).`,
      );
      console.log("   Restart it to apply the new token.");
    }
    console.log(`\nNew token: ${token}`);
    console.log("Re-run your MCP client connect command with the new token.");
  }),
).pipe(Command.withDescription("Rotate the local server's bearer token (auth.json)"));

const serverCommand = Command.make("server").pipe(
  Command.withSubcommands([
    serverAddCommand,
    serverListCommand,
    serverUseCommand,
    serverRemoveCommand,
    serverRotateTokenCommand,
  ] as const),
  Command.withDescription("Manage named Executor server profiles"),
);

const loginHostLabel = (origin: string): string => {
  try {
    const host = new URL(origin).hostname;
    const first = host.split(".")[0];
    return first && first.length > 0 ? first : host;
  } catch {
    return "server";
  }
};

const sanitizeProfileName = (raw: string): string => {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "server";
};

// The (origin, user, org) a stored oauth profile authenticates as, lets us
// recognize a re-login to the SAME account (update in place) versus a
// different account on the same host (needs its own profile).
const oauthAccountIdentity = (connection: ExecutorServerConnection): string | null => {
  const auth = connection.auth;
  if (!auth || auth.kind !== "oauth") return null;
  const claims = decodeAccessTokenClaims(auth.accessToken);
  const sub = typeof claims?.sub === "string" ? claims.sub : undefined;
  const org = typeof claims?.org_id === "string" ? claims.org_id : undefined;
  return sub && org ? `${connection.origin}|${sub}|${org}` : null;
};

// Name a login's profile by the ACCOUNT it authenticates (email, falling back
// to user id), not the hostname, so two accounts on the same server get
// distinct profiles instead of clobbering each other (the way opencode keys
// accounts by email/url). A re-login to the same account reuses its profile.
const chooseLoginProfileName = (
  store: CliServerConnectionStore,
  account: {
    readonly origin: string;
    readonly sub?: string;
    readonly org?: string;
    readonly email?: string;
  },
): string => {
  const identity =
    account.sub && account.org ? `${account.origin}|${account.sub}|${account.org}` : null;
  if (identity) {
    const existing = store.profiles.find((p) => oauthAccountIdentity(p.connection) === identity);
    if (existing) return existing.name;
  }
  const base = sanitizeProfileName(account.email ?? account.sub ?? loginHostLabel(account.origin));
  if (!store.profiles.some((p) => p.name === base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!store.profiles.some((p) => p.name === candidate)) return candidate;
  }
};

// Resolve which server a login/logout targets: an existing profile (--server
// or the default) or a bare origin (--base-url). The profile name is decided
// later, from the authenticated account.
const resolveLoginOrigin = (input: {
  readonly baseUrl: Option.Option<string>;
  readonly server: Option.Option<string>;
}): Effect.Effect<
  { readonly origin: string; readonly profile: ReturnType<typeof findCliServerConnectionProfile> },
  Error,
  FileSystem.FileSystem | PlatformPath.Path
> =>
  Effect.gen(function* () {
    const baseUrl = Option.getOrUndefined(input.baseUrl);
    const serverName = Option.getOrUndefined(input.server);
    if (baseUrl && serverName) {
      return yield* Effect.fail(new Error("Use either --server or --base-url, not both."));
    }
    if (serverName) {
      const store = yield* readCliServerConnectionStore();
      const profile = findCliServerConnectionProfile(store, serverName);
      if (!profile)
        return yield* Effect.fail(new Error(`No server profile named "${serverName}".`));
      return { origin: profile.connection.origin, profile };
    }
    if (baseUrl) {
      return { origin: normalizeExecutorServerOrigin(baseUrl), profile: null };
    }
    const store = yield* readCliServerConnectionStore();
    const profile = defaultCliServerConnectionProfile(store);
    if (profile) return { origin: profile.connection.origin, profile };
    return yield* Effect.fail(
      new Error(
        "No server to log in to. Pass --base-url <https://your-host> or --server <profile>.",
      ),
    );
  });

const loginNameOption = Options.string("name").pipe(
  Options.optional,
  Options.withDescription("Profile name to save the login under (defaults to your account)."),
);

const noBrowserOption = Options.boolean("no-browser").pipe(
  Options.withDefault(false),
  Options.withDescription("Print the verification URL instead of opening a browser."),
);

const loginCommand = Command.make(
  "login",
  {
    baseUrl: serverBaseUrl,
    server: serverProfile,
    name: loginNameOption,
    noBrowser: noBrowserOption,
  },
  ({ baseUrl, server, name, noBrowser }) =>
    Effect.gen(function* () {
      const target = yield* resolveLoginOrigin({ baseUrl, server });
      const explicitName = Option.getOrUndefined(name);
      const discovery = yield* Effect.tryPromise({
        try: () => discoverCliLogin(target.origin),
        catch: toError,
      });
      const grant = yield* Effect.tryPromise({
        try: () => requestDeviceCode(discovery),
        catch: toError,
      });
      const verifyUrl = grant.verificationUriComplete ?? grant.verificationUri;
      console.log("");
      console.log(`To sign in, open:  ${verifyUrl}`);
      console.log(`and confirm the code:  ${grant.userCode}`);
      console.log("");
      if (!noBrowser) openBrowser(verifyUrl);
      console.log("Waiting for you to approve in the browser...");
      const tokens = yield* Effect.tryPromise({
        try: () => pollForDeviceTokens(discovery, grant),
        catch: toError,
      });

      const claims = decodeAccessTokenClaims(tokens.accessToken);
      const sub = typeof claims?.sub === "string" ? claims.sub : undefined;
      const org =
        tokens.organizationId ?? (typeof claims?.org_id === "string" ? claims.org_id : undefined);
      const email = tokens.email;

      // Name by account so a different account on the same host doesn't clobber
      // an existing login; --server / the default profile / --name pin it.
      const store = yield* readCliServerConnectionStore();
      const profileName = explicitName
        ? validateCliServerConnectionProfileName(explicitName)
        : target.profile
          ? target.profile.name
          : chooseLoginProfileName(store, { origin: target.origin, sub, org, email });

      yield* upsertCliServerConnectionProfile({
        name: profileName,
        connection: {
          kind: "http",
          origin: target.origin,
          ...(email ? { displayName: email } : {}),
          auth: {
            kind: "oauth",
            accessToken: tokens.accessToken,
            ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
            ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
            tokenEndpoint: discovery.tokenEndpoint,
            clientId: discovery.clientId,
          },
        },
        makeDefault: true,
      });

      console.log("");
      console.log(`Logged in to ${target.origin} (profile "${profileName}", now the default).`);
      if (email) console.log(`Account: ${email}`);
      if (org) console.log(`Organization: ${org}`);
      else if (sub) console.log(`User: ${sub}`);
    }),
).pipe(Command.withDescription("Sign in to a hosted Executor server in the browser (device flow)"));

const logoutCommand = Command.make(
  "logout",
  { baseUrl: serverBaseUrl, server: serverProfile },
  ({ baseUrl, server }) =>
    Effect.gen(function* () {
      const target = yield* resolveLoginOrigin({ baseUrl, server });
      const store = yield* readCliServerConnectionStore();
      // --server / default give the profile directly; --base-url matches by origin.
      const profile =
        target.profile ?? store.profiles.find((p) => p.connection.origin === target.origin) ?? null;
      if (!profile) {
        console.log(`No stored login for ${target.origin}.`);
        return;
      }
      if (!profile.connection.auth) {
        console.log(`Profile "${profile.name}" has no stored credentials.`);
        return;
      }
      yield* upsertCliServerConnectionProfile({
        name: profile.name,
        connection: {
          kind: profile.connection.kind,
          origin: profile.connection.origin,
          displayName: profile.connection.displayName,
        },
        makeDefault: store.defaultProfile === profile.name,
      });
      console.log(
        `Logged out of ${profile.connection.origin} (cleared credentials for "${profile.name}").`,
      );
    }),
).pipe(Command.withDescription("Clear stored credentials for a server profile"));

const whoamiCommand = Command.make(
  "whoami",
  { baseUrl: serverBaseUrl, server: serverProfile },
  ({ baseUrl, server }) =>
    Effect.gen(function* () {
      const requested = yield* resolveRequestedExecutorServerConnection(
        serverTargetFromOptions({ baseUrl, server }),
      );
      const connection = yield* refreshOAuthConnection(requested.connection);
      const auth = connection.auth;
      console.log(`Server: ${connection.origin}`);
      if (!auth) {
        console.log("Not logged in (no stored credentials).");
        return;
      }
      if (auth.kind === "oauth") {
        const claims = decodeAccessTokenClaims(auth.accessToken);
        const sub = claims?.sub;
        const org = claims?.org_id;
        // The email lives on the profile's displayName (WorkOS access tokens
        // don't carry an email claim); the token carries sub + org_id.
        if (connection.displayName.includes("@")) console.log(`Account: ${connection.displayName}`);
        if (typeof sub === "string") console.log(`User: ${sub}`);
        if (typeof org === "string") console.log(`Organization: ${org}`);
        if (auth.expiresAt) {
          const remaining = auth.expiresAt - Math.floor(Date.now() / 1000);
          console.log(
            remaining > 0
              ? `Token valid for ~${Math.round(remaining / 60)} min.`
              : "Token expired (refreshes on next use).",
          );
        }
        return;
      }
      console.log(`Authenticated via ${auth.kind}.`);
    }),
).pipe(Command.withDescription("Show who you're signed in as on a server"));

const webCommand = Command.make(
  "web",
  {
    foreground: Options.boolean("foreground")
      .pipe(Options.withDefault(false))
      .pipe(
        Options.withDescription(
          "Run a temporary web server in this terminal. By default, web opens the installed background service.",
        ),
      ),
    port: Options.integer("port")
      .pipe(Options.withDefault(DEFAULT_PORT))
      .pipe(Options.withDescription("Port for the temporary --foreground server.")),
    hostname: Options.string("hostname")
      .pipe(Options.withDefault("127.0.0.1"))
      .pipe(
        Options.withDescription(
          "Bind address for the temporary --foreground server. Use 0.0.0.0 to listen on all interfaces.",
        ),
      ),
    allowedHost: Options.string("allowed-host")
      .pipe(Options.atLeast(0))
      .pipe(
        Options.withDescription(
          "For --foreground, grant an extra origin cross-origin (CORS) access (repeatable). Not needed to reach the server from another host — the bearer token is the gate; localhost is always allowed.",
        ),
      ),
    authToken: Options.string("auth-token")
      .pipe(Options.optional)
      .pipe(
        Options.withDescription(
          "For --foreground, override the bearer token. Defaults to the stable token in auth.json.",
        ),
      ),
    scope,
  },
  ({ foreground, port, scope, hostname, allowedHost, authToken }) =>
    Effect.gen(function* () {
      if (!foreground) {
        // `--scope` can ONLY be honored by a foreground server we boot here.
        // Without `--foreground` we just open whatever background service is
        // already running, which uses the scope IT was started with — so a
        // `--scope` here would be silently ignored and the user could land on a
        // different workspace ("where did my config go?"). Say so loudly and
        // point at the flag that actually applies it.
        if (Option.isSome(scope)) {
          console.warn(
            `Ignoring --scope ${scope.value}: it only applies with --foreground. ` +
              `The running web app uses the scope it was started with. ` +
              `Run \`executor web --foreground --scope ${scope.value}\` to serve that workspace.`,
          );
        }
        yield* openRunningLocalWebApp();
        return;
      }
      applyScope(scope);
      yield* runForegroundSession({
        port,
        hostname,
        allowedHosts: allowedHost,
        authToken: Option.getOrUndefined(authToken),
      });
    }),
).pipe(Command.withDescription("Open the Executor web UI"));

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
          "Grant an extra origin cross-origin (CORS) access (repeatable). Not needed to reach the server from another host — the bearer token is the gate; localhost is always allowed.",
        ),
      ),
    authToken: Options.string("auth-token")
      .pipe(Options.optional)
      .pipe(
        Options.withDescription(
          "Override the bearer token. Defaults to the stable token in auth.json.",
        ),
      ),
    foreground: Options.boolean("foreground")
      .pipe(Options.withDefault(false))
      .pipe(
        Options.withDescription(
          "Run the daemon in this process instead of detaching. Useful for inspecting logs.",
        ),
      ),
    scope,
  },
  ({ port, scope, hostname, allowedHost, authToken, foreground }) =>
    Effect.gen(function* () {
      applyScope(scope);
      if (foreground) {
        // The foreground daemon is the form OS service managers run. Its bearer
        // comes from --auth-token, else the stable token in auth.json (loaded by
        // startServer from EXECUTOR_DATA_DIR) — the supervised unit carries no
        // secret, so the daemon and its clients share the one auth.json token.
        yield* runDaemonSession({
          port,
          hostname,
          allowedHosts: allowedHost,
          authToken: Option.getOrUndefined(authToken),
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
// Service — register the daemon with the OS so it survives app-quit + restart
// ---------------------------------------------------------------------------

const supervisedServiceOrigin = (port: number): string => `http://127.0.0.1:${port}`;

const LOCAL_SERVICE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const originPort = (url: URL): string => url.port || (url.protocol === "https:" ? "443" : "80");

const sameServerOrigin = (left: string, right: string): boolean => {
  const leftUrl = new URL(normalizeExecutorServerConnection({ origin: left }).origin);
  const rightUrl = new URL(normalizeExecutorServerConnection({ origin: right }).origin);
  if (leftUrl.toString() === rightUrl.toString()) return true;
  return (
    leftUrl.protocol === rightUrl.protocol &&
    originPort(leftUrl) === originPort(rightUrl) &&
    LOCAL_SERVICE_HOSTS.has(leftUrl.hostname.toLowerCase()) &&
    LOCAL_SERVICE_HOSTS.has(rightUrl.hostname.toLowerCase())
  );
};

const hasReachableCliDaemonManifest = (input: {
  readonly origin: string;
  readonly version: string;
}): Effect.Effect<boolean, never, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const manifest = yield* readActiveLocalServerManifest().pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (!manifest || manifest.kind !== "cli-daemon") return false;
    if (!sameServerOrigin(manifest.connection.origin, input.origin)) return false;
    if (manifest.owner.version !== input.version) return false;
    return yield* isServerReachable(manifest.connection.origin);
  });

const clearUnmanifestedWindowsExecutorListener = (input: {
  readonly port: number;
  readonly origin: string;
}): Effect.Effect<void, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const active = yield* readActiveLocalServerManifest().pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (active && sameServerOrigin(active.connection.origin, input.origin)) return;
    if (!(yield* isServerReachable(input.origin))) return;

    const stoppedPids = yield* stopWindowsExecutorListenersOnPort(input.port);
    const stopped = yield* waitForUnreachable({
      check: isServerReachable(input.origin),
      timeoutMs: DAEMON_STOP_TIMEOUT_MS,
      intervalMs: DAEMON_BOOT_POLL_MS,
    });
    if (stopped) return;

    return yield* Effect.fail(
      new Error(
        [
          `Executor is already reachable at ${input.origin}, but no live server manifest exists for it.`,
          stoppedPids.length > 0
            ? `Tried to stop orphaned Executor pid(s): ${stoppedPids.join(", ")}.`
            : `No orphaned executor.exe listener could be stopped on port ${input.port}.`,
          "Stop the process using that port and re-run the install.",
        ].join("\n"),
      ),
    );
  });

const portFromOrigin = (origin: string): number | null => {
  try {
    const url = new URL(origin);
    if (!url.port) return url.protocol === "https:" ? 443 : 80;
    const port = Number.parseInt(url.port, 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
};

const servicePortOption = () =>
  Options.integer("port")
    .pipe(Options.withDefault(DEFAULT_SERVICE_PORT))
    .pipe(Options.withDescription("Port the supervised daemon binds (loopback only)."));

const serviceManagerName = (platform: ReturnType<typeof getServiceBackend>["platform"]): string => {
  switch (platform) {
    case "darwin":
      return "launchd";
    case "linux":
      return "systemd --user";
    case "win32":
      return "Windows Task Scheduler";
    case "unsupported":
      return "manual setup";
  }
};

const installService = (port: number, commandName: string) =>
  Effect.gen(function* () {
    const command = `${cliPrefix} ${commandName}`;
    if (isDevMode) {
      return yield* Effect.fail(
        new Error(
          [
            `\`${command}\` requires the compiled \`executor\` binary so the OS can run it directly.`,
            `In a dev checkout, run \`${cliPrefix} daemon run --foreground\` instead.`,
          ].join("\n"),
        ),
      );
    }

    const backend = getServiceBackend();
    if (!backend.automated) {
      // Unsupported platforms surface their manual steps via the install error.
      yield* backend.install({ executablePath: process.execPath, port, version: CLI_VERSION });
      return;
    }

    const status = yield* backend.status();
    const active = yield* readActiveLocalServerManifest().pipe(Effect.orElseSucceed(() => null));
    const plan = planServiceInstall({
      registered: status.registered,
      running: status.running,
      activeKind: active?.kind ?? null,
      activePid: active?.pid ?? null,
      servicePid: status.pid,
      activeVersion: active?.owner.version ?? null,
      activeExecutablePath: active?.owner.executablePath ?? null,
      activePort: active ? portFromOrigin(active.connection.origin) : null,
      requestedPort: port,
      currentVersion: CLI_VERSION,
      currentExecutablePath: process.execPath,
    });

    if (plan === "noop") {
      const where = active ? ` at ${active.connection.origin} (pid ${active.pid})` : "";
      console.log(`Executor background service is already running${where}.`);
      console.log(`Open it in your browser, already signed in, with:  ${cliPrefix} web`);
      return;
    }

    if (
      plan === "takeover-then-install" ||
      (backend.platform === "win32" && plan === "reinstall")
    ) {
      const replaced = yield* takeOverActiveLocalServer();
      if (replaced) {
        console.log(
          `Replacing running Executor ${replaced.kind} at ${replaced.connection.origin} (pid ${replaced.pid})...`,
        );
      }
    }

    const path = yield* PlatformPath.Path;
    const dataDir = resolveExecutorDataDir(path);
    const origin = supervisedServiceOrigin(port);
    console.log("Installing Executor as a background service...");
    console.log(`Service manager: ${serviceManagerName(backend.platform)}`);
    console.log(`Web UI:          ${origin}`);
    console.log(`Data directory:  ${dataDir}`);
    console.log(`Logs:            ${path.join(dataDir, "logs")}`);
    console.log("");
    console.log("Writing the service definition and starting Executor...");

    if (backend.platform === "win32") {
      yield* clearUnmanifestedWindowsExecutorListener({ port, origin });
    }

    // The unit carries no secret: the supervised daemon mints/loads its bearer
    // from auth.json (under EXECUTOR_DATA_DIR) on first boot, and clients read
    // the same file — so reachability is the credential-free /api/health probe.
    yield* backend.install({ executablePath: process.execPath, port, version: CLI_VERSION });

    console.log(`Waiting for Executor to publish its service manifest at ${origin}...`);
    const reachable = yield* waitForReachable({
      check: hasReachableCliDaemonManifest({
        origin,
        version: CLI_VERSION,
      }),
      timeoutMs: SERVICE_BOOT_TIMEOUT_MS,
      intervalMs: DAEMON_BOOT_POLL_MS,
    });
    if (!reachable) {
      return yield* Effect.fail(
        new Error(
          [
            `Installed ${SERVICE_LABEL} but it did not publish a reachable server manifest for ${origin} within ${SERVICE_BOOT_TIMEOUT_MS / 1000}s.`,
            `Check ~/.executor/logs/daemon.error.log and \`${cliPrefix} service status\`.`,
          ].join("\n"),
        ),
      );
    }

    console.log(`Executor is now running as a background service at ${origin}.`);
    console.log("It keeps serving after you quit the app and restarts on login.");
    console.log(`Open it in your browser, already signed in, with:  ${cliPrefix} web`);
  });

const serviceInstallCommand = Command.make(
  "install",
  {
    port: servicePortOption(),
  },
  ({ port }) => installService(port, "service install"),
).pipe(
  Command.withDescription("Install and start Executor as an OS-supervised background service"),
);

const serviceUninstallCommand = Command.make("uninstall", {}, () =>
  Effect.gen(function* () {
    const backend = getServiceBackend();
    const activeBefore = yield* readActiveLocalServerManifest().pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    const servicePort = activeBefore
      ? (portFromOrigin(activeBefore.connection.origin) ?? DEFAULT_SERVICE_PORT)
      : DEFAULT_SERVICE_PORT;
    const status = backend.automated
      ? yield* backend.status().pipe(Effect.catchCause(() => Effect.succeed(null)))
      : null;
    yield* backend.uninstall();
    const stopped = yield* takeOverActiveLocalServer({ onlyKind: "cli-daemon" });
    if (stopped) {
      console.log(
        `Stopped running Executor daemon at ${stopped.connection.origin} (pid ${stopped.pid}).`,
      );
    } else if (backend.platform === "win32" && status?.registered) {
      const stoppedPids = yield* stopWindowsExecutorListenersOnPort(servicePort);
      if (stoppedPids.length > 0) {
        console.log(`Stopped orphaned Executor daemon pid(s): ${stoppedPids.join(", ")}.`);
      }
    }
    console.log("Executor background service uninstalled.");
  }),
).pipe(Command.withDescription("Stop and remove the OS-supervised background service"));

const serviceStatusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const backend = getServiceBackend();
    const status = yield* backend.status();
    // Tolerate a registered-but-unreachable manifest here — status shouldn't throw.
    const active = yield* readActiveLocalServerManifest().pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    console.log(`Platform:   ${status.platform}`);
    console.log(`Registered: ${status.registered ? "yes" : "no"}`);
    console.log(
      `Running:    ${status.running ? "yes" : "no"}${status.pid ? ` (pid ${status.pid})` : ""}`,
    );
    if (active) {
      console.log(`Serving:    ${active.connection.origin} (${active.kind}, pid ${active.pid})`);
      // Version drift: the running daemon was launched by the binary the unit
      // points at. If that differs from this CLI, an upgrade left the unit
      // pointing at an older binary — reinstall to repoint + restart.
      if (active.owner.version && active.owner.version !== CLI_VERSION) {
        console.log(
          `Drift:      running ${active.owner.version}, current ${CLI_VERSION} — run \`${cliPrefix} service install\` to upgrade.`,
        );
      }
    }
    for (const line of status.detail) console.log(line);
  }),
).pipe(Command.withDescription("Show the OS-supervised service status"));

const serviceRestartCommand = Command.make("restart", {}, () =>
  Effect.gen(function* () {
    const backend = getServiceBackend();
    yield* backend.restart();
    console.log("Executor background service restarted.");
  }),
).pipe(Command.withDescription("Restart the OS-supervised background service"));

const serviceCommand = Command.make("service").pipe(
  Command.withSubcommands([
    serviceInstallCommand,
    serviceUninstallCommand,
    serviceStatusCommand,
    serviceRestartCommand,
  ] as const),
  Command.withDescription("Manage the OS-supervised background service"),
);

const installCommand = Command.make(
  "install",
  {
    port: servicePortOption(),
  },
  ({ port }) => installService(port, "install"),
).pipe(
  Command.withDescription("Install and start Executor as an OS-supervised background service"),
);

// ---------------------------------------------------------------------------
// Root command
// ---------------------------------------------------------------------------

/**
 * Open a URL in the user's default browser. Best-effort: if the platform opener
 * isn't found (e.g. headless Linux without xdg-open) we swallow the error — the
 * URL is always printed first, so the user can copy it manually.
 */
const openInBrowser = (url: string): Effect.Effect<void> =>
  Effect.sync(() => {
    openBrowser(url);
  });

const printNoRunningLocalWebApp = (): void => {
  console.log("Executor is not running.");
  console.log("");
  console.log("Install and start the background service:");
  console.log(`  ${cliPrefix} install`);
  console.log("");
  console.log("Then open the web UI:");
  console.log(`  ${cliPrefix} web`);
  console.log("");
  console.log("For a temporary foreground server:");
  console.log(`  ${cliPrefix} web --foreground`);
};

const openRunningLocalWebApp = (): Effect.Effect<
  void,
  never,
  FileSystem.FileSystem | PlatformPath.Path
> =>
  Effect.gen(function* () {
    const manifest = yield* readActiveLocalServerManifest().pipe(Effect.orElseSucceed(() => null));
    if (!manifest) {
      printNoRunningLocalWebApp();
      return;
    }
    const { origin, auth } = manifest.connection;
    const token = auth?.kind === "bearer" ? auth.token : undefined;
    const url = token ? `${origin}/?_token=${token}` : origin;
    console.log(`Opening ${url}`);
    yield* openInBrowser(url);
  });

/**
 * `executor open` — the friendly way back in. Reads the running local server's
 * manifest and opens the browser straight to its `?_token=` URL, so the user
 * never has to copy a bearer token out of a terminal or auth.json by hand.
 */
const openCommand = Command.make("open", {}, () => openRunningLocalWebApp()).pipe(
  Command.withDescription("Open the running Executor web app in your browser, already signed in"),
);

/**
 * `executor docs` — open the documentation in the browser. The URL is printed
 * first so it stays usable on headless machines where no opener is available.
 */
const docsCommand = Command.make("docs", {}, () =>
  Effect.gen(function* () {
    console.log(`Opening ${DOCS_URL}`);
    yield* openInBrowser(DOCS_URL);
  }),
).pipe(Command.withDescription("Open the Executor documentation in your browser"));

const root = Command.make("executor").pipe(
  Command.withSubcommands([
    callCommand,
    resumeCommand,
    toolsCommand,
    installCommand,
    loginCommand,
    logoutCommand,
    whoamiCommand,
    serverCommand,
    webCommand,
    daemonCommand,
    serviceCommand,
    mcpCommand,
    openCommand,
    docsCommand,
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
