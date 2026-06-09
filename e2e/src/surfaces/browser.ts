// Browser surface: Playwright over the target's real web UI, dark mode, with
// evidence built in — every step() lands in the transcript with a screenshot,
// the whole session is captured on video (steps carry their time-slice into
// it), and a failure freezes the scene with a final screenshot. The scenario
// drives `page` directly; the wrapper only owns evidence + identity injection.
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";
import { chromium, type Page } from "playwright";

import type { Recorder } from "../recorder";
import { slugify } from "../schema";
import type { Identity, Target } from "../target";

export interface BrowserSession {
  readonly page: Page;
  /** Perform one user-visible step; records label + screenshot + video slice. */
  readonly step: (label: string, action: (page: Page) => Promise<void>) => Promise<void>;
}

export interface BrowserSurface {
  readonly session: (
    identity: Identity,
    drive: (session: BrowserSession) => Promise<void>,
  ) => Effect.Effect<void>;
}

// acquireUseRelease so a vitest timeout (fiber interruption) still closes the
// browser and flushes the video — a bare promise would leak headless Chromium.
export const makeBrowserSurface = (rec: Recorder, target: Target): BrowserSurface => ({
  session: (identity, drive) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        // Recorded as webm by Playwright, transcoded to h264 mp4 on close —
        // mp4 plays everywhere (Safari/iOS don't do webm).
        const videoArtifact = rec.artifact("session.mp4");
        const videoTmp = join(rec.dir, ".video-tmp");
        mkdirSync(videoTmp, { recursive: true });

        const browser = await chromium.launch();
        const context = await browser.newContext({
          colorScheme: "dark",
          viewport: { width: 1280, height: 800 },
          recordVideo: { dir: videoTmp, size: { width: 1280, height: 800 } },
          baseURL: target.baseUrl,
        });
        if (identity.cookies?.length) {
          await context.addCookies(
            identity.cookies.map((cookie) => ({ ...cookie, url: target.baseUrl })),
          );
        }
        const page = await context.newPage();
        return { browser, context, page, videoArtifact, videoTmp, sessionStart: Date.now() };
      }),
      ({ page, videoArtifact, sessionStart }) =>
        Effect.promise(async () => {
          rec.step("browser", `Opened ${target.baseUrl} as ${identity.label} (dark, 1280×800)`);
          const step = async (label: string, action: (page: Page) => Promise<void>) => {
            const startMs = Date.now() - sessionStart;
            await action(page);
            const shot = rec.artifact(`${slugify(label)}.png`);
            await page.screenshot({ path: shot.abs });
            rec.step("browser", label, [
              { kind: "screenshot", path: shot.rel, label },
              { kind: "video", path: videoArtifact.rel, startMs, endMs: Date.now() - sessionStart },
            ]);
          };
          try {
            await drive({ page, step });
          } catch (error) {
            // Freeze the scene: the viewer shows what it looked like when it broke.
            const shot = rec.artifact("failure.png");
            await page.screenshot({ path: shot.abs }).catch(() => {});
            rec.error(`browser: ${error instanceof Error ? error.message : String(error)}`, [
              { kind: "screenshot", path: shot.rel, label: "at failure" },
            ]);
            throw error;
          }
        }),
      ({ browser, context, page, videoArtifact, videoTmp }) =>
        Effect.promise(async () => {
          const video = page.video();
          await context.close(); // flushes the recording
          await browser.close();
          const recordedPath = await video?.path().catch(() => undefined);
          let finalPath = videoArtifact.rel;
          if (recordedPath) {
            try {
              await promisify(execFile)("ffmpeg", [
                "-y",
                "-i",
                recordedPath,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "26",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                videoArtifact.abs,
              ]);
            } catch {
              // No ffmpeg → keep the raw webm rather than dropping the evidence.
              finalPath = videoArtifact.rel.replace(/\.mp4$/, ".webm");
              copyFileSync(recordedPath, join(rec.dir, finalPath));
            }
          }
          rmSync(videoTmp, { recursive: true, force: true });
          rec.step("browser", "Full session recording", [{ kind: "video", path: finalPath }]);
        }),
    ),
});
