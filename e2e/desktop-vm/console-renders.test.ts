// The PACKAGED desktop app, on camera, inside a GUI guest — driven over CDP from
// the host. ONE scenario shared by every desktop-<os> project (desktop-macos,
// desktop-linux): the same bundle and CDP driver, proving it renders on a guest
// OS and filming the actual console. The desktop-<os> globalsetup boots the
// guest, launches the app, forwards its --remote-debugging-port (E2E_DESKTOP_CDP_PORT)
// and publishes the guest IP; this scenario connects, drives, and records. The
// run lands in runs/<target>/ (its own per-OS bucket). Without a guest it skips
// honestly, like desktop-packaged without a display.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";
import { CdpPage, pageWsUrl, recordGuestScreen } from "../src/vm/desktop";

const NAME = "Desktop (packaged, in a VM) · the bundle renders its console";
const cdpPort = process.env.E2E_DESKTOP_CDP_PORT;
const guestIp = process.env.E2E_DESKTOP_VM_IP;
const recSeconds = Number(process.env.E2E_DESKTOP_REC_SECONDS ?? "12");
const os: "macos" | "linux" | "windows" =
  process.env.E2E_TARGET === "desktop-windows"
    ? "windows"
    : process.env.E2E_TARGET === "desktop-linux"
      ? "linux"
      : "macos";

const run = async (runDir: string) => {
  const cdp = await CdpPage.connect(await pageWsUrl(Number(cdpPort)));
  try {
    await cdp.command("Runtime.enable");
    await cdp.command("Page.enable");

    // Film the console while we drive it (OS-aware capture lands a playable mp4).
    const recording = recordGuestScreen(
      guestIp as string,
      recSeconds,
      join(runDir, "session.mp4"),
      os,
    );

    // Reaching the nav proves the packaged bundle booted and connected to its
    // daemon on this OS.
    await cdp.waitForText("Integrations", 60_000).catch(() => cdp.waitForText("Settings", 60_000));
    writeFileSync(join(runDir, "01-console-rendered.png"), await cdp.screenshot());

    const body = await cdp.command<{ result?: { value?: string } }>("Runtime.evaluate", {
      expression: "document.body.innerText",
      returnByValue: true,
    });
    expect(body.result?.value ?? "", "the packaged console rendered its nav").toContain(
      "Integrations",
    );

    await recording;
  } finally {
    cdp.close();
  }
};

if (!cdpPort || !guestIp) {
  it.skip(`${NAME} (needs a desktop guest — set E2E_DESKTOP_VM_IP or run the desktop-<os> project)`, () => {});
} else {
  // Literal name (not NAME) so the run's test.ts review artifact captures it.
  scenario(
    "Desktop (packaged, in a VM) · the bundle renders its console",
    { timeout: 180_000 },
    Effect.gen(function* () {
      const runDir = yield* RunDir;
      yield* Effect.promise(() => run(runDir));
    }),
  );
}
