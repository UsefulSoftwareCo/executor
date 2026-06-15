import { spawn } from "node:child_process";
import { createServer } from "node:net";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedDaemonBaseUrl {
  readonly hostname: string;
  readonly port: number;
}

export interface DaemonSpawnSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface ExecutorServerReachabilityInput {
  readonly baseUrl: string;
}

type ProbeServer = ReturnType<typeof createServer> & {
  removeAllListeners: () => void;
  once: (event: "error" | "listening", listener: (...args: unknown[]) => void) => void;
};

// ---------------------------------------------------------------------------
// Base URL parsing
// ---------------------------------------------------------------------------

export const parseDaemonBaseUrl = (baseUrl: string, defaultPort: number): ParsedDaemonBaseUrl => {
  const parsed = new URL(baseUrl);

  if (parsed.protocol !== "http:") {
    throw new Error(`Only http:// base URLs are supported for daemon auto-start: ${baseUrl}`);
  }

  const port = Number(parsed.port) || defaultPort;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid daemon port in base URL: ${baseUrl}`);
  }

  return {
    hostname: parsed.hostname || "localhost",
    port,
  };
};

// ---------------------------------------------------------------------------
// Local-host checks
// ---------------------------------------------------------------------------

const LOCAL_DAEMON_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const canAutoStartLocalDaemonForHost = (hostname: string): boolean =>
  LOCAL_DAEMON_HOSTNAMES.has(hostname.toLowerCase());

/**
 * Bun's compiled-binary embedded filesystem root, drive-rooted on Windows
 * (`B:\~BUN\root\...`, argv normalized to `B:/~BUN/root/...`). Anchored to a
 * drive prefix so a dev checkout that merely *contains* a `~BUN` directory
 * isn't misread as a compiled binary.
 */
const WINDOWS_BUNFS_ENTRYPOINT = /^[a-z]:\/~BUN\//i;

/**
 * Whether the process is running from the dev source (`bun run src/main.ts`)
 * rather than a compiled single-file binary. A compiled binary runs from Bun's
 * embedded filesystem, whose entrypoint is `/$bunfs/root/main.js` on Unix but
 * `B:\~BUN\root\main.js` (argv like `B:/~BUN/root/main.js`) on Windows — match
 * BOTH. Missing the Windows form made a real `executor.exe` look like a dev
 * checkout, so `service install` refused on Windows. (Found by a real EC2
 * Windows test.)
 */
export const isDevCliEntrypoint = (scriptPath: string | undefined): boolean => {
  if (!scriptPath) return false;
  const normalized = scriptPath.replaceAll("\\", "/");
  if (normalized.startsWith("/$bunfs/") || WINDOWS_BUNFS_ENTRYPOINT.test(normalized)) return false;
  return normalized.endsWith(".ts") || normalized.endsWith(".js");
};

export const isExecutorServerReachable = (
  input: ExecutorServerReachabilityInput,
): Effect.Effect<boolean> =>
  Effect.tryPromise(async () => {
    // The unauthenticated liveness probe — never forwards a credential, so a
    // misconfigured base URL can't leak the bearer token to a third-party host.
    const url = new URL("/api/health", input.baseUrl);
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const body = await response.text();
    return response.ok && body.trim() === "ok";
  }).pipe(Effect.catchCause(() => Effect.succeed(false)));

// ---------------------------------------------------------------------------
// Process spec
// ---------------------------------------------------------------------------

export const buildDaemonSpawnSpec = (input: {
  readonly port: number;
  readonly hostname: string;
  readonly isDevMode: boolean;
  readonly scriptPath: string | undefined;
  readonly executablePath: string;
  readonly allowedHosts?: ReadonlyArray<string>;
}): DaemonSpawnSpec => {
  const daemonArgs = [
    "daemon",
    "run",
    "--port",
    String(input.port),
    "--hostname",
    input.hostname,
    "--foreground",
    ...(input.allowedHosts ?? []).flatMap((h) => ["--allowed-host", h]),
  ];

  if (input.isDevMode) {
    if (!input.scriptPath) {
      throw new Error("Cannot auto-start daemon in dev mode without a CLI script path");
    }
    return {
      command: "bun",
      args: ["run", input.scriptPath, ...daemonArgs],
    };
  }

  return {
    command: input.executablePath,
    args: daemonArgs,
  };
};

// ---------------------------------------------------------------------------
// Spawn + wait
// ---------------------------------------------------------------------------

export const spawnDetached = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined>;
}): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      const child = spawn(input.command, [...input.args], {
        detached: true,
        stdio: "ignore",
        env: input.env,
      });
      child.unref();
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Failed to spawn daemon process: ${String(cause)}`),
  });

const waitForCondition = <E, R>(input: {
  readonly check: Effect.Effect<boolean, E, R>;
  readonly expected: boolean;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}): Effect.Effect<boolean, E, R> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    while (true) {
      const reachable = yield* input.check;
      if (reachable === input.expected) return true;

      const now = yield* Clock.currentTimeMillis;
      if (now - startedAt >= input.timeoutMs) return false;

      yield* Effect.sleep(input.intervalMs);
    }
  });

export const waitForReachable = <E, R>(input: {
  readonly check: Effect.Effect<boolean, E, R>;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}): Effect.Effect<boolean, E, R> =>
  waitForCondition({
    check: input.check,
    expected: true,
    timeoutMs: input.timeoutMs,
    intervalMs: input.intervalMs,
  });

export const waitForUnreachable = <E, R>(input: {
  readonly check: Effect.Effect<boolean, E, R>;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}): Effect.Effect<boolean, E, R> =>
  waitForCondition({
    check: input.check,
    expected: false,
    timeoutMs: input.timeoutMs,
    intervalMs: input.intervalMs,
  });

const toProbeHost = (hostname: string): string => {
  const normalized = hostname.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "0.0.0.0") {
    return "127.0.0.1";
  }
  return hostname;
};

const isPortAvailable = (input: {
  hostname: string;
  port: number;
}): Effect.Effect<boolean, Error> =>
  Effect.tryPromise({
    try: () =>
      new Promise<boolean>((resolve) => {
        const server = createServer() as ProbeServer;
        const cleanup = () => {
          if (typeof server.removeAllListeners === "function") {
            server.removeAllListeners();
          }
        };

        server.once("error", () => {
          cleanup();
          resolve(false);
        });

        server.once("listening", () => {
          cleanup();
          server.close(() => resolve(true));
        });

        server.listen({ port: input.port, host: toProbeHost(input.hostname) });
      }),
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Failed probing port availability: ${String(cause)}`),
  });

const pickEphemeralPort = (hostname: string): Effect.Effect<number, Error> =>
  Effect.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) => {
        const server = createServer() as ProbeServer;

        server.once("error", (error: unknown) => {
          reject(error);
        });

        server.once("listening", () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;
          server.close(() => resolve(port));
        });

        server.listen({ port: 0, host: toProbeHost(hostname) });
      }),
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Failed selecting ephemeral port: ${String(cause)}`),
  });

export const chooseDaemonPort = (input: {
  preferredPort: number;
  hostname: string;
}): Effect.Effect<number, Error> =>
  Effect.gen(function* () {
    const preferredAvailable = yield* isPortAvailable({
      hostname: input.hostname,
      port: input.preferredPort,
    });
    if (preferredAvailable) return input.preferredPort;

    const fallbackPort = yield* pickEphemeralPort(input.hostname);
    if (!Number.isFinite(fallbackPort) || fallbackPort <= 0 || fallbackPort > 65535) {
      return yield* Effect.fail(
        new Error(`Could not find an available daemon port for host ${input.hostname}`),
      );
    }
    return fallbackPort;
  });

// ---------------------------------------------------------------------------
// Service-install planning (pure)
// ---------------------------------------------------------------------------

export type ServiceInstallPlan = "noop" | "reinstall" | "takeover-then-install";

export const planServiceInstall = (input: {
  readonly registered: boolean;
  readonly running: boolean;
  readonly activeKind: "cli-daemon" | "desktop-sidecar" | "foreground" | null;
  readonly activePid?: number | null;
  readonly servicePid?: number | null;
  readonly activeVersion: string | null;
  readonly activeExecutablePath?: string | null;
  readonly activePort: number | null;
  readonly requestedPort: number;
  readonly currentVersion: string;
  readonly currentExecutablePath?: string | null;
}): ServiceInstallPlan => {
  if (input.activeKind !== null && input.activeKind !== "cli-daemon") {
    return "takeover-then-install";
  }

  if (input.registered && input.running) {
    if (
      input.activeKind === "cli-daemon" &&
      input.activePid !== undefined &&
      input.activePid !== null &&
      input.servicePid !== undefined &&
      input.servicePid !== null &&
      input.activePid !== input.servicePid
    ) {
      return "takeover-then-install";
    }

    const executableMatches =
      !input.activeExecutablePath ||
      !input.currentExecutablePath ||
      input.activeExecutablePath === input.currentExecutablePath;
    return input.activeVersion === input.currentVersion &&
      input.activePort === input.requestedPort &&
      executableMatches
      ? "noop"
      : "reinstall";
  }

  return "takeover-then-install";
};
