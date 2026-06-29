import { execFile } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as Effect from "effect/Effect";

import { resolveExecutorDataDir } from "./local-server-manifest";

// ---------------------------------------------------------------------------
// OS service backends for the supervised Executor daemon.
//
// The long-lived gateway must outlive the GUI app and survive machine restarts.
// That means the OS service manager — not a foreground process — owns its
// lifecycle: launchd on macOS, systemd --user on Linux, Task Scheduler on
// Windows. Each backend registers the SAME running contract: spawn
// `<executor> daemon run --foreground --port <p>`, bind loopback, write
// `server.json`, and get restarted on crash but not on a clean stop.
//
// macOS (launchd), Linux (systemd --user + lingering), and Windows (Task
// Scheduler S4U/AtStartup) are all reboot-survival verified in real VMs.
// ---------------------------------------------------------------------------

export const SERVICE_LABEL = "sh.executor.daemon";

/**
 * The supervised service binds this port by default. It matches the desktop
 * connect-card port (4789, not the `executor daemon run` default of 4788) so
 * existing desktop MCP-client configs keep resolving. The exact value is
 * low-stakes: clients discover the live port from `server.json`.
 */
export const DEFAULT_SERVICE_PORT = 4789;

export interface ServiceDescriptor {
  /** Absolute path to the `executor` binary the service should run. */
  readonly executablePath: string;
  readonly port: number;
  /** Installing CLI version, baked in for drift detection on upgrade. */
  readonly version: string;
}

// No secret is part of the descriptor: the supervised daemon mints/loads its
// bearer token from the 0600 `auth.json` (under EXECUTOR_DATA_DIR) on start, and
// clients read the same file. Keeping the secret out of the plist/unit means
// `launchctl print`/`list` and `systemctl cat` never expose it.

export type ServicePlatform = "darwin" | "linux" | "win32" | "unsupported";

export interface ServiceStatus {
  readonly platform: ServicePlatform;
  /** The OS manager has a unit/plist/task on disk for the service. */
  readonly registered: boolean;
  /** The OS manager reports the service currently loaded/active. */
  readonly running: boolean;
  readonly pid: number | null;
  /** Extra human-readable lines (e.g. manual steps on unsupported platforms). */
  readonly detail: ReadonlyArray<string>;
}

export interface ServiceBackend {
  readonly platform: ServicePlatform;
  /** True when this backend actually drives the OS manager (vs. printing steps). */
  readonly automated: boolean;
  readonly install: (
    descriptor: ServiceDescriptor,
  ) => Effect.Effect<void, Error | PlatformError, FileSystem.FileSystem | Path.Path>;
  readonly uninstall: () => Effect.Effect<
    void,
    Error | PlatformError,
    FileSystem.FileSystem | Path.Path
  >;
  readonly status: () => Effect.Effect<
    ServiceStatus,
    Error | PlatformError,
    FileSystem.FileSystem | Path.Path
  >;
  readonly restart: () => Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path>;
}

// ---------------------------------------------------------------------------
// Process helper — run an OS command and capture (stdout, stderr, exit code).
// Resolves on a non-zero exit so callers can branch; fails only when the
// command itself cannot be spawned (e.g. launchctl missing).
// ---------------------------------------------------------------------------

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const runCommand = (
  cmd: string,
  args: ReadonlyArray<string>,
  env?: Record<string, string | undefined>,
): Effect.Effect<CommandResult, Error> =>
  Effect.callback<CommandResult, Error>((resume) => {
    const options = env
      ? { encoding: "utf8" as const, env: { ...process.env, ...env } }
      : { encoding: "utf8" as const };
    execFile(cmd, [...args], options, (error, stdout, stderr) => {
      // A string `code` (ENOENT etc.) means the command could not be spawned.
      if (error && typeof (error as { code?: unknown }).code === "string") {
        resume(
          Effect.fail(new Error(`Failed to run \`${cmd}\`: ${(error as { code: string }).code}`)),
        );
        return;
      }
      const code =
        error && typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 0;
      resume(Effect.succeed({ stdout: stdout ?? "", stderr: stderr ?? "", code }));
    });
  });

const currentUid = (): number => {
  const getuid = (process as { getuid?: () => number }).getuid;
  if (typeof getuid === "function") return getuid.call(process);
  return userInfo().uid;
};

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

// ---------------------------------------------------------------------------
// Shared service environment + program args
// ---------------------------------------------------------------------------

const serviceProgramArguments = (descriptor: ServiceDescriptor): ReadonlyArray<string> => [
  descriptor.executablePath,
  "daemon",
  "run",
  "--foreground",
  "--port",
  String(descriptor.port),
  "--hostname",
  "127.0.0.1",
];

const serviceEnvironment = (
  descriptor: ServiceDescriptor,
  dataDir: string,
): Record<string, string> => {
  const passThroughKeys = [
    "EXECUTOR_CLIENT",
    "EXECUTOR_SENTRY_DSN",
    "EXECUTOR_SENTRY_RELEASE",
    "EXECUTOR_SENTRY_ENVIRONMENT",
    "EXECUTOR_RUN_ID",
  ] as const;
  const passThrough = Object.fromEntries(
    passThroughKeys.flatMap((key) => {
      const value = process.env[key];
      return value ? [[key, value] as const] : [];
    }),
  );

  return {
    // Marks the process as OS-supervised so the daemon resolves its bearer token
    // from the durable 0600 auth.json (the secret is never in the unit itself).
    EXECUTOR_SUPERVISED: "1",
    // Pin the data/scope dirs explicitly: launchd/systemd give a minimal
    // environment and we never want the daemon to fall back to a different home
    // or cwd than the user's singleton local service.
    EXECUTOR_DATA_DIR: dataDir,
    EXECUTOR_SCOPE_DIR: process.env.EXECUTOR_SCOPE_DIR ?? dataDir,
    // Stamp the installing version so `service status` can flag drift after an
    // upgrade where the unit still points at an older binary path.
    EXECUTOR_SERVICE_VERSION: descriptor.version,
    // A launchd/systemd unit starts with a bare PATH — without the user's PATH
    // the daemon can't find pyenv/nvm/volta/Homebrew tools that integrations may
    // shell out to. `service install` runs from the user's shell, so its own
    // PATH is the right one to bake in. (Reference: opencode shell-env capture.)
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...passThrough,
  };
};

// ---------------------------------------------------------------------------
// macOS — launchd LaunchAgent (fully built)
// ---------------------------------------------------------------------------

const launchAgentsDir = (path: Path.Path): string =>
  path.join(homedir(), "Library", "LaunchAgents");

const launchdPlistPath = (path: Path.Path): string =>
  path.join(launchAgentsDir(path), `${SERVICE_LABEL}.plist`);

const serviceLogDir = (path: Path.Path): string => path.join(resolveExecutorDataDir(path), "logs");

export interface LaunchdPlistOptions {
  readonly label: string;
  readonly programArguments: ReadonlyArray<string>;
  readonly environment: Record<string, string>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly workingDirectory: string;
}

/**
 * Render a user LaunchAgent plist. Pure (snapshot-tested). KeepAlive uses
 * `SuccessfulExit=false` so launchd restarts the daemon on a crash/non-zero
 * exit but leaves it stopped after a clean `bootout` (which sends SIGTERM →
 * the daemon exits 0). RunAtLoad starts it on login; ProcessType=Background
 * keeps it off the foreground scheduler.
 */
export const generateLaunchdPlist = (options: LaunchdPlistOptions): string => {
  const programArgs = options.programArguments
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  const envEntries = Object.entries(options.environment)
    .map(
      ([key, value]) =>
        `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(options.workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(options.stderrPath)}</string>
</dict>
</plist>
`;
};

const parseLaunchctlPid = (printOutput: string): number | null => {
  const match = printOutput.match(/\bpid\s*=\s*(\d+)/);
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

const makeLaunchdBackend = (): ServiceBackend => {
  const serviceTarget = (uid: number): string => `gui/${uid}/${SERVICE_LABEL}`;

  return {
    platform: "darwin",
    automated: true,
    install: (descriptor) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const uid = currentUid();
        const dataDir = resolveExecutorDataDir(path);
        const logs = serviceLogDir(path);

        yield* fs.makeDirectory(launchAgentsDir(path), { recursive: true });
        yield* fs.makeDirectory(logs, { recursive: true });

        const plist = generateLaunchdPlist({
          label: SERVICE_LABEL,
          programArguments: serviceProgramArguments(descriptor),
          environment: serviceEnvironment(descriptor, dataDir),
          stdoutPath: path.join(logs, "daemon.log"),
          stderrPath: path.join(logs, "daemon.error.log"),
          workingDirectory: dataDir,
        });
        const plistFile = launchdPlistPath(path);
        // 0600: the plist is owner-only. It carries no secret — the daemon reads
        // the bearer from auth.json at boot — but stays tight regardless.
        yield* fs.writeFileString(plistFile, plist, { mode: 0o600 });

        // Re-bootstrap cleanly: a stale registration from a prior install would
        // make `bootstrap` fail with "service already loaded". `service
        // uninstall` also records the label as disabled in launchd's override
        // database; clear that before bootstrapping or a reinstall can fail with
        // launchctl's generic "Bootstrap failed: 5" error.
        yield* runCommand("launchctl", ["bootout", serviceTarget(uid)]).pipe(Effect.ignore);
        yield* runCommand("launchctl", ["enable", serviceTarget(uid)]).pipe(Effect.ignore);
        const bootstrap = yield* runCommand("launchctl", ["bootstrap", `gui/${uid}`, plistFile]);
        if (bootstrap.code !== 0) {
          return yield* Effect.fail(
            new Error(
              `launchctl bootstrap failed (exit ${bootstrap.code}): ${bootstrap.stderr.trim() || bootstrap.stdout.trim()}`,
            ),
          );
        }
      }),
    uninstall: () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const uid = currentUid();
        yield* runCommand("launchctl", ["bootout", serviceTarget(uid)]).pipe(Effect.ignore);
        yield* runCommand("launchctl", ["disable", serviceTarget(uid)]).pipe(Effect.ignore);
        yield* fs.remove(launchdPlistPath(path), { force: true });
      }),
    status: () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const uid = currentUid();
        const registered = yield* fs.exists(launchdPlistPath(path));
        const print = yield* runCommand("launchctl", ["print", serviceTarget(uid)]);
        const running = print.code === 0;
        return {
          platform: "darwin" as const,
          registered,
          running,
          pid: running ? parseLaunchctlPid(print.stdout) : null,
          detail: [],
        };
      }),
    restart: () =>
      Effect.gen(function* () {
        const uid = currentUid();
        const result = yield* runCommand("launchctl", ["kickstart", "-k", serviceTarget(uid)]);
        if (result.code !== 0) {
          return yield* Effect.fail(
            new Error(
              `launchctl kickstart failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
            ),
          );
        }
      }),
  };
};

// ---------------------------------------------------------------------------
// Linux — systemd --user + lingering (reboot-survival verified in an Ubuntu VM)
// ---------------------------------------------------------------------------

const systemdUnitDir = (path: Path.Path): string =>
  path.join(homedir(), ".config", "systemd", "user");

const systemdUnitPath = (path: Path.Path): string =>
  path.join(systemdUnitDir(path), `${SERVICE_LABEL}.service`);

export interface SystemdUnitOptions {
  readonly execStart: ReadonlyArray<string>;
  readonly environment: Record<string, string>;
  readonly workingDirectory: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

const SYSTEMD_BARE_VALUE = /^[A-Za-z0-9_@%+=:,./-]+$/;

const systemdQuote = (value: string): string => {
  if (SYSTEMD_BARE_VALUE.test(value)) return value;
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return `"${escaped}"`;
};

/** Render a systemd --user unit. Pure (snapshot-tested). */
export const generateSystemdUnit = (options: SystemdUnitOptions): string => {
  const execStart = options.execStart.map(systemdQuote).join(" ");
  const env = Object.entries(options.environment)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=Executor supervised daemon
After=default.target

[Service]
Type=simple
ExecStart=${execStart}
${env}
WorkingDirectory=${systemdQuote(options.workingDirectory)}
StandardOutput=${systemdQuote(`append:${options.stdoutPath}`)}
StandardError=${systemdQuote(`append:${options.stderrPath}`)}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
`;
};

const makeSystemdBackend = (): ServiceBackend => {
  const unitName = `${SERVICE_LABEL}.service`;
  return {
    platform: "linux",
    automated: true,
    install: (descriptor) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataDir = resolveExecutorDataDir(path);
        const logs = serviceLogDir(path);
        yield* fs.makeDirectory(systemdUnitDir(path), { recursive: true });
        yield* fs.makeDirectory(logs, { recursive: true });
        const unit = generateSystemdUnit({
          execStart: serviceProgramArguments(descriptor),
          environment: serviceEnvironment(descriptor, dataDir),
          workingDirectory: dataDir,
          stdoutPath: path.join(logs, "daemon.log"),
          stderrPath: path.join(logs, "daemon.error.log"),
        });
        yield* fs.writeFileString(systemdUnitPath(path), unit, { mode: 0o600 });
        // `systemctl --user` needs XDG_RUNTIME_DIR to reach the user bus. Supply
        // it if the caller's environment lacks it (e.g. a non-login shell) so
        // install is robust regardless of how it was invoked.
        const username = userInfo().username;
        const sdEnv = {
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${currentUid()}`,
        };
        yield* runCommand("systemctl", ["--user", "daemon-reload"], sdEnv).pipe(Effect.ignore);
        const enable = yield* runCommand(
          "systemctl",
          ["--user", "enable", "--now", unitName],
          sdEnv,
        );
        if (enable.code !== 0) {
          return yield* Effect.fail(
            new Error(
              `systemctl --user enable failed (exit ${enable.code}): ${enable.stderr.trim()}`,
            ),
          );
        }
        // Enable lingering so the user manager — and this enabled service —
        // starts at BOOT, not just on login, so the daemon survives a reboot
        // unattended (verified in a real Ubuntu VM via loginctl). Best-effort:
        // if the platform needs privilege, the service still works for the
        // logged-in case and `service status` flags the missing linger.
        yield* runCommand("loginctl", ["enable-linger", username], sdEnv).pipe(Effect.ignore);
      }),
    uninstall: () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sdEnv = {
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${currentUid()}`,
        };
        yield* runCommand("systemctl", ["--user", "disable", "--now", unitName], sdEnv).pipe(
          Effect.ignore,
        );
        yield* fs.remove(systemdUnitPath(path), { force: true });
        yield* runCommand("systemctl", ["--user", "daemon-reload"], sdEnv).pipe(Effect.ignore);
        yield* runCommand("loginctl", ["disable-linger", userInfo().username], sdEnv).pipe(
          Effect.ignore,
        );
      }),
    status: () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sdEnv = {
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${currentUid()}`,
        };
        const registered = yield* fs.exists(systemdUnitPath(path));
        const active = yield* runCommand("systemctl", ["--user", "is-active", unitName], sdEnv);
        const running = active.stdout.trim() === "active";
        const linger = yield* runCommand("loginctl", [
          "show-user",
          userInfo().username,
          "-p",
          "Linger",
          "--value",
        ]);
        const lingerOn = linger.stdout.trim() === "yes";
        return {
          platform: "linux" as const,
          registered,
          running,
          pid: null,
          detail: lingerOn
            ? []
            : [
                "Lingering is off — the daemon won't start until you log in. Run `loginctl enable-linger`.",
              ],
        };
      }),
    restart: () =>
      Effect.gen(function* () {
        const sdEnv = {
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${currentUid()}`,
        };
        const result = yield* runCommand("systemctl", ["--user", "restart", unitName], sdEnv);
        if (result.code !== 0) {
          return yield* Effect.fail(
            new Error(
              `systemctl --user restart failed (exit ${result.code}): ${result.stderr.trim()}`,
            ),
          );
        }
      }),
  };
};

// ---------------------------------------------------------------------------
// Windows — Task Scheduler (S4U / AtStartup; reboot-survival verified)
// ---------------------------------------------------------------------------

/** Scheduled Task name registered for the supervised daemon. */
export const WINDOWS_TASK_NAME = "ExecutorDaemon";

/**
 * Make a value safe to embed in a cmd.exe `set "KEY=VALUE"` line. A literal `"`
 * would close the quoted argument early — in PATH (built from arbitrary
 * installer entries) that lets `& cmd &` fragments execute when Task Scheduler
 * runs the wrapper at boot, so strip them (a `"` is illegal in a Windows path
 * anyway). A literal `%` is re-expanded by cmd at run time against the boot
 * environment, silently diverging from the value captured at install; double it
 * so the daemon sees exactly what was captured.
 */
export const cmdSetValue = (value: string): string =>
  value.replaceAll('"', "").replaceAll("%", "%%");

/**
 * The batch wrapper the Scheduled Task executes. Task Scheduler has no field
 * for environment variables, so the supervised env (EXECUTOR_SUPERVISED, data
 * dir, version, PATH) is baked into the wrapper as `set` lines before it execs
 * the daemon. stdout/stderr append to the same log files the other backends
 * use. CRLF line endings keep it a well-formed `.cmd`.
 */
export const generateWindowsDaemonWrapper = (
  descriptor: ServiceDescriptor,
  dataDir: string,
  logDir: string,
): string => {
  const env = serviceEnvironment(descriptor, dataDir);
  const setLines = Object.entries(env).map(([key, value]) => `set "${key}=${cmdSetValue(value)}"`);
  const [exe, ...rest] = serviceProgramArguments(descriptor);
  const command = `"${exe}" ${rest.join(" ")} 1>> "${logDir}\\daemon.log" 2>> "${logDir}\\daemon.error.log"`;
  return ["@echo off", ...setLines, command, ""].join("\r\n");
};

/** Quote a value as a PowerShell single-quoted string literal. */
const psSingleQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * PowerShell that registers the daemon as a boot-triggered Scheduled Task.
 *
 * LogonType=S4U + AtStartup is the Windows equivalent of launchd RunAtLoad and
 * systemd lingering: the task runs the daemon AS THE USER, at boot, with no
 * stored password and no interactive logon — verified to survive a real reboot
 * with no login on a headless host. RestartCount/RestartInterval supply the
 * crash-restart half of the contract; ExecutionTimeLimit=0 means "never time
 * out a long-running task". Registering a boot task requires an elevated
 * (Administrator) shell.
 */
export const generateWindowsRegisterScript = (options: {
  readonly taskName: string;
  readonly wrapperPath: string;
  readonly userId: string;
}): string =>
  [
    `$action = New-ScheduledTaskAction -Execute ${psSingleQuote(options.wrapperPath)}`,
    `$trigger = New-ScheduledTaskTrigger -AtStartup`,
    `$principal = New-ScheduledTaskPrincipal -UserId ${psSingleQuote(options.userId)} -LogonType S4U -RunLevel Highest`,
    `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)`,
    `Register-ScheduledTask -TaskName ${psSingleQuote(options.taskName)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${psSingleQuote(options.taskName)}`,
  ].join("\n");

/**
 * Stop orphaned Windows `executor.exe` listeners on the service port. Task
 * Scheduler can report the task as stopped after terminating the `.cmd` action
 * while leaving the child `executor.exe` process bound to 4789. That process is
 * healthy enough to satisfy `/api/health`, but `executor web` cannot discover it
 * once its `server.json` is gone.
 */
export const generateWindowsStopExecutorListenersScript = (port: number): string =>
  [
    `$connections = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue)`,
    `$listenerPids = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)`,
    `foreach ($listenerPid in $listenerPids) {`,
    `  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction SilentlyContinue`,
    `  if ($null -eq $process) { continue }`,
    `  $pathName = if ($process.ExecutablePath) { [System.IO.Path]::GetFileName([string]$process.ExecutablePath) } else { '' }`,
    `  if ([string]$process.Name -ieq 'executor.exe' -or $pathName -ieq 'executor.exe') {`,
    `    Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue`,
    `    Write-Output ("STOPPED=" + $listenerPid)`,
    `  }`,
    `}`,
  ].join("\n");

/** Run a PowerShell script via -EncodedCommand (sidesteps all shell quoting). */
const runPowerShell = (script: string): Effect.Effect<CommandResult, Error> =>
  runCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);

export const stopWindowsExecutorListenersOnPort = (
  port: number,
): Effect.Effect<ReadonlyArray<number>, Error> =>
  Effect.gen(function* () {
    const result = yield* runPowerShell(generateWindowsStopExecutorListenersScript(port));
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      return yield* Effect.fail(
        new Error(`Failed to inspect Executor listeners on port ${port}: ${detail}`),
      );
    }
    return result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = /^STOPPED=(\d+)\s*$/.exec(line.trim());
      if (!match) return [];
      const pid = Number.parseInt(match[1], 10);
      return Number.isInteger(pid) && pid > 0 ? [pid] : [];
    });
  });

const makeWindowsBackend = (): ServiceBackend => ({
  platform: "win32",
  automated: true,
  install: (descriptor) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dataDir = resolveExecutorDataDir(path);
      const logs = serviceLogDir(path);
      const control = path.join(dataDir, "server-control");
      yield* fs.makeDirectory(logs, { recursive: true });
      yield* fs.makeDirectory(control, { recursive: true });

      const wrapperPath = path.join(control, "run-daemon.cmd");
      yield* fs.writeFileString(
        wrapperPath,
        generateWindowsDaemonWrapper(descriptor, dataDir, logs),
      );

      const result = yield* runPowerShell(
        generateWindowsRegisterScript({
          taskName: WINDOWS_TASK_NAME,
          wrapperPath,
          userId: userInfo().username,
        }),
      );
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        const hint = /denied|0x80070005|administrator|elevat/i.test(detail)
          ? " Run `executor service install` from an Administrator PowerShell."
          : "";
        return yield* Effect.fail(
          new Error(`Register-ScheduledTask failed (exit ${result.code}): ${detail}.${hint}`),
        );
      }
    }),
  uninstall: () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Tolerate "task not found" (idempotent uninstall), but don't hide a
      // failure to even spawn PowerShell — that would leave the task registered
      // while we report success.
      yield* runPowerShell(
        `Stop-ScheduledTask -TaskName ${psSingleQuote(WINDOWS_TASK_NAME)} -ErrorAction SilentlyContinue | Out-Null; ` +
          `Unregister-ScheduledTask -TaskName ${psSingleQuote(WINDOWS_TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`,
      ).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() =>
            console.warn(
              `Warning: could not remove the ExecutorDaemon scheduled task: ${cause.message}`,
            ),
          ),
        ),
        Effect.ignore,
      );
      const control = path.join(resolveExecutorDataDir(path), "server-control");
      yield* fs.remove(path.join(control, "run-daemon.cmd"), { force: true });
    }),
  status: () =>
    Effect.gen(function* () {
      const result = yield* runPowerShell(
        `$t = Get-ScheduledTask -TaskName ${psSingleQuote(WINDOWS_TASK_NAME)} -ErrorAction SilentlyContinue; ` +
          `if ($null -eq $t) { 'NONE' } else { 'STATE=' + $t.State }`,
      );
      const out = result.stdout.trim();
      if (result.code !== 0 || out === "" || out.includes("NONE")) {
        return {
          platform: "win32" as const,
          registered: false,
          running: false,
          pid: null,
          detail: ["No ExecutorDaemon scheduled task registered. Run `executor service install`."],
        };
      }
      const state = /STATE=(\w+)/.exec(out)?.[1] ?? "Unknown";
      const running = state === "Running";
      return {
        platform: "win32" as const,
        registered: true,
        running,
        pid: null,
        detail: running ? [] : [`Scheduled task registered; current state: ${state}.`],
      };
    }),
  restart: () =>
    Effect.gen(function* () {
      const result = yield* runPowerShell(
        `Stop-ScheduledTask -TaskName ${psSingleQuote(WINDOWS_TASK_NAME)} -ErrorAction SilentlyContinue | Out-Null; ` +
          `Start-ScheduledTask -TaskName ${psSingleQuote(WINDOWS_TASK_NAME)}`,
      );
      if (result.code !== 0) {
        return yield* Effect.fail(
          new Error(
            `Failed to restart ExecutorDaemon task (exit ${result.code}): ${result.stderr.trim()}`,
          ),
        );
      }
    }),
});

const makeUnsupportedBackend = (): ServiceBackend => ({
  platform: "unsupported",
  automated: false,
  install: () =>
    Effect.fail(new Error(`OS service install is not supported on ${process.platform}.`)),
  uninstall: () =>
    Effect.fail(new Error(`OS service uninstall is not supported on ${process.platform}.`)),
  status: () =>
    Effect.succeed({
      platform: "unsupported" as const,
      registered: false,
      running: false,
      pid: null,
      detail: [`OS service management is not supported on ${process.platform}.`],
    }),
  restart: () =>
    Effect.fail(new Error(`OS service restart is not supported on ${process.platform}.`)),
});

/** Select the service backend for the current OS. */
export const getServiceBackend = (platform: NodeJS.Platform = process.platform): ServiceBackend => {
  switch (platform) {
    case "darwin":
      return makeLaunchdBackend();
    case "linux":
      return makeSystemdBackend();
    case "win32":
      return makeWindowsBackend();
    default:
      return makeUnsupportedBackend();
  }
};
