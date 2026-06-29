// Regression for issue #1125: on the macOS desktop app the native traffic-light
// window controls are drawn over the frameless web content at
// trafficLightPosition {x:16,y:17} (apps/desktop/src/main/index.ts) — three
// 12px buttons with 20px center spacing, occupying x ∈ [16, 68].
//
// The original bug: the window minWidth was 720 but the web layout switches to
// the mobile header at the 768px breakpoint, so narrowing the window into the
// 720–767 band rendered the mobile hamburger (and, with the menu open, the
// "executor Beta" brand) at the far left, directly under the lights.
//
// The fix has two parts, both asserted here:
//   1. minWidth is now 768, so the desktop never drops into the mobile layout —
//      the lights only ever sit over the desktop sidebar header. This proves
//      the mobile hamburger bar is NOT present at the minimum width.
//   2. The sidebar header is offset 88px to clear the lights, and the macOS
//      sidebar is widened (.desktop-macos-sidebar) so the brand wordmark and
//      the server-connection menu both clear the lights without colliding.
//
// Launches the REAL Electron app via Playwright against a throwaway HOME (same
// harness as local-auth-mcp.test.ts). Captures via CDP page.screenshot:
//   - <state>-webview.png : the real, unmodified rendered content.
//   - <state>-overlap.png : the same view with the native macOS traffic lights
//                           drawn at their CONFIGURED position so the cleared
//                           gap is visible. (We draw them rather than
//                           screen-capture them because the e2e host is a
//                           GPU-less virtual framebuffer: macOS does not
//                           composite the window's native chrome onto the
//                           captured surface, so `screencapture` returns only
//                           wallpaper. CDP renderer screenshots are unaffected.)
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright";

import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";

const appDir = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const electronBinary = createRequire(join(appDir, "package.json"))("electron") as string;

// Rightmost edge of the traffic-light cluster (left edges 16/36/56, +12px) plus
// a small margin. Header content must start at or beyond this to clear them.
const TRAFFIC_LIGHTS_RIGHT = 72;
// The window minWidth: the narrowest the desktop window can get, and the worst
// case for fitting the sidebar header alongside the lights.
const MIN_WIDTH = 768;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const launchDesktop = async (home: string): Promise<ElectronApplication> =>
  _electron.launch({
    executablePath: electronBinary,
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, HOME: home },
    timeout: 120_000,
  });

// Draw the native macOS traffic lights at the app's configured
// trafficLightPosition. Faithful geometry: 12px buttons, 20px center spacing,
// group origin (16,17). Removed before each "real" capture so it stays
// unmodified, re-added for the "overlap" capture.
const TRAFFIC_LIGHTS_JS = `(() => {
  const host = document.createElement('div');
  host.id = '__repro_1125_trafficlights';
  host.style.cssText =
    'position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none';
  const dot = (left, color) => {
    const d = document.createElement('div');
    d.style.cssText =
      'position:absolute;width:12px;height:12px;border-radius:50%;top:17px;left:' +
      left + 'px;background:' + color + ';box-shadow:inset 0 0 0 0.5px rgba(0,0,0,.25)';
    return d;
  };
  host.appendChild(dot(16, '#FF5F57'));
  host.appendChild(dot(36, '#FEBC2E'));
  host.appendChild(dot(56, '#28C840'));
  document.body.appendChild(host);
})()`;

const REMOVE_LIGHTS_JS = `document.getElementById('__repro_1125_trafficlights')?.remove()`;

const captureBoth = async (page: Page, runDir: string, state: string) => {
  await page.evaluate(REMOVE_LIGHTS_JS);
  await page.screenshot({ path: join(runDir, `${state}-webview.png`) });
  await page.evaluate(TRAFFIC_LIGHTS_JS);
  await page.screenshot({ path: join(runDir, `${state}-overlap.png`) });
  await page.evaluate(REMOVE_LIGHTS_JS);
};

const box = async (locator: Locator, label: string) => {
  const b = await locator.boundingBox();
  expect(b, `${label}: has a bounding box`).not.toBeNull();
  return b!;
};

scenario(
  "Desktop · #1125 the desktop stays out of the mobile layout and the sidebar header clears the macOS traffic lights",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const runDir = yield* RunDir;
    yield* Effect.promise(() => run(runDir));
  }),
);

const run = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-repro-1125-"));
  const app = await launchDesktop(home);
  try {
    const page = await app.firstWindow({ timeout: 120_000 });
    await page.waitForLoadState("domcontentloaded");

    // The offset is gated on this class; without it the assertions below would
    // be meaningless, so prove it is active before trusting them.
    const isMacDesktop = await page.evaluate(() =>
      document.documentElement.classList.contains("executor-desktop-macos"),
    );
    expect(isMacDesktop, "renderer applied the macOS desktop class").toBe(true);

    // Try to shrink below the mobile breakpoint. The minWidth fix must clamp the
    // window at 768, so the desktop can never drop into the mobile layout. We ask
    // for 700 (the old reachable band) and assert it clamps up.
    const clampedWidth = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.setPosition(60, 40);
      win.setSize(700, 800);
      win.show();
      win.focus();
      return win.getSize()[0];
    });
    expect(
      clampedWidth,
      `window cannot shrink below the mobile breakpoint (clamped to ${clampedWidth}px)`,
    ).toBeGreaterThanOrEqual(MIN_WIDTH);

    const sidebar = page.locator("aside.desktop-macos-sidebar");
    await sidebar.waitFor({ timeout: 60_000 });
    await sleep(800);

    // Part 1: at the minimum width the mobile phone bar must NOT be shown, so
    // its hamburger can never land under the lights.
    const hamburgerVisible = await page
      .getByRole("button", { name: "Open navigation" })
      .isVisible();
    expect(hamburgerVisible, "mobile hamburger bar is hidden on the desktop at minimum width").toBe(
      false,
    );
    const sidebarVisible = await sidebar.isVisible();
    expect(sidebarVisible, "desktop sidebar is visible at minimum width").toBe(true);

    await captureBoth(page, runDir, "01-sidebar-header");

    // Part 2a: the brand wordmark clears the traffic-light cluster.
    const header = sidebar.locator(".desktop-macos-titlebar");
    const brand = await box(header.locator("a").first(), "sidebar brand");
    expect(
      Math.round(brand.x),
      `sidebar brand left edge (${Math.round(brand.x)}px) clears the lights (>= ${TRAFFIC_LIGHTS_RIGHT}px)`,
    ).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS_RIGHT);

    // Part 2b: the server-connection menu sits clear of the brand (no collision
    // with the "Beta" badge, the bug in the screenshot) and stays inside the
    // sidebar.
    const menu = await box(
      header.locator('button[aria-label^="Select Executor server"]'),
      "server-connection menu",
    );
    const asideBox = await box(sidebar, "sidebar");
    const gap = Math.round(menu.x - (brand.x + brand.width));
    expect(gap, `server menu does not overlap the brand (gap ${gap}px)`).toBeGreaterThanOrEqual(8);
    expect(
      Math.round(menu.x + menu.width),
      "server menu stays within the sidebar",
    ).toBeLessThanOrEqual(Math.round(asideBox.x + asideBox.width));
  } finally {
    await app.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
};
