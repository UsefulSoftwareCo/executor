// The packaged desktop app, running in a GUI guest, checking that a link inside
// a generated artifact opens in the user's real browser.
//
// On desktop the console runs artifact UI in a sandbox that can't open popups,
// so a clicked link is handed to the app, which calls window.open. Electron
// then sends plain link clicks out to the system browser instead of opening a
// window inside the app. The cloud e2e covers the click getting that far; this
// covers what happens next, which only a real Electron build can show.
//
// To check it without guessing whether "a browser opened", we point the link at
// a small HTTP server on the host and see who asks for it. If the system
// browser fetches it (its user-agent has no "Electron" in it) and the app
// didn't gain a new window, the link left the app like it should. An in-app
// window would fail on both counts.
import { writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";
import { CdpPage, guestSsh, pageWsUrl, recordGuestScreen, sleep } from "../src/vm/desktop";

const NAME = "Desktop (packaged, in a VM) · an artifact link opens in the system browser";
const cdpPort = process.env.E2E_DESKTOP_CDP_PORT;
const guestIp = process.env.E2E_DESKTOP_VM_IP;
const recSeconds = Number(process.env.E2E_DESKTOP_REC_SECONDS ?? "12");
const os: "macos" | "linux" | "windows" =
  process.env.E2E_TARGET === "desktop-windows"
    ? "windows"
    : process.env.E2E_TARGET === "desktop-linux"
      ? "linux"
      : "macos";

/** The host's address as seen from the guest. On both tart bridges the guest's
 *  default gateway is the host, so a link pointed here comes back to us when
 *  the guest's browser follows it. */
const hostAddressFromGuest = async (ip: string): Promise<string> => {
  const command =
    os === "linux"
      ? "ip route show default 2>/dev/null | awk '{print $3; exit}'"
      : "route -n get default 2>/dev/null | awk '/gateway/{print $2; exit}'";
  const { stdout } = await guestSsh(ip, command);
  return stdout.trim();
};

interface OpenProbe {
  readonly url: string;
  /** The user-agent of whoever fetched the link, or null if nobody did in time. */
  waitForOpen: (timeoutMs: number) => Promise<string | null>;
  close: () => void;
}

/** A small server the guest's browser hits if the link really left the app. */
const listenForOpen = async (hostAddress: string): Promise<OpenProbe> => {
  const path = "/opened-from-desktop";
  let seenUserAgent: string | null = null;
  let notify: ((ua: string) => void) | null = null;

  const server = http.createServer((req, res) => {
    if ((req.url ?? "").startsWith(path)) {
      seenUserAgent = String(req.headers["user-agent"] ?? "");
      notify?.(seenUserAgent);
      notify = null;
    }
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${hostAddress}:${port}${path}`,
    waitForOpen: (timeoutMs: number) =>
      new Promise<string | null>((resolve) => {
        if (seenUserAgent !== null) return resolve(seenUserAgent);
        notify = resolve;
        setTimeout(() => {
          notify = null;
          resolve(seenUserAgent);
        }, timeoutMs);
      }),
    close: () => server.close(),
  };
};

/** How many pages the app has open right now — a new in-app window bumps this. */
const pageTargetCount = async (): Promise<number> => {
  const targets = (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])) as ReadonlyArray<{ type: string }>;
  return targets.filter((t) => t.type === "page").length;
};

const run = async (runDir: string) => {
  const cdp = await CdpPage.connect(await pageWsUrl(Number(cdpPort)));
  try {
    await cdp.command("Runtime.enable");
    await cdp.command("Page.enable");

    // Film the guest while we drive it, so the recording shows the browser
    // coming to the front when the link opens.
    const recording = recordGuestScreen(
      guestIp as string,
      recSeconds,
      join(runDir, "session.mp4"),
      os,
    );

    // Wait for the console to load before we do anything with it.
    await cdp.waitForText("Integrations", 60_000).catch(() => cdp.waitForText("Settings", 60_000));

    const hostAddress = await hostAddressFromGuest(guestIp as string);
    expect(hostAddress, "the guest reported the host address it routes through").toMatch(
      /^\d+\.\d+\.\d+\.\d+$/,
    );

    const probe = await listenForOpen(hostAddress);
    try {
      const pagesBefore = await pageTargetCount();

      // The same call the console makes when a `target="_blank"` link is
      // clicked (see packages/react/src/api/shell-host.ts). We run it directly
      // here — the click-to-open path is already covered by the cloud e2e, and
      // what we care about on desktop is what Electron does with this call.
      await cdp.command("Runtime.evaluate", {
        expression: `window.open(${JSON.stringify(probe.url)}, "_blank", "noopener,noreferrer")`,
      });

      const fetcherUserAgent = await probe.waitForOpen(15_000);
      await sleep(1500);
      const pagesAfter = await pageTargetCount();

      writeFileSync(join(runDir, "01-link-opened-externally.png"), await cdp.screenshot());

      expect(fetcherUserAgent, "the desktop handed the link to the system browser").not.toBeNull();
      expect(
        fetcherUserAgent ?? "",
        "the OS browser fetched the link, not an in-app Electron window",
      ).not.toContain("Electron");
      expect(pagesAfter, "the app opened no in-app browser window for the link").toBe(pagesBefore);
    } finally {
      probe.close();
    }

    await recording;
  } finally {
    cdp.close();
  }
};

if (!cdpPort || !guestIp || os === "windows") {
  const why =
    os === "windows"
      ? "the host-listener probe needs the tart bridge; the Windows guest attaches over an SSH jump"
      : "needs a desktop guest — set E2E_DESKTOP_VM_IP or run the desktop-macos/desktop-linux project";
  it.skip(`${NAME} (${why})`, () => {});
} else {
  // Literal name (not NAME) so the run's test.ts review artifact captures it.
  scenario(
    "Desktop (packaged, in a VM) · an artifact link opens in the system browser",
    { timeout: 180_000 },
    Effect.gen(function* () {
      const runDir = yield* RunDir;
      yield* Effect.promise(() => run(runDir));
    }),
  );
}
