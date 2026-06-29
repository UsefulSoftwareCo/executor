import { describe, expect, it } from "@effect/vitest";

import {
  cmdSetValue,
  generateLaunchdPlist,
  generateSystemdUnit,
  generateWindowsDaemonWrapper,
  generateWindowsHiddenLauncherVbs,
  generateWindowsTaskXml,
  getServiceBackend,
  parseNetstatListenerPids,
  parseSchtasksRunning,
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

  it("defaults to a per-user logon task that needs no elevation", () => {
    const xml = generateWindowsTaskXml({
      command: "wscript.exe",
      arguments: '"C:\\Users\\x\\.executor\\server-control\\run-daemon.vbs"',
      userId: "HOST\\x",
    });
    // LogonTrigger + InteractiveToken + LeastPrivilege = run as the user at their
    // own logon, unprivileged. A standard user may register this without admin.
    expect(xml).toContain("<LogonTrigger><Enabled>true</Enabled><UserId>HOST\\x</UserId>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    // The default path must NOT use the admin-only Boot/S4U/Highest knobs.
    expect(xml).not.toContain("BootTrigger");
    expect(xml).not.toContain("S4U");
    expect(xml).not.toContain("HighestAvailable");
    expect(xml).toContain("<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count>");
    expect(xml).toContain("<Command>wscript.exe</Command>");
    expect(xml).toContain("run-daemon.vbs&quot;</Arguments>");
  });

  it("registers a boot-triggered S4U task under --boot (the reboot-survival contract)", () => {
    const xml = generateWindowsTaskXml({
      command: "wscript.exe",
      arguments: '"C:\\Users\\x\\.executor\\server-control\\run-daemon.vbs"',
      userId: "HOST\\x",
      boot: true,
    });
    // BootTrigger + S4U + HighestAvailable = run as the user, at boot, no stored
    // password, no logon. Task Scheduler only lets an elevated shell create this.
    expect(xml).toContain("<BootTrigger><Enabled>true</Enabled></BootTrigger>");
    expect(xml).toContain("<LogonType>S4U</LogonType>");
    expect(xml).toContain("<RunLevel>HighestAvailable</RunLevel>");
    expect(xml).not.toContain("LogonTrigger");
    expect(xml).not.toContain("InteractiveToken");
  });

  it("hides the daemon console via a wait-and-propagate wscript shim", () => {
    const vbs = generateWindowsHiddenLauncherVbs(
      "C:\\Users\\x\\.executor\\server-control\\run-daemon.cmd",
    );
    // Run(cmd, 0, True): 0 = hidden window, True = wait so the task stays Running
    // and the wrapper's exit code propagates (preserving RestartOnFailure).
    expect(vbs).toContain(
      'sh.Run("""C:\\Users\\x\\.executor\\server-control\\run-daemon.cmd""", 0, True)',
    );
    expect(vbs).toContain("WScript.Quit rc");
  });

  it("parses LISTENING pids for the service port from netstat output", () => {
    const netstat = [
      "Active Connections",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:4789         0.0.0.0:0              LISTENING       4072",
      "  TCP    127.0.0.1:4789         127.0.0.1:51000       ESTABLISHED     4072",
      "  TCP    [::1]:4789             [::]:0                LISTENING       4072",
      "  TCP    0.0.0.0:445            0.0.0.0:0             LISTENING       4",
      "  TCP    127.0.0.1:8765         0.0.0.0:0             LISTENING       9999",
    ].join("\r\n");
    expect(parseNetstatListenerPids(netstat, 4789)).toEqual([4072]);
    // A connection in another state on the port must not be treated as a listener.
    expect(parseNetstatListenerPids(netstat, 445)).toEqual([4]);
    expect(parseNetstatListenerPids(netstat, 1234)).toEqual([]);
  });

  it("identifies listeners by wildcard remote, so it survives a localized state column", () => {
    // German netstat: the state word is "ABHÖREN"/"HERGESTELLT", but addresses and
    // "TCP" are not localized. Listener detection must not depend on the word.
    const deNetstat = [
      "Aktive Verbindungen",
      "  Proto  Lokale Adresse         Remoteadresse          Status          PID",
      "  TCP    127.0.0.1:4789         0.0.0.0:0              ABHÖREN         4072",
      "  TCP    127.0.0.1:4789         127.0.0.1:51000       HERGESTELLT     8000",
    ].join("\r\n");
    expect(parseNetstatListenerPids(deNetstat, 4789)).toEqual([4072]);
  });

  it("detects a running task via the locale-invariant result code, not the Status word", () => {
    // English verbose LIST output for a running task.
    const en = [
      "TaskName:                             \\ExecutorDaemon",
      "Status:                               Running",
      "Last Result:                          267009",
    ].join("\r\n");
    expect(parseSchtasksRunning(en)).toBe(true);

    // French Windows: both the label and the status word are translated, but the
    // SCHED_S_TASK_RUNNING code (267009 / 0x41301) is the same.
    const fr = [
      "Nom de tâche:                         \\ExecutorDaemon",
      "État:                                 En cours d'exécution",
      "Dernier résultat:                     267009",
    ].join("\r\n");
    expect(parseSchtasksRunning(fr)).toBe(true);

    // A ready/terminated task (267014 = SCHED_S_TASK_TERMINATED) is not running.
    const ready = ["Status:                               Ready", "Last Result:    267014"].join(
      "\r\n",
    );
    expect(parseSchtasksRunning(ready)).toBe(false);
    // Hex form (some builds/locales) is also recognized.
    expect(parseSchtasksRunning("Last Result: 0x41301")).toBe(true);
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
