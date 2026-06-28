// Cross-OS proof of the Phase 1 daemon election (apps/cli/src/main.ts). On a real
// guest OS, fire N `executor` clients at a COLD data dir simultaneously: each
// auto-starts a daemon via resolveExecutorServerConnection -> ensureDaemon ->
// spawnAndWaitForDaemon (the election). Before Phase 1 exactly one client won and
// the other N-1 hard-failed on the start-lock; the fix makes the losers wait for
// the winner's manifest and attach. So the assertion is simply: ALL N succeed,
// exactly one owner is elected, and it is reachable. A second (warm) wave proves
// the steady-state attach path. Uses a separate data dir from the service daemon
// that globalsetup installed on ~/.executor, so the two never collide.
//
// Runs on the cli-* VM targets (cli-linux / cli-macos on local tart; cli-windows
// on EC2). Drive everything over the same SSH the other cli tests use.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, it } from "@effect/vitest";

const execFileAsync = promisify(execFile);

const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=15",
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
      maxBuffer: 64 * 1024 * 1024,
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

const exePath = (): string => {
  const dir = process.env.E2E_CLI_BIN_DIR ?? (guestOs() === "windows" ? "C:/ed" : "~/ed");
  return guestOs() === "windows" ? `${dir}/executor.exe` : `${dir}/executor`;
};

const CLIENTS = 6;

// One concurrent wave of N cold/warm clients against data dir D, emitting a
// single parseable summary line. Unix (linux+macos) flavor; the election logic
// under test is OS-agnostic, the shell around it is not.
const unixWaveScript = (exe: string, dir: string, n: number): string =>
  [
    "set -u",
    `EXE=${exe}`,
    `D=${dir}`,
    // `timeout` is GNU coreutils: present on Linux, absent on the macOS guest
    // (where it would be `gtimeout`). Fall back to no wrapper; the test's own
    // 300s budget and `tools search` self-completing are the backstops.
    "TO=$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)",
    "run_client() {",
    '  if [ -n "$TO" ]; then',
    `    "$TO" 120 env EXECUTOR_DATA_DIR="$D" EXECUTOR_SCOPE_DIR="$D" "$EXE" tools search "probe-$1" >"$D/out-$1" 2>&1`,
    "  else",
    `    env EXECUTOR_DATA_DIR="$D" EXECUTOR_SCOPE_DIR="$D" "$EXE" tools search "probe-$1" >"$D/out-$1" 2>&1`,
    "  fi",
    '  echo $? >"$D/rc-$1"',
    "}",
    `i=1; while [ $i -le ${n} ]; do run_client $i & i=$((i+1)); done; wait`,
    "ok=0; spawned=0; i=1",
    `while [ $i -le ${n} ]; do`,
    '  rc=$(cat "$D/rc-$i" 2>/dev/null || echo X); [ "$rc" = "0" ] && ok=$((ok+1))',
    '  grep -q "Starting daemon" "$D/out-$i" 2>/dev/null && spawned=$((spawned+1))',
    "  i=$((i+1)); done",
    `manifests=$(ls "$D"/daemon-active-* 2>/dev/null | wc -l | tr -d ' ')`,
    `port=$(cat "$D"/daemon-localhost-*.json 2>/dev/null | sed -n 's/.*"port":[ ]*\\([0-9]*\\).*/\\1/p' | head -1)`,
    `health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:$port/api/health" 2>/dev/null || echo 000)`,
    `echo "PROBE_SUMMARY ok=$ok n=${n} spawned=$spawned manifests=$manifests port=$port health=$health"`,
  ].join("\n");

const parseSummary = (stdout: string): Record<string, string> => {
  const line = stdout.split("\n").find((l) => l.includes("PROBE_SUMMARY"));
  if (!line) throw new Error(`no PROBE_SUMMARY in:\n${stdout}`);
  const out: Record<string, string> = {};
  for (const tok of line.replace("PROBE_SUMMARY", "").trim().split(/\s+/)) {
    const [k, v] = tok.split("=");
    if (k) out[k] = v ?? "";
  }
  return out;
};

it("Cold-start election: N simultaneous clients all attach to one elected daemon", async () => {
  if (guestOs() === "windows") {
    // This SSH/unix-shell flavor does not cover the Windows guest. The same
    // election is proven on real Windows by election-cold-start.win.ps1, run by
    // hand against the long-lived dockur (QEMU) Windows guest (no EC2 spend):
    //   cold ok=6 n=6 spawned=1 ... / warm ok=6 n=6 spawned=0 ... (one winner, rest attach).
    console.warn(
      "election-cold-start: see election-cold-start.win.ps1 for the Windows proof; skipping",
    );
    return;
  }
  const exe = exePath();
  const dir = "/tmp/election-probe";
  await ssh(`rm -rf ${dir} && mkdir -p ${dir}`);

  // WAVE 1: cold. No daemon owns `dir`. All N race the start-lock.
  const cold = await ssh(unixWaveScript(exe, dir, CLIENTS));
  const c = parseSummary(cold.stdout);
  console.log(`[cold] ${cold.stdout.split("\n").find((l) => l.includes("PROBE_SUMMARY"))}`);
  expect(Number(c.ok), `all ${CLIENTS} cold clients succeeded (stdout:\n${cold.stdout})`).toBe(
    CLIENTS,
  );
  expect(Number(c.manifests), "exactly one daemon was elected").toBe(1);
  expect(c.health, "the elected daemon answers /api/health").toBe("200");

  // WAVE 2: warm. A daemon now owns `dir`; every client should attach.
  const warm = await ssh(unixWaveScript(exe, dir, CLIENTS));
  const w = parseSummary(warm.stdout);
  console.log(`[warm] ${warm.stdout.split("\n").find((l) => l.includes("PROBE_SUMMARY"))}`);
  expect(Number(w.ok), `all ${CLIENTS} warm clients attached (stdout:\n${warm.stdout})`).toBe(
    CLIENTS,
  );
  expect(Number(w.manifests), "still exactly one daemon").toBe(1);
  expect(w.health, "daemon still reachable").toBe("200");

  // Leave the guest clean: stop only the daemon we elected (not the service
  // daemon globalsetup installed on ~/.executor).
  await ssh(
    `pid=$(cat ${dir}/daemon-active-* 2>/dev/null | sed -n 's/.*"pid":[ ]*\\([0-9]*\\).*/\\1/p' | head -1); [ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf ${dir}; true`,
  );
}, 300_000);
