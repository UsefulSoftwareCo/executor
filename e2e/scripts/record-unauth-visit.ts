// One-off recorder for the unauth-skeleton before/after comparison.
//
// Drives a SIGNED-OUT visit to the cloud root against a running stack,
// holding /api/account/me open long enough that the loading window is
// visible, and saves the session video.
//
// Usage: bun e2e/scripts/record-unauth-visit.ts <base-url> <out.mp4>
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";

const [baseUrl, outPath] = process.argv.slice(2);
if (!baseUrl || !outPath) {
  console.error("usage: bun e2e/scripts/record-unauth-visit.ts <base-url> <out.mp4>");
  process.exit(1);
}

const videoTmp = mkdtempSync(join(tmpdir(), "unauth-visit-"));
const browser = await chromium.launch();
const context = await browser.newContext({
  colorScheme: "dark",
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: videoTmp, size: { width: 1280, height: 800 } },
  baseURL: baseUrl,
});
const page = await context.newPage();

// Hold the auth probe open — this is the window where the wrong UI flashes
// (or, after the fix, where the right UI is already painted).
await page.route("**/api/account/me", async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  await route.continue();
});

// A beat of blank page so the navigation moment is visible in the recording.
await page.goto("about:blank");
await page.waitForTimeout(700);
await page.goto("/", { waitUntil: "commit" });
// Cover the probe window plus the settle, whatever this stack renders.
await page.waitForTimeout(4_500);

await context.close();
const video = readdirSync(videoTmp).find((file) => file.endsWith(".webm"));
if (!video) throw new Error("no video produced");
copyFileSync(join(videoTmp, video), outPath);
rmSync(videoTmp, { recursive: true, force: true });
await browser.close();
console.log(`recorded ${outPath}`);
