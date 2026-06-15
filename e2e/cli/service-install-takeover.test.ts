/* oxlint-disable executor/no-conditional-tests -- e2e scenario uses try/finally to restore the VM service after assertions */
// Real VM e2e for the upgrade path: `executor service install` must take over
// a same-data-dir predecessor instead of refusing and leaving users to find a
// pid. Runs on the tart-backed Unix CLI targets where the test worker can SSH
// into the guest that globalsetup provisioned.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, it } from "@effect/vitest";
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

const ssh = async (command: string): Promise<{ stdout: string; stderr: string; code: number }> => {
  const host = process.env.E2E_CLI_VM_HOST;
  const os = process.env.E2E_VM_OS;
  if (!host) throw new Error("E2E_CLI_VM_HOST is not set");
  const wrapped =
    os === "linux" ? `export XDG_RUNTIME_DIR=/run/user/$(id -u); ${command}` : command;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.env.E2E_SSHPASS_BIN ?? "/opt/homebrew/bin/sshpass",
      ["-p", "admin", "ssh", ...SSH_OPTS, `admin@${host}`, wrapped],
      { maxBuffer: 32 * 1024 * 1024 },
    );
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

const waitForGuestHealth = async (expected: boolean): Promise<boolean> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = await ssh(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${PORT}/api/health`,
    );
    const healthy = result.stdout.trim() === "200";
    if (healthy === expected) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

const listenerPid = async (): Promise<string> =>
  (await ssh(`lsof -ti tcp:${PORT} -sTCP:LISTEN 2>/dev/null | head -1`)).stdout.trim();

if (process.env.E2E_VM_OS === "windows") {
  it.skip("CLI service install takeover · Windows coverage uses the restart service matrix", () => {});
} else {
  scenario(
    "CLI service install · takes over a running predecessor daemon",
    { timeout: 180_000 },
    Effect.promise(async () => {
      const exe = `${process.env.E2E_CLI_BIN_DIR ?? "~/ed"}/executor`;
      try {
        await ssh(`${exe} service uninstall >/tmp/takeover-uninstall.log 2>&1 || true`);
        expect(await waitForGuestHealth(false), "service stopped before staging predecessor").toBe(
          true,
        );

        await ssh(
          `nohup ${exe} daemon run --foreground --port ${PORT} >/tmp/takeover-predecessor.log 2>&1 &`,
        );
        expect(await waitForGuestHealth(true), "predecessor daemon became reachable").toBe(true);
        const predecessorPid = await listenerPid();
        expect(predecessorPid, "predecessor owns the service port").not.toBe("");

        const install = await ssh(`${exe} service install --port ${PORT}`);
        expect(
          install.code,
          `service install should take over instead of refusing\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`,
        ).toBe(0);
        expect(await waitForGuestHealth(true), "service is reachable after install").toBe(true);

        const ownerPid = await listenerPid();
        const predecessorAlive = (
          await ssh(`kill -0 ${predecessorPid} 2>/dev/null && echo alive || echo dead`)
        ).stdout.trim();
        expect(predecessorAlive, "predecessor process was stopped").toBe("dead");
        expect(ownerPid, "the service now owns the port").not.toBe("");
        expect(ownerPid, "the service is a different process").not.toBe(predecessorPid);
      } finally {
        await ssh(`${exe} service install --port ${PORT} >/tmp/takeover-restore.log 2>&1 || true`);
      }
    }),
  );
}
