// Packaged desktop, on camera: the REAL electron-builder bundle (app.isPackaged
// === true) attaches to an already-running OS-supervised daemon instead of
// spawning its own sidecar. This is the production-only path — dev electron skips
// ensureSupervisedConnection entirely and always spawns a desktop-sidecar, so the
// attach behavior can ONLY be proven against the packaged artifact.
//
// We start the daemon as the bundle's OWN compiled `executor` binary (the exact
// binary a supervised install runs) in EXECUTOR_SUPERVISED mode. It publishes a
// manifest of kind "cli-daemon". Then we launch the packaged app
// pointed at the same HOME and prove it attached: the manifest still names the
// daemon's pid (a spawned sidecar would rewrite it to "desktop-sidecar" with a
// fresh pid), and the console — served by the bearer-gated daemon — renders,
// which only happens if the app injected the bearer it read from the manifest.
// The recording (session.mp4 + screenshots) is the artifact; the waits assert.
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import {
  createPackagedDesktopHome,
  freePort,
  launchPackagedDesktop,
  packagedDesktopPreflight,
  removePackagedDesktopHome,
  startSupervisedDaemon,
  stopProcess,
  type PackagedDesktopApp,
} from "../src/desktop/packaged";
import { RunDir } from "../src/services";
import { waitForHttp } from "../setup/boot";

const SCENARIO_NAME = "Desktop (packaged) · the real bundle attaches to the OS-supervised daemon";

interface Manifest {
  readonly kind: string;
  readonly pid: number;
}

const desktopPreflight = packagedDesktopPreflight();

if (desktopPreflight.status === "skip") {
  it.skip(`${SCENARIO_NAME} (${desktopPreflight.reason})`, () => {});
} else if (desktopPreflight.status === "fail") {
  scenario(`${SCENARIO_NAME} preflight`, { timeout: 30_000 }, Effect.die(desktopPreflight.reason));
} else {
  scenario(
    SCENARIO_NAME,
    { timeout: 240_000 },
    Effect.gen(function* () {
      const runDir = yield* RunDir;
      yield* Effect.promise(() => run(runDir));
    }),
  );
}

const run = async (runDir: string) => {
  const home = createPackagedDesktopHome("executor-pkg-attach-");
  const dataDir = join(home, ".executor");
  const manifestPath = join(dataDir, "server-control", "server.json");
  const port = await freePort();

  let daemon: ChildProcess | undefined;
  let app: PackagedDesktopApp | undefined;
  let stepIndex = 0;

  try {
    const started = await startSupervisedDaemon({
      home,
      port,
      env: {
        EXECUTOR_SUPERVISED: "1",
        EXECUTOR_DATA_DIR: dataDir,
        EXECUTOR_AUTH_TOKEN: "packaged-attach-film",
        EXECUTOR_CLIENT: "desktop",
      },
    });
    daemon = started.child;
    expect(started.ready, `supervised daemon became ready; stderr:\n${started.stderr}`).toBe(true);
    await waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 30_000 });

    const daemonManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    expect(daemonManifest.kind, "the bundled executor advertises itself as cli-daemon").toBe(
      "cli-daemon",
    );
    const daemonPid = daemonManifest.pid;

    // Launch the PACKAGED bundle directly. `app.isPackaged` is true, so boot()
    // runs the supervised attach path; CDP drives the real renderer.
    const launched = await launchPackagedDesktop({ home });
    app = launched;
    const page = launched.cdp;
    const step = async (label: string, body: () => Promise<void>) => {
      await body();
      stepIndex += 1;
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      await launched.captureEvidence({
        rendererPath: join(runDir, `${String(stepIndex).padStart(2, "0")}-${slug}.png`),
      });
    };

    // The console only renders once the app has a live connection AND the bearer
    // it injects is accepted by the gated daemon — so reaching it proves both the
    // attach and the bearer wiring through the packaged session layer.
    await step("packaged app boots into the bearer-gated console", async () => {
      await page.waitForText("Settings", 120_000);
    });

    // Proof it ATTACHED, not spawned: the manifest is untouched — same pid, still
    // cli-daemon. A managed sidecar would have rewritten it to "desktop-sidecar".
    await step("server manifest still names the supervised daemon", async () => {
      const after = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      expect(after.kind, "still the supervised daemon (not a desktop sidecar)").toBe("cli-daemon");
      expect(after.pid, "the packaged app attached to our daemon, not a new sidecar").toBe(
        daemonPid,
      );
    });
  } finally {
    await app?.close();
    await stopProcess(daemon);
    removePackagedDesktopHome(home);
  }
};
