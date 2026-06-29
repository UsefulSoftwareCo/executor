// Boot the `cli` target: build the guest's `executor` binary, provision a VM,
// install it as a supervised OS service, and forward its loopback HTTP port to
// the host over a reconnecting SSH tunnel. Publishes connection + reboot info
// via env (inherited by the test workers spawned afterward). Per-OS entrypoints
// (cli-macos.globalsetup.ts, …) call setupCliTarget with their OS.
//
// macOS + Linux run on local tart guests (Apple-Silicon host); Windows runs on
// an ephemeral EC2 instance. The supervised daemon is bearer-gated: it mints/
// loads its token into auth.json, which we read from the guest and publish so
// the api surface authenticates with `Authorization: Bearer`.
import { buildGuestBinary } from "../src/vm/build-binary";
import { ec2Vm } from "../src/vm/ec2";
import { tartVm } from "../src/vm/tart";
import type { VmArch, VmHandle, VmOs } from "../src/vm/types";
import { waitForHttp } from "./boot";

const PORT = 4789;

// Per-OS guest specifics: working dir, binary name, and the shell idioms for
// prep/cleanup — Unix `sh` on tart (macOS/Linux), PowerShell on EC2 Windows.
const guestPlan = (os: VmOs) => {
  if (os === "windows") {
    const dir = "C:/ed";
    const exe = `${dir}/executor.exe`;
    return {
      dir,
      prep: `Remove-Item -Recurse -Force '${dir}' -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force -Path '${dir}' | Out-Null`,
      postPush: "Write-Output ok", // no chmod/quarantine on Windows
      install: `& '${exe}' service install --port ${PORT}`,
      readToken: 'Get-Content "$env:USERPROFILE\\.executor\\server-control\\auth.json" -Raw',
      uninstall: `& '${exe}' service uninstall`,
    };
  }
  const dir = "~/ed";
  const exe = `${dir}/executor`;
  return {
    dir,
    prep: `rm -rf ${dir} && mkdir -p ${dir}`,
    // macOS quarantines scp'd executables; clear it so the binary can run.
    postPush:
      os === "macos"
        ? `chmod +x ${exe}; xattr -dr com.apple.quarantine ${dir} 2>/dev/null || true`
        : `chmod +x ${exe}`,
    install: `${exe} service install --port ${PORT}`,
    readToken: "cat ~/.executor/server-control/auth.json",
    uninstall: `${exe} service uninstall`,
  };
};

export async function setupCliTarget(os: VmOs): Promise<(() => Promise<void>) | void> {
  process.env.E2E_VM_OS = os; // so the worker-side target resolves the same OS

  const arch: VmArch = os === "windows" ? "x64" : "arm64";
  const binDir = await buildGuestBinary(os, arch);
  const vm: VmHandle =
    os === "windows" ? await ec2Vm(os, arch).provision() : await tartVm(os, arch).provision();
  const plan = guestPlan(os);

  let tunnelClose: (() => void) | undefined;
  try {
    await vm.ssh(plan.prep);
    await vm.push(`${binDir}/.`, os === "windows" ? plan.dir : `${plan.dir}/`);
    await vm.ssh(plan.postPush);

    const install = await vm.ssh(plan.install);
    if (install.code !== 0) {
      throw new Error(`service install failed: ${install.stderr.trim() || install.stdout.trim()}`);
    }

    // The supervised daemon mints/loads its bearer into auth.json on first boot.
    const tokenRaw = (await vm.ssh(plan.readToken)).stdout.trim();
    const token = (JSON.parse(tokenRaw) as { token: string }).token;

    const tunnel = await vm.tunnel(PORT);
    tunnelClose = tunnel.close;
    const baseUrl = `http://127.0.0.1:${tunnel.localPort}`;
    await waitForHttp(`${baseUrl}/`, { timeoutMs: 60_000 });

    process.env.E2E_CLI_BASE_URL = baseUrl;
    process.env.E2E_CLI_AUTH_TOKEN = token;
    process.env.E2E_CLI_VM_HOST = vm.host;
    if (vm.sshKeyPath) process.env.E2E_CLI_SSH_KEY = vm.sshKeyPath;
    process.env.E2E_CLI_TUNNEL_PORT = String(tunnel.localPort);
    process.env.E2E_CLI_BIN_DIR = plan.dir;
  } catch (error) {
    tunnelClose?.();
    await vm.ssh(plan.uninstall).catch(() => undefined);
    await vm.discard();
    throw error;
  }

  return async () => {
    tunnelClose?.();
    await vm.ssh(plan.uninstall).catch(() => undefined);
    await vm.discard();
  };
}
