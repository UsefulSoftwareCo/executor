import { describe, expect, it } from "@effect/vitest";

import {
  cmdSetValue,
  generateLaunchdPlist,
  generateSystemdUnit,
  generateWindowsDaemonWrapper,
  generateWindowsRegisterScript,
  generateWindowsStopExecutorListenersScript,
  getServiceBackend,
} from "./service";

describe("service unit generation", () => {
  const launchdInput = {
    label: "sh.executor.daemon",
    programArguments: [
      "/Applications/Executor.app/Contents/Resources/executor/executor",
      "daemon",
      "run",
      "--foreground",
      "--port",
      "4789",
      "--hostname",
      "127.0.0.1",
    ],
    environment: {
      EXECUTOR_SUPERVISED: "1",
      EXECUTOR_DATA_DIR: "/Users/x/.executor",
      EXECUTOR_SERVICE_VERSION: "1.5.10",
      PATH: "/opt/homebrew/bin:/usr/bin",
    },
    stdoutPath: "/Users/x/.executor/logs/daemon.log",
    stderrPath: "/Users/x/.executor/logs/daemon.error.log",
    workingDirectory: "/Users/x/.executor",
  };

  it("renders a launchd plist that restarts on crash but not clean stop", () => {
    const plist = generateLaunchdPlist(launchdInput);
    expect(plist).toContain('<plist version="1.0">');
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>sh.executor.daemon</string>");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    // KeepAlive => restart only on non-zero/crash exit, not on a clean bootout.
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toContain("<key>ProcessType</key>");
    expect(plist).toContain("<string>Background</string>");
    expect(plist).toContain("--foreground");
    expect(plist).toContain("EXECUTOR_SUPERVISED");
    expect(plist).toContain("/Users/x/.executor/logs/daemon.error.log");
  });

  it("never leaks the auth password into the unit", () => {
    const plist = generateLaunchdPlist(launchdInput);
    // No secret in the unit — the daemon reads the bearer from auth.json at boot.
    expect(plist).not.toContain("EXECUTOR_AUTH_PASSWORD");
  });

  it("xml-escapes environment values", () => {
    const plist = generateLaunchdPlist({
      ...launchdInput,
      environment: { PATH: "a&b<c>\"d'" },
    });
    expect(plist).toContain("a&amp;b&lt;c&gt;&quot;d&apos;");
    expect(plist).not.toMatch(/a&b<c>/);
  });

  it("renders a systemd --user unit with crash-only restart", () => {
    const unit = generateSystemdUnit({
      execStart: [
        "/usr/local/bin/executor",
        "daemon",
        "run",
        "--foreground",
        "--port",
        "4789",
        "--hostname",
        "127.0.0.1",
      ],
      environment: { EXECUTOR_SUPERVISED: "1", EXECUTOR_DATA_DIR: "/home/x/.executor" },
      workingDirectory: "/home/x/.executor",
      stdoutPath: "/home/x/.executor/logs/daemon.log",
      stderrPath: "/home/x/.executor/logs/daemon.error.log",
    });
    expect(unit).toContain(
      "ExecStart=/usr/local/bin/executor daemon run --foreground --port 4789 --hostname 127.0.0.1",
    );
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("Environment=EXECUTOR_SUPERVISED=1");
    expect(unit).not.toContain("EXECUTOR_AUTH_PASSWORD");
  });

  it("bakes the supervised env into the Windows wrapper .cmd", () => {
    const wrapper = generateWindowsDaemonWrapper(
      {
        executablePath: "C:\\Program Files\\Executor\\executor.exe",
        port: 4789,
        version: "1.5.10",
      },
      "C:\\Users\\x\\.executor",
      "C:\\Users\\x\\.executor\\logs",
    );
    // Task Scheduler can't set env, so it rides as `set` lines in the wrapper.
    expect(wrapper).toContain('set "EXECUTOR_SUPERVISED=1"');
    expect(wrapper).toContain('set "EXECUTOR_DATA_DIR=C:\\Users\\x\\.executor"');
    expect(wrapper).toContain(
      '"C:\\Program Files\\Executor\\executor.exe" daemon run --foreground --port 4789 --hostname 127.0.0.1',
    );
    expect(wrapper).toContain('1>> "C:\\Users\\x\\.executor\\logs\\daemon.log"');
    // No secret in the wrapper — the daemon reads the bearer from auth.json at boot.
    expect(wrapper).not.toContain("EXECUTOR_AUTH_PASSWORD");
  });

  it("sanitizes cmd.exe metacharacters in baked env values (cmdSetValue)", () => {
    // A `"` in PATH would close the `set "PATH=..."` quote early and let a
    // `& cmd &` fragment run at boot as the user; strip it (illegal in a path
    // anyway). A `%` would re-expand against the boot environment; double it.
    expect(cmdSetValue('C:\\a" & evil & "C:\\b')).toBe("C:\\a & evil & C:\\b");
    expect(cmdSetValue("C:\\tools\\%LOCALAPPDATA%\\bin")).toBe("C:\\tools\\%%LOCALAPPDATA%%\\bin");
    expect(cmdSetValue("C:\\Program Files\\node")).toBe("C:\\Program Files\\node");
    // The sanitized value, embedded in a `set` line, can't break out of quotes.
    expect(`set "PATH=${cmdSetValue('a"&b')}"`).not.toMatch(/"\s*&/);
  });

  it("registers a boot-triggered S4U task (the reboot-survival contract)", () => {
    const script = generateWindowsRegisterScript({
      taskName: "ExecutorDaemon",
      wrapperPath: "C:\\Users\\x\\.executor\\server-control\\run-daemon.cmd",
      userId: "x",
    });
    // S4U + AtStartup = run as the user, at boot, no stored password, no logon.
    expect(script).toContain("-LogonType S4U");
    expect(script).toContain("New-ScheduledTaskTrigger -AtStartup");
    expect(script).toContain("-RestartCount 3");
    expect(script).toContain("Register-ScheduledTask -TaskName 'ExecutorDaemon'");
    expect(script).toContain("Start-ScheduledTask -TaskName 'ExecutorDaemon'");
  });

  it("stops orphaned executor.exe listeners without shadowing PowerShell's $PID", () => {
    const script = generateWindowsStopExecutorListenersScript(4789);

    expect(script).toContain("Get-NetTCPConnection -LocalPort 4789 -State Listen");
    expect(script).toContain("$listenerPid");
    expect(script).not.toContain("foreach ($pid");
    expect(script).toContain("[string]$process.Name -ieq 'executor.exe'");
    expect(script).toContain('Write-Output ("STOPPED=" + $listenerPid)');
  });
});

describe("service backend dispatch", () => {
  it("selects launchd on macOS (automated)", () => {
    const backend = getServiceBackend("darwin");
    expect(backend.platform).toBe("darwin");
    expect(backend.automated).toBe(true);
  });

  it("selects systemd on linux (automated)", () => {
    expect(getServiceBackend("linux").platform).toBe("linux");
  });

  it("selects Task Scheduler on windows (automated)", () => {
    const backend = getServiceBackend("win32");
    expect(backend.platform).toBe("win32");
    expect(backend.automated).toBe(true);
  });

  it("falls back to unsupported on other platforms", () => {
    expect(getServiceBackend("freebsd").platform).toBe("unsupported");
  });
});
