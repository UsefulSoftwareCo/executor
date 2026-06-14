// UPGRADE STRESS: `service install` must TAKE OVER a daemon that is already
// running (the upgrade path), not refuse and make the user hunt for a pid.
// Stage a predecessor daemon (executor daemon run, like an old install or a
// `executor web` a user left running), then `service install` the supervised
// daemon, and assert the predecessor was stopped and the supervised service now
// owns the canonical port — exactly one daemon. Exits non-zero if it did NOT
// take over (the pre-fix bug). Manual VM harness (real launchd); always
// discards the guest.
//
//   bun e2e/scripts/repro-upgrade-takeover.ts
import { tartVm } from "../src/vm/tart";

const t0 = Date.now();
const log = (m: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
const PORT = 4789;

const main = async () => {
  log("provisioning tart macos guest...");
  const vm = await tartVm("macos", "arm64").provision();
  log(`provisioned host=${vm.host}`);
  try {
    const dir = "~/ed";
    const exe = `${dir}/executor`;
    await vm.ssh(`rm -rf ${dir} && mkdir -p ${dir}`);
    log("pushing darwin CLI binary...");
    await vm.push("/tmp/wt-ops/apps/cli/dist/executor-darwin-arm64/bin/.", `${dir}/`);
    await vm.ssh(`chmod +x ${exe}; xattr -dr com.apple.quarantine ${dir} 2>/dev/null || true`);
    log(`version: ${(await vm.ssh(`${exe} --version`)).stdout.trim()}`);

    // 1) PREDECESSOR: a daemon the user already has running (manual daemon run).
    log("starting PREDECESSOR daemon (executor daemon run --foreground)...");
    await vm.ssh(
      `nohup ${exe} daemon run --foreground --port ${PORT} > /tmp/pre.log 2>&1 & echo started`,
    );
    let preReachable = false;
    for (let i = 0; i < 20; i++) {
      const h = await vm.ssh(
        `curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${PORT}/api/health`,
      );
      if (h.stdout.trim() === "200") {
        preReachable = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    log(`predecessor reachable: ${preReachable}`);
    const prePid = (
      await vm.ssh(`lsof -ti tcp:${PORT} -sTCP:LISTEN 2>/dev/null | head -1`)
    ).stdout.trim();
    log(`predecessor owns :${PORT} as pid ${prePid}`);

    // 2) UPGRADE: install the supervised service while the predecessor runs.
    log("running `executor service install` (the upgrade) WITH predecessor still running...");
    const install = await vm.ssh(`${exe} service install --port ${PORT} 2>&1`);
    log(`install exit=${install.code}\n${install.stdout.trim()}\n${install.stderr.trim()}`);

    // 3) OBSERVE for ~25s: does the supervised service take over, or flap?
    await new Promise((r) => setTimeout(r, 25000));
    const uid = (await vm.ssh("id -u")).stdout.trim();
    const print = await vm.ssh(
      `launchctl print gui/${uid}/sh.executor.daemon 2>/dev/null | grep -iE 'state|pid|last exit|runs' | head`,
    );
    log(`launchctl print:\n${print.stdout.trim() || "(service not found)"}`);
    const errlog = await vm.ssh(`tail -8 ~/.executor/logs/daemon.error.log 2>/dev/null`);
    log(`daemon.error.log tail:\n${errlog.stdout.trim() || "(empty)"}`);
    const ownerNow = (
      await vm.ssh(`lsof -ti tcp:${PORT} -sTCP:LISTEN 2>/dev/null | head -1`)
    ).stdout.trim();
    const procCount = (
      await vm.ssh(`pgrep -fl 'executor daemon run' 2>/dev/null | wc -l`)
    ).stdout.trim();
    const preAlive = (
      await vm.ssh(`kill -0 ${prePid} 2>/dev/null && echo alive || echo dead`)
    ).stdout.trim();
    log(
      `AFTER: :${PORT} owned by pid ${ownerNow} (predecessor was ${prePid}, now ${preAlive}); 'daemon run' procs=${procCount}`,
    );

    // The bug: predecessor still owns the port (no takeover), and either the
    // service errored or it's flapping / a 2nd daemon exists.
    const tookOver = ownerNow !== "" && ownerNow !== prePid && preAlive === "dead";
    if (tookOver) {
      log("RESULT=TOOK-OVER (predecessor stopped, supervised owns the port) — upgrade is clean");
    } else {
      log(
        "RESULT=NO-TAKEOVER (predecessor still owns the port / service did not replace it) — BUG",
      );
      throw new Error("service install did not take over the running predecessor");
    }
  } finally {
    log("discarding guest VM");
    await vm.discard();
    log("discarded");
  }
};

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("REPRO-ERROR", e);
    process.exit(1);
  });
