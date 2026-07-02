// Controlled, observable proof that the PACKAGED Linux desktop bundle attaches
// to an OS-supervised daemon — a manual harness (run by hand, not in the vitest
// matrix). Linux + Xvfb avoids the macOS Aqua-session limitation: the packaged
// Electron app runs headless under a virtual X server in a tart guest, so the
// attach path can be proven without a logged-in GUI session (which the
// desktop-packaged vitest project needs and skips without). Mirrors that test's
// intent, with a finally that always discards the VM.
//
//   bun e2e/scripts/verify-linux-desktop-attach.ts /tmp/linux-desktop-bundle.tgz
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { tartVm } from "../src/vm/tart";

const execFileP = promisify(execFile);
const t0 = Date.now();
const log = (m: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

const bundleTgz = process.argv[2] ?? "/tmp/linux-desktop-bundle.tgz";
// Ubuntu 24.04 (noble) renamed several libs to `…t64`; apt fails the whole
// transaction if ANY name is missing, so install each separately and list both
// the pre-noble and t64 names — only the available one installs.
const DEPS = [
  "xvfb",
  "libnss3",
  "libnspr4",
  "libatk1.0-0",
  "libatk1.0-0t64",
  "libatk-bridge2.0-0",
  "libatk-bridge2.0-0t64",
  "libcups2",
  "libcups2t64",
  "libdrm2",
  "libxkbcommon0",
  "libxcomposite1",
  "libxdamage1",
  "libxfixes3",
  "libxrandr2",
  "libgbm1",
  "libpango-1.0-0",
  "libcairo2",
  "libasound2",
  "libasound2t64",
  "libatspi2.0-0",
  "libatspi2.0-0t64",
  "libgtk-3-0",
  "libgtk-3-0t64",
];

const main = async () => {
  log("provisioning tart linux guest...");
  const vm = await tartVm("linux", "arm64").provision();
  log(`provisioned host=${vm.host}`);
  try {
    log("pushing packaged bundle tarball...");
    await execFileP("sshpass", [
      "-p",
      "admin",
      "scp",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      bundleTgz,
      `admin@${vm.host}:/tmp/app.tgz`,
    ]);
    log("extracting + installing Electron runtime deps (apt)...");
    await vm.ssh("mkdir -p /tmp/app && tar -xzf /tmp/app.tgz -C /tmp/app");
    await vm.ssh("sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq");
    // Install each package independently so one missing name (noble t64 rename)
    // doesn't fail the whole transaction.
    const apt = await vm.ssh(
      `for p in ${DEPS.join(" ")}; do sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $p >/dev/null 2>&1 && echo "ok $p" || echo "skip $p"; done`,
    );
    log(`apt:\n${apt.stdout.trim()}`);
    const nss = await vm.ssh("ldconfig -p | grep -c libnss3 || true");
    log(`libnss3 present: ${nss.stdout.trim()}`);

    const home = "/tmp/eh";
    const exe = "/tmp/app/executor-desktop";
    const sidecar = "/tmp/app/resources/sidecar/executor-sidecar";
    const webui = "/tmp/app/resources/web-ui";

    log("starting bundled sidecar as supervised daemon...");
    await vm.ssh(
      `rm -rf ${home}; mkdir -p ${home}; nohup env HOME=${home} EXECUTOR_SUPERVISED=1 EXECUTOR_DATA_DIR=${home}/.executor EXECUTOR_PORT=4789 EXECUTOR_HOST=127.0.0.1 EXECUTOR_AUTH_TOKEN=linux-attach EXECUTOR_CLIENT_DIR=${webui} ${sidecar} > /tmp/daemon.log 2>&1 &`,
    );
    // Wait for the daemon to publish its manifest + serve.
    for (let i = 0; i < 30; i++) {
      const r = await vm.ssh(`cat ${home}/.executor/server-control/server.json 2>/dev/null`);
      if (r.stdout.includes("cli-daemon")) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    const before = (await vm.ssh(`cat ${home}/.executor/server-control/server.json`)).stdout.trim();
    const beforeManifest = JSON.parse(before) as { kind: string; pid: number };
    log(`daemon manifest: kind=${beforeManifest.kind} pid=${beforeManifest.pid}`);
    if (beforeManifest.kind !== "cli-daemon") throw new Error("daemon did not publish cli-daemon");
    const health = await vm.ssh(
      `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4789/api/health`,
    );
    log(`/api/health = ${health.stdout.trim()}`);

    log("launching PACKAGED app under Xvfb...");
    await vm.ssh(
      `nohup xvfb-run -a env HOME=${home} ELECTRON_ENABLE_LOGGING=1 ${exe} --no-sandbox > /tmp/app.log 2>&1 &`,
    );

    // Positive attach signal: the main process logs "attaching to supervised
    // daemon" (sidecar.ts) — proves the attach CODE ran and succeeded, not just
    // "the manifest is unchanged" (which a crash would also leave).
    let attached = false;
    for (let i = 0; i < 40; i++) {
      const logs = await vm.ssh(
        `cat /tmp/app.log ${home}/.config/Executor/logs/main.log 2>/dev/null`,
      );
      if (/attaching to supervised daemon/i.test(logs.stdout)) {
        attached = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    const appLog = (await vm.ssh(`tail -40 /tmp/app.log 2>/dev/null`)).stdout.trim();
    log(`app.log tail:\n${appLog}`);

    const after = (await vm.ssh(`cat ${home}/.executor/server-control/server.json`)).stdout.trim();
    const afterManifest = JSON.parse(after) as { kind: string; pid: number };
    log(`manifest after app launch: kind=${afterManifest.kind} pid=${afterManifest.pid}`);

    if (!attached) {
      throw new Error("no 'attaching to supervised daemon' log — app did not attach (see app.log)");
    }
    if (afterManifest.kind !== "cli-daemon" || afterManifest.pid !== beforeManifest.pid) {
      throw new Error(
        `manifest changed (kind=${afterManifest.kind} pid=${afterManifest.pid}) — app spawned its own sidecar instead of attaching`,
      );
    }
    log("RESULT=PASS — packaged Linux app attached to the supervised daemon (Xvfb)");
  } finally {
    log("discarding guest VM");
    await vm.discard();
    log("discarded");
  }
};

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("RESULT=FAIL", e);
    process.exit(1);
  });
