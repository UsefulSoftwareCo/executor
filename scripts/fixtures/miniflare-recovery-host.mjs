import { recoveryWorker } from "./workflow-recovery-worker.mjs";
import { Miniflare } from "miniflare";

const [storage, upstream] = process.argv.slice(2);
if (!storage || !upstream) throw new Error("Expected storage directory and upstream URL");

const runtime = new Miniflare({
  host: "127.0.0.1",
  port: 0,
  modules: true,
  compatibilityDate: "2026-07-30",
  workflowsPersist: storage,
  workflows: { PROBE: { name: "recovery-probe", className: "RecoveryProbe" } },
  bindings: { UPSTREAM: upstream },
  script: recoveryWorker,
});

try {
  console.log(JSON.stringify({ ready: String(await runtime.ready) }));
  await new Promise((resolve) => process.once("SIGTERM", resolve));
} finally {
  await runtime.dispose();
}
