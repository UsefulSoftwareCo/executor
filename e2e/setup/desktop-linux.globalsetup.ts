// desktop-linux: bring the PACKAGED app up inside a Linux guest and forward its
// CDP port (the shared attach/forward lives in ./desktop-vm). No window server,
// so the app renders into an Xvfb virtual display; ffmpeg x11grab (in the
// scenario's recorder) films that display. Simpler than macOS: no Aqua, no
// codesign, no launchctl — just background processes with DISPLAY set and
// --no-sandbox (the chrome-sandbox needs setuid root, pointless on a throwaway
// guest). The base image (executor-linux-base) carries Xvfb + ffmpeg + the
// electron runtime libs.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";

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
const GUEST_DIR = "/home/admin/exe";
const GUEST_HOME = "/home/admin/exe-home";
const DISPLAY = ":99";

const appDir = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const hostBundle = () => {
  // electron-builder names the dir `linux-<arch>-unpacked` for non-x64.
  const dir = join(appDir, "dist", "linux-arm64-unpacked");
  return {
    dir,
    exe: join(dir, "executor-desktop"),
    executor: join(dir, "resources/executor/executor"),
  };
};

/** Build the packaged linux-arm64 bundle if it isn't on disk. The `executor`
 * binary is cross-compiled here via BUN_TARGET (same as the cli-linux lane);
 * electron-builder's `dir` target assembles the unpacked app on macOS without
 * Docker. */
const ensureBundle = (): void => {
  if (existsSync(hostBundle().dir)) return;
  const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
    execFileSync(cmd, args, { cwd: appDir, stdio: "inherit", env: { ...process.env, ...env } });
  run("bun", ["./scripts/build-sidecar.ts"], { BUN_TARGET: "bun-linux-arm64" });
  run("bunx", ["--bun", "electron-vite", "build"]);
  run(
    "bunx",
    [
      "--bun",
      "electron-builder",
      "--config",
      "electron-builder.e2e.config.ts",
      "--linux",
      "--arm64",
    ],
    { CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  );
};

const provisionLinux = async (): Promise<ProvisionedGuest> => {
  ensureBundle();
  const { dir } = hostBundle();
  const vm = await tartVm("linux", "arm64").provision();
  try {
    await vm.ssh(`rm -rf ${GUEST_DIR} ${GUEST_HOME}; mkdir -p ${GUEST_HOME}/.executor`);
    await pushDirAsTar(vm.host, dir, GUEST_DIR);

    const guestApp = `${GUEST_DIR}/${basename(dir)}`;
    const guestExe = `${guestApp}/executor-desktop`;
    const guestExecutor = `${guestApp}/resources/executor/executor`;
    await vm.ssh(`chmod +x '${guestExe}' '${guestExecutor}' 2>/dev/null || true`);
    const env = `HOME=${GUEST_HOME} EXECUTOR_DATA_DIR=${GUEST_HOME}/.executor`;

    // A virtual display + a minimal WM (openbox) — without a window manager the
    // electron window doesn't map onto the framebuffer that x11grab records.
    await vm.ssh(
      `pkill Xvfb 2>/dev/null; pkill openbox 2>/dev/null; ` +
        `nohup Xvfb ${DISPLAY} -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 & sleep 2; ` +
        `DISPLAY=${DISPLAY} nohup openbox >/tmp/openbox.log 2>&1 & sleep 1; echo up`,
    );

    // 1) the bundled daemon, supervised — the app attaches to this.
    await vm.ssh(
      `nohup env ${env} EXECUTOR_SUPERVISED=1 EXECUTOR_AUTH_TOKEN=desktop-linux-e2e EXECUTOR_CLIENT=desktop ` +
        `'${guestExecutor}' daemon run --foreground --port ${DAEMON_PORT} --hostname 127.0.0.1 ` +
        `>/tmp/executor-daemon.log 2>&1 &`,
    );
    if (!(await waitGuestHttp(vm, `http://127.0.0.1:${DAEMON_PORT}/`))) {
      throw new Error(
        "supervised daemon never came up in the guest (see /tmp/executor-daemon.log)",
      );
    }

    // 2) the packaged app on the virtual display, with CDP enabled.
    await vm.ssh(
      `nohup env ${env} DISPLAY=${DISPLAY} '${guestExe}' --no-sandbox ` +
        `--remote-debugging-port=${CDP_GUEST_PORT} --remote-allow-origins='*' ` +
        `>/tmp/executor-app.log 2>&1 &`,
    );
    if (!(await waitGuestPageTarget(vm, CDP_GUEST_PORT))) {
      const log = (await vm.ssh("tail -40 /tmp/executor-app.log 2>/dev/null").catch(() => null))
        ?.stdout;
      throw new Error(`the app's CDP page target never appeared:\n${log ?? "(no app log)"}`);
    }

    // The electron window maps tiny (10x10) under Xvfb; size it to the screen so
    // the x11grab recording captures the full console (CDP screenshots the
    // renderer surface regardless, but the film grabs the X framebuffer).
    await vm.ssh(
      `WID=$(DISPLAY=${DISPLAY} xdotool search --name executor-desktop | head -1); ` +
        `[ -n "$WID" ] && DISPLAY=${DISPLAY} xdotool windowsize "$WID" 1280 800 windowmove "$WID" 0 0 || true`,
    );

    return { ip: vm.host, teardown: async () => void (await vm.discard()) };
  } catch (error) {
    await vm.discard();
    throw error;
  }
};

export default (): Promise<(() => Promise<void>) | void> => attachOrProvision(provisionLinux);
