/* oxlint-disable executor/no-conditional-tests -- e2e scenario uses try/finally to restore the VM service after assertions */
// Real VM e2e for the upgrade path: `executor service install` must take over
// a same-data-dir predecessor instead of refusing and leaving users to find a
// pid. Runs on the CLI VM targets where the test worker can SSH into the guest
// that globalsetup provisioned.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";

const execFileAsync = promisify(execFile);
const PORT = 4789;

const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "LogLevel=ERROR",
] as const;

type GuestOs = "macos" | "linux" | "windows";

const guestOs = (): GuestOs => {
  const os = process.env.E2E_VM_OS;
  if (os === "macos" || os === "linux" || os === "windows") return os;
  throw new Error(`Unsupported E2E_VM_OS: ${os ?? "<unset>"}`);
};

const sshInvocation = (command: string): { command: string; args: ReadonlyArray<string> } => {
  const host = process.env.E2E_CLI_VM_HOST;
  if (!host) throw new Error("E2E_CLI_VM_HOST is not set");
  const os = guestOs();
  const wrapped =
    os === "linux" ? `export XDG_RUNTIME_DIR=/run/user/$(id -u); ${command}` : command;
  const keyPath = process.env.E2E_CLI_SSH_KEY;
  const user = os === "windows" ? "Administrator" : "admin";
  return keyPath
    ? { command: "ssh", args: ["-i", keyPath, ...SSH_OPTS, `${user}@${host}`, wrapped] }
    : {
        command: process.env.E2E_SSHPASS_BIN ?? "/opt/homebrew/bin/sshpass",
        args: ["-p", "admin", "ssh", ...SSH_OPTS, `${user}@${host}`, wrapped],
      };
};

const ssh = async (command: string): Promise<{ stdout: string; stderr: string; code: number }> => {
  const invocation = sshInvocation(command);
  try {
    const { stdout, stderr } = await execFileAsync(invocation.command, [...invocation.args], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
};

const executorPath = (): string => {
  const dir = process.env.E2E_CLI_BIN_DIR ?? (guestOs() === "windows" ? "C:/ed" : "~/ed");
  return guestOs() === "windows" ? `${dir}/executor.exe` : `${dir}/executor`;
};

const healthStatusCommand = (): string =>
  guestOs() === "windows"
    ? `try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://127.0.0.1:${PORT}/api/health'; [string]$r.StatusCode } catch { '000' }`
    : `curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${PORT}/api/health`;

const waitForGuestHealth = async (expected: boolean): Promise<boolean> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = await ssh(healthStatusCommand());
    const healthy = result.stdout.trim() === "200";
    if (healthy === expected) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

const listenerPid = async (): Promise<string> =>
  (
    await ssh(
      guestOs() === "windows"
        ? `$c = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -ne $c) { [string]$c.OwningProcess }`
        : `lsof -ti tcp:${PORT} -sTCP:LISTEN 2>/dev/null | head -1`,
    )
  ).stdout.trim();

const uninstallServiceCommand = (exe: string): string =>
  guestOs() === "windows"
    ? `& '${exe}' service uninstall *> 'C:/Windows/Temp/takeover-uninstall.log'; exit 0`
    : `${exe} service uninstall >/tmp/takeover-uninstall.log 2>&1 || true`;

interface PredecessorHandle {
  readonly close: () => void;
  readonly diagnostics: () => Promise<string>;
}

const appendChunk = (existing: string, chunk: Buffer): string =>
  `${existing}${chunk.toString("utf8")}`.slice(-16_000);

const windowsPredecessorCommand = (exe: string): string =>
  `& '${exe}' daemon run --foreground --port ${PORT} --hostname 127.0.0.1`;

const startPredecessor = async (exe: string): Promise<PredecessorHandle> => {
  if (guestOs() !== "windows") {
    await ssh(
      `nohup ${exe} daemon run --foreground --port ${PORT} --hostname 127.0.0.1 >/tmp/takeover-predecessor.log 2>&1 &`,
    );
    return {
      close: () => {},
      diagnostics: async () =>
        (await ssh("cat /tmp/takeover-predecessor.log 2>/dev/null || true")).stdout.trim(),
    };
  }

  const invocation = sshInvocation(windowsPredecessorCommand(exe));
  const child: ChildProcessWithoutNullStreams = spawn(invocation.command, [...invocation.args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let exit: string | null = null;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = appendChunk(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendChunk(stderr, chunk);
  });
  child.on("error", (error) => {
    exit = `spawn error: ${error.message}`;
  });
  child.on("exit", (code, signal) => {
    exit = `exit code ${code ?? "<null>"} signal ${signal ?? "<null>"}`;
  });

  return {
    close: () => {
      if (!child.killed) child.kill();
    },
    diagnostics: async () =>
      [`predecessor ssh: ${exit ?? "still running"}`, `stdout:\n${stdout}`, `stderr:\n${stderr}`]
        .join("\n")
        .trim(),
  };
};

const installServiceCommand = (exe: string): string =>
  guestOs() === "windows"
    ? `& '${exe}' service install --port ${PORT}; exit $LASTEXITCODE`
    : `${exe} service install --port ${PORT}`;

const processAliveCommand = (pid: string): string =>
  guestOs() === "windows"
    ? `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'dead' }`
    : `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`;

const restoreServiceCommand = (exe: string): string =>
  guestOs() === "windows"
    ? `& '${exe}' service install --port ${PORT} *> 'C:/Windows/Temp/takeover-restore.log'; exit 0`
    : `${exe} service install --port ${PORT} >/tmp/takeover-restore.log 2>&1 || true`;

scenario(
  "CLI service install · takes over a running predecessor daemon",
  { timeout: 180_000 },
  Effect.promise(async () => {
    const exe = executorPath();
    let predecessor: PredecessorHandle | null = null;
    try {
      await ssh(uninstallServiceCommand(exe));
      expect(await waitForGuestHealth(false), "service stopped before staging predecessor").toBe(
        true,
      );

      predecessor = await startPredecessor(exe);
      const predecessorReady = await waitForGuestHealth(true);
      expect(
        predecessorReady,
        `predecessor daemon became reachable\n${await predecessor.diagnostics()}`,
      ).toBe(true);
      const predecessorPid = await listenerPid();
      expect(predecessorPid, "predecessor owns the service port").not.toBe("");

      const install = await ssh(installServiceCommand(exe));
      expect(
        install.code,
        `service install should take over instead of refusing\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`,
      ).toBe(0);
      expect(await waitForGuestHealth(true), "service is reachable after install").toBe(true);

      const ownerPid = await listenerPid();
      const predecessorAlive = (await ssh(processAliveCommand(predecessorPid))).stdout.trim();
      expect(predecessorAlive, "predecessor process was stopped").toBe("dead");
      expect(ownerPid, "the service now owns the port").not.toBe("");
      expect(ownerPid, "the service is a different process").not.toBe(predecessorPid);
    } finally {
      predecessor?.close();
      await ssh(restoreServiceCommand(exe));
    }
  }),
);
