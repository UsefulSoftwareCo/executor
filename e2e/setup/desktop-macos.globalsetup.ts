// desktop-macos: bring the PACKAGED app up inside a macOS GUI guest and forward
// its CDP port (the shared attach/forward lives in ./desktop-vm). The guest runs
// tart `--no-graphics` (no host window) but the base image's autologin still
// reaches a real Aqua session, so the GUI renders and `screencapture` films it.
// We come up the SAME way desktop-packaged does — start the bundled daemon, then
// launch the app so it ATTACHES (no sidecar spawn → no first-run consent modal).
// The app must be launched INTO the Aqua session (`launchctl asuser`); a plain
// SSH spawn lands in a non-GUI session.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { pushDirAsTar } from "../src/vm/desktop";
import { tartVm } from "../src/vm/tart";
import {
  attachOrProvision,
  CDP_GUEST_PORT,
  waitGuestHttp,
  waitGuestPageTarget,
  type ProvisionedGuest,
} from "./desktop-vm";

const DAEMON_PORT = 4789;
const GUEST_DIR = "/Users/admin/exe";
const GUEST_HOME = "/Users/admin/exe-home";

const appDir = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const hostBundle = () => {
  const app = join(appDir, "dist", "mac-arm64", "Executor.app");
  return {
    app,
    exe: join(app, "Contents/MacOS/Executor"),
    executor: join(app, "Contents/Resources/executor/executor"),
  };
};

/** Build the packaged mac bundle if it isn't on disk (slow; reuse an existing
 * dist/ while iterating). Mirrors desktop-packaged.globalsetup. */
const ensureBundle = (): void => {
  if (existsSync(hostBundle().app)) return;
  const run = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { cwd: appDir, stdio: "inherit", env: { ...process.env } });
  run("bun", ["./scripts/build-sidecar.ts"]);
  run("bunx", ["--bun", "electron-vite", "build"]);
  execFileSync(
    "bunx",
    ["--bun", "electron-builder", "--config", "electron-builder.e2e.config.ts", "--mac"],
    {
      cwd: appDir,
      stdio: "inherit",
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    },
  );
};

const provisionMac = async (): Promise<ProvisionedGuest> => {
  ensureBundle();
  const { exe, executor } = hostBundle();
  const vm = await tartVm("macos", "arm64").provision();
  try {
    // Push the bundle (tar-stream, robust over the just-booted link) and clear
    // the scp quarantine so it can run.
    await vm.ssh(`rm -rf ${GUEST_DIR} ${GUEST_HOME} && mkdir -p ${GUEST_HOME}/.executor`);
    await pushDirAsTar(vm.host, hostBundle().app, GUEST_DIR);
    await vm.ssh(`xattr -dr com.apple.quarantine ${GUEST_DIR} 2>/dev/null || true`);
    // The e2e build is unsigned; an arm64 app needs at least an ad-hoc signature
    // to execute, and the host build's signature isn't trusted on another Mac.
    await vm.ssh(
      `codesign --force --deep --sign - ${GUEST_DIR}/Executor.app 2>&1 | tail -2 || true`,
    );

    const guestExe = `${GUEST_DIR}/Executor.app/${exe.split("/Executor.app/")[1]}`;
    const guestExecutor = `${GUEST_DIR}/Executor.app/${executor.split("/Executor.app/")[1]}`;
    const env = `HOME=${GUEST_HOME} EXECUTOR_DATA_DIR=${GUEST_HOME}/.executor`;

    // 1) the bundled daemon, supervised — the app attaches to this.
    await vm.ssh(
      `nohup env ${env} EXECUTOR_SUPERVISED=1 EXECUTOR_AUTH_TOKEN=desktop-macos-e2e EXECUTOR_CLIENT=desktop ` +
        `'${guestExecutor}' daemon run --foreground --port ${DAEMON_PORT} --hostname 127.0.0.1 ` +
        `>/tmp/executor-daemon.log 2>&1 &`,
    );
    if (!(await waitGuestHttp(vm, `http://127.0.0.1:${DAEMON_PORT}/`))) {
      throw new Error(
        "supervised daemon never came up in the guest (see /tmp/executor-daemon.log)",
      );
    }

    // 2) the packaged app, launched INTO the Aqua session with CDP enabled.
    await vm.ssh(
      `U=$(id -u); sudo launchctl asuser $U bash -lc ` +
        `'nohup env HOME=${GUEST_HOME} "${guestExe}" --remote-debugging-port=${CDP_GUEST_PORT} --remote-allow-origins="*" ` +
        `>/tmp/executor-app.log 2>&1 &'`,
    );
    if (!(await waitGuestPageTarget(vm, CDP_GUEST_PORT))) {
      const log = (await vm.ssh("tail -40 /tmp/executor-app.log 2>/dev/null").catch(() => null))
        ?.stdout;
      throw new Error(`the app's CDP page target never appeared:\n${log ?? "(no app log)"}`);
    }

    return { ip: vm.host, teardown: async () => void (await vm.discard()) };
  } catch (error) {
    await vm.discard();
    throw error;
  }
};

export default (): Promise<(() => Promise<void>) | void> => attachOrProvision(provisionMac);
