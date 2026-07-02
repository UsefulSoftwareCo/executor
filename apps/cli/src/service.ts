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
// By default each backend starts the daemon at LOGIN with no elevation: launchd
// RunAtLoad, systemd --user, and a Windows per-user logon Scheduled Task. Where
// the platform can also survive a reboot before any login, that is layered on
// best-effort (Linux lingering) or behind an explicit, elevation-requiring opt
// in (Windows `--boot`: a BootTrigger/S4U task). Windows registration goes
// through `schtasks.exe` (Task Scheduler RPC), not the CIM `*-ScheduledTask`
// cmdlets, so a non-admin install from the compiled binary is not blocked by a
// DCOM local-activation denial.
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
  /**
   * Opt in to boot-survival-before-login (Windows only, requires elevation).
   * Default (false) installs a per-user, login-triggered task that needs no
   * Administrator shell, matching launchd RunAtLoad and systemd --user. When
   * true the Windows backend registers an AtStartup/S4U task that runs at boot
   * before any logon, which Task Scheduler only lets an elevated shell create.
   * launchd and systemd ignore this flag (they always start at login, with
   * Linux lingering best-effort upgrading that to boot).
   */
  readonly boot?: boolean;
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

/**
 * The Scheduled Task is registered for this exact account. We pass the
 * fully-qualified `DOMAIN\user` (really `COMPUTERNAME\user` on a standalone box)
 * so Task Scheduler resolves the principal as the caller and lets a non-admin
 * register a task that runs as themselves. The bare username also works, but the
 * qualified form is unambiguous when the machine is domain-joined.
 */
const windowsTaskUserId = (): string => {
  const name = userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${name}` : name;
};

/**
 * Render the Task Scheduler task definition (Task Scheduler 1.2 XML, the schema
 * `schtasks /create /xml` consumes). Two shapes, same running contract
 * (RestartOnFailure gives crash-restart; ExecutionTimeLimit=PT0S means "never
 * time out a long-running task"):
 *
 * - `boot: false` (DEFAULT, no Administrator needed): a LogonTrigger for this
 *   user + an InteractiveToken principal at LeastPrivilege. A standard user is
 *   allowed to register a task that runs as themselves at their own logon, so
 *   this installs from an ordinary, non-elevated shell. It is the Windows
 *   equivalent of a launchd LaunchAgent with RunAtLoad and `systemd --user`:
 *   the daemon comes up when the user logs in, unprivileged.
 *
 * - `boot: true` (requires an elevated/Administrator shell): a BootTrigger + an
 *   S4U principal at HighestAvailable. Runs the daemon AS THE USER at boot, with
 *   no stored password and no interactive logon — survives a real reboot with no
 *   login on a headless host. Task Scheduler only lets an elevated shell create
 *   a boot/S4U task, which is why this path costs the UAC prompt.
 *
 * We register via `schtasks.exe` rather than the PowerShell `*-ScheduledTask`
 * cmdlets on purpose: those cmdlets reach Task Scheduler over CIM/DCOM, whose
 * local-activation check fails with "Access denied" (0x80070005) when the
 * compiled `executor` binary spawns the helper on a non-interactive window
 * station. `schtasks` talks to the Task Scheduler service over RPC, so it has no
 * such dependency and a non-admin install succeeds.
 */
export const generateWindowsTaskXml = (options: {
  readonly command: string;
  readonly arguments?: string;
  readonly userId: string;
  readonly boot?: boolean;
}): string => {
  const user = xmlEscape(options.userId);
  const trigger = options.boot
    ? "<BootTrigger><Enabled>true</Enabled></BootTrigger>"
    : `<LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger>`;
  const logonType = options.boot ? "S4U" : "InteractiveToken";
  const runLevel = options.boot ? "HighestAvailable" : "LeastPrivilege";
  const action = options.arguments
    ? `<Exec><Command>${xmlEscape(options.command)}</Command><Arguments>${xmlEscape(options.arguments)}</Arguments></Exec>`
    : `<Exec><Command>${xmlEscape(options.command)}</Command></Exec>`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo><Description>Executor supervised daemon</Description></RegistrationInfo>",
    `  <Triggers>${trigger}</Triggers>`,
    "  <Principals>",
    `    <Principal id="Author"><UserId>${user}</UserId><LogonType>${logonType}</LogonType><RunLevel>${runLevel}</RunLevel></Principal>`,
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Enabled>true</Enabled>",
    "  </Settings>",
    '  <Actions Context="Author">',
    `    ${action}`,
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
};

/**
 * A tiny VBScript shim the task runs via `wscript.exe`. The default (logon) task
 * runs in the user's interactive session, so pointing its action straight at the
 * `.cmd` wrapper would flash a console window on the desktop at every login. The
 * shim launches the wrapper with a hidden window (`Run(cmd, 0, True)`) and waits
 * for it, so: no visible window, and `wscript` stays alive for the daemon's
 * lifetime, which keeps the task reported as Running and preserves RestartOnFailure
 * (the wrapper's exit code propagates out). Output still flows to daemon.log via
 * the wrapper's own redirection.
 */
export const generateWindowsHiddenLauncherVbs = (wrapperPath: string): string =>
  [
    'Set sh = CreateObject("WScript.Shell")',
    `rc = sh.Run("""${wrapperPath}""", 0, True)`,
    "WScript.Quit rc",
    "",
  ].join("\r\n");

/** Run schtasks.exe, capturing (stdout, stderr, code). */
const runSchtasks = (args: ReadonlyArray<string>): Effect.Effect<CommandResult, Error> =>
  runCommand("schtasks.exe", args);

/** Write a UTF-16LE (BOM-prefixed) file — the encoding schtasks expects for XML. */
const writeUtf16File = (
  path: string,
  contents: string,
): Effect.Effect<void, Error | PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bytes = Buffer.from(`﻿${contents}`, "utf16le");
    yield* fs.writeFile(path, new Uint8Array(bytes));
  });

/**
 * SCHED_S_TASK_RUNNING — the Task Scheduler HRESULT a task reports as its "Last
 * Result" while it is currently running (0x00041301 == 267009). schtasks prints
 * this in the verbose listing as a decimal; some Windows builds/locales print the
 * hex form. The numeric code is locale-invariant even though the surrounding
 * labels ("Last Result:", "Status:") and the human state word ("Running") are
 * translated on a non-English Windows.
 */
const SCHED_S_TASK_RUNNING = 267009;

/**
 * Decide whether `schtasks /query /v /fo LIST` reports the task as currently
 * running, without depending on the localized "Status:" line. We look for the
 * locale-invariant SCHED_S_TASK_RUNNING result code instead. Pure + exported for
 * unit tests (including non-English fixtures).
 */
export const parseSchtasksRunning = (verboseListOutput: string): boolean =>
  new RegExp(`\\b(?:${SCHED_S_TASK_RUNNING}|0x0*41301)\\b`, "i").test(verboseListOutput);

/**
 * Parse `netstat -ano` output for the PIDs listening on `port`. Pure, so it can
 * be unit-tested without a live socket. Matches both IPv4 (`127.0.0.1:PORT`) and
 * IPv6 (`[::1]:PORT`) local endpoints. A listener is identified by its
 * wildcard/zero remote endpoint (`0.0.0.0:0` / `[::]:0`) rather than the state
 * column, because that column ("LISTENING") is localized on a non-English
 * Windows while the addresses and the `TCP` token are not.
 */
const NETSTAT_LISTENER_REMOTES = new Set(["0.0.0.0:0", "[::]:0", "*:*"]);

export const parseNetstatListenerPids = (output: string, port: number): ReadonlyArray<number> => {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // TCP  <local>  <remote(=wildcard when listening)>  <state>  <pid>
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP") continue;
    if (!cols[1].endsWith(`:${port}`)) continue;
    if (!NETSTAT_LISTENER_REMOTES.has(cols[2])) continue;
    const pid = Number.parseInt(cols[4], 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
};

/**
 * Stop orphaned Windows `executor.exe` listeners on the service port. Task
 * Scheduler can report the task as stopped after terminating the `.cmd` action
 * while leaving the child `executor.exe` process bound to the port. That process
 * is healthy enough to satisfy `/api/health`, but `executor web` cannot discover
 * it once its `server.json` is gone. We use netstat/tasklist/taskkill (RPC/Win32
 * tools) rather than the CIM `Get-NetTCPConnection`/`Get-CimInstance` cmdlets so
 * this works from the compiled binary without a DCOM local-activation grant.
 */
export const stopWindowsExecutorListenersOnPort = (
  port: number,
): Effect.Effect<ReadonlyArray<number>, Error> =>
  Effect.gen(function* () {
    const netstat = yield* runCommand("netstat.exe", ["-ano", "-p", "tcp"]);
    if (netstat.code !== 0) {
      const detail = netstat.stderr.trim() || netstat.stdout.trim();
      return yield* Effect.fail(
        new Error(`Failed to inspect Executor listeners on port ${port}: ${detail}`),
      );
    }
    const stopped: number[] = [];
    for (const pid of parseNetstatListenerPids(netstat.stdout, port)) {
      // Confirm the listener really is executor.exe before killing it.
      const list = yield* runCommand("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      if (!/"executor\.exe"/i.test(list.stdout)) continue;
      const kill = yield* runCommand("taskkill.exe", ["/PID", String(pid), "/F"]);
      if (kill.code === 0) stopped.push(pid);
    }
    return stopped;
  });

const makeWindowsBackend = (): ServiceBackend => {
  const controlDir = (path: Path.Path): string =>
    path.join(resolveExecutorDataDir(path), "server-control");
  const taskXmlPath = (path: Path.Path): string => path.join(controlDir(path), "run-daemon.xml");
  const wrapperCmdPath = (path: Path.Path): string => path.join(controlDir(path), "run-daemon.cmd");
  const launcherVbsPath = (path: Path.Path): string =>
    path.join(controlDir(path), "run-daemon.vbs");

  return {
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

        const wrapperPath = wrapperCmdPath(path);
        yield* fs.writeFileString(
          wrapperPath,
          generateWindowsDaemonWrapper(descriptor, dataDir, logs),
        );

        // Launch the wrapper through a hidden wscript shim so the logon task
        // doesn't flash a console window on the interactive desktop each login.
        const vbsPath = launcherVbsPath(path);
        yield* fs.writeFileString(vbsPath, generateWindowsHiddenLauncherVbs(wrapperPath));

        const xmlPath = taskXmlPath(path);
        yield* writeUtf16File(
          xmlPath,
          generateWindowsTaskXml({
            command: "wscript.exe",
            arguments: `"${vbsPath}"`,
            userId: windowsTaskUserId(),
            boot: descriptor.boot ?? false,
          }),
        );

        const create = yield* runSchtasks([
          "/create",
          "/tn",
          WINDOWS_TASK_NAME,
          "/xml",
          xmlPath,
          "/f",
        ]);
        if (create.code !== 0) {
          // schtasks ends its messages with a period; drop it so the assembled
          // sentence doesn't read "denied.. <hint>".
          const detail = (create.stderr.trim() || create.stdout.trim()).replace(/\.\s*$/, "");
          // The default (logon) task needs no elevation. Only the --boot path
          // registers a boot/S4U task, which Task Scheduler refuses without
          // Administrator — so point access-denial at the relevant fix.
          const hint = /denied|0x80070005|administrator|elevat/i.test(detail)
            ? descriptor.boot
              ? " `--boot` registers a boot task, which needs an Administrator shell. Re-run elevated, or drop `--boot` to install a no-elevation login task."
              : " Run `executor service install` from an Administrator shell."
            : "";
          return yield* Effect.fail(
            new Error(`schtasks /create failed (exit ${create.code}): ${detail}.${hint}`),
          );
        }

        // Bring it up now (the other backends start on install too). A logon task
        // /run launches in the current interactive session; tolerate a non-zero
        // here (e.g. no interactive session yet) since the trigger still fires on
        // the next logon and `service status` reports the registered task.
        yield* runSchtasks(["/run", "/tn", WINDOWS_TASK_NAME]).pipe(Effect.ignore);
      }),
    uninstall: () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Idempotent: tolerate "task not found" but warn if schtasks can't run.
        yield* runSchtasks(["/end", "/tn", WINDOWS_TASK_NAME]).pipe(Effect.ignore);
        yield* runSchtasks(["/delete", "/tn", WINDOWS_TASK_NAME, "/f"]).pipe(
          Effect.tapError((cause) =>
            Effect.sync(() =>
              console.warn(
                `Warning: could not remove the ExecutorDaemon scheduled task: ${cause.message}`,
              ),
            ),
          ),
          Effect.ignore,
        );
        yield* fs.remove(wrapperCmdPath(path), { force: true });
        yield* fs.remove(launcherVbsPath(path), { force: true });
        yield* fs.remove(taskXmlPath(path), { force: true });
      }),
    status: () =>
      Effect.gen(function* () {
        const result = yield* runSchtasks([
          "/query",
          "/tn",
          WINDOWS_TASK_NAME,
          "/fo",
          "LIST",
          "/v",
        ]);
        if (result.code !== 0) {
          return {
            platform: "win32" as const,
            registered: false,
            running: false,
            pid: null,
            detail: [
              "No ExecutorDaemon scheduled task registered. Run `executor service install`.",
            ],
          };
        }
        // Detect "running" via the locale-invariant SCHED_S_TASK_RUNNING result
        // code, not the translated "Status: Running" line (which is localized on
        // a non-English Windows and would otherwise always read as not-running).
        const running = parseSchtasksRunning(result.stdout);
        return {
          platform: "win32" as const,
          registered: true,
          running,
          pid: null,
          detail: running ? [] : ["Scheduled task registered but not currently running."],
        };
      }),
    restart: () =>
      Effect.gen(function* () {
        yield* runSchtasks(["/end", "/tn", WINDOWS_TASK_NAME]).pipe(Effect.ignore);
        const run = yield* runSchtasks(["/run", "/tn", WINDOWS_TASK_NAME]);
        if (run.code !== 0) {
          return yield* Effect.fail(
            new Error(
              `Failed to restart ExecutorDaemon task (exit ${run.code}): ${run.stderr.trim() || run.stdout.trim()}`,
            ),
          );
        }
      }),
  };
};

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
