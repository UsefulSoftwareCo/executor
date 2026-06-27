// Browser surface: Playwright over the target's real web UI, dark mode, with
// the standard debugging artifacts — a Playwright trace (time-travel DOM,
// network, console), the session video (transcoded to mp4 so it plays
// everywhere), per-step screenshots, and a failure screenshot. The scenario
// drives `page` directly; assertions are vitest's job.
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";
import { chromium, type Page } from "playwright";

import { beat, enterFocus, markNavigation, markRecordingStart } from "../timeline";
import { appendTraces, type TraceEntry } from "../trace-harvest";
import type { Identity, Target } from "../target";

export interface BrowserSession {
  readonly page: Page;
  /** Perform one user-visible step; names the trace group + saves a screenshot. */
  readonly step: (label: string, action: (page: Page) => Promise<void>) => Promise<void>;
}

export interface BrowserSurface {
  readonly session: (
    identity: Identity,
    drive: (session: BrowserSession) => Promise<void>,
  ) => Effect.Effect<void>;
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

// acquireUseRelease so a vitest timeout (fiber interruption) still closes the
// browser and flushes video + trace — a bare promise would leak Chromium.
export const makeBrowserSurface = (dir: string, target: Target): BrowserSurface => ({
  session: (identity, drive) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const videoTmp = join(dir, ".video-tmp");
        mkdirSync(videoTmp, { recursive: true });

        // Watchable mode (E2E_FILM / E2E_DESK): slow each Playwright action so
        // the recording is readable instead of flickering through states at
        // machine speed. Off by default — normal CI runs stay fast.
        const watchable = process.env.E2E_FILM === "1" || process.env.E2E_DESK === "1";
        const slowMo = watchable ? 400 : undefined;
        // On the desk (E2E_DESK), the browser is a real headed window on the
        // virtual display — the desk's single screen recording films it next
        // to the chat terminal, exactly like a developer tabbing over.
        const browser = await chromium.launch(
          process.env.E2E_DESK === "1"
            ? {
                headless: false,
                args: ["--window-position=300,40", "--window-size=1100,830"],
                slowMo,
              }
            : slowMo
              ? { slowMo }
              : {},
        );
        // Cloudflare Access adds its signed assertion as an origin-facing
        // header. Browser identities carry that header directly in hermetic
        // runs. Cookie headers remain handled by addCookies below because
        // Chromium owns the Cookie header.
        const identityHeaders = Object.fromEntries(
          Object.entries(identity.headers ?? {}).filter(
            ([name]) => name.toLowerCase() !== "cookie",
          ),
        );
        const context = await browser.newContext({
          colorScheme: "dark",
          viewport: { width: 1280, height: 800 },
          recordVideo: { dir: videoTmp, size: { width: 1280, height: 800 } },
          baseURL: target.baseUrl,
        });
        if (Object.keys(identityHeaders).length > 0) {
          const targetOrigin = new URL(target.baseUrl).origin;
          await context.route(`${targetOrigin}/**`, (route) =>
            route.continue({
              headers: { ...route.request().headers(), ...identityHeaders },
            }),
          );
        }
        await context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true,
        });
        if (identity.cookies?.length) {
          await context.addCookies(
            identity.cookies.map((cookie) => ({
              ...cookie,
              url: target.baseUrl,
            })),
          );
        }
        const page = await context.newPage();
        // The session video's clock starts with the page; anchor it for the
        // run's focus timeline (scripts/film.ts cuts on these).
        markRecordingStart(dir, "browser");
        // Main-frame navigations feed the viewer's synthetic URL bar — the
        // recording itself is chromeless, so this is the only place the
        // address the developer "typed" survives.
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) markNavigation(dir, frame.url());
        });
        // Harvest distributed-trace ids: every app API request carries a W3C
        // traceparent (Effect's HttpClient), and each id names one
        // click→server→DB trace in whatever OTLP store the run exported to
        // (motel locally). Appended to traces.json (shared with the MCP
        // surface's terminal-side entries) so the runs viewer can link a
        // recording to its traces. Duration comes from the finished/failed
        // event so the viewer can answer "why did that take so long"
        // without leaving the run page.
        const traceIds: Array<TraceEntry & { ms?: number; status?: number }> = [];
        const inflight = new Map<unknown, (typeof traceIds)[number]>();
        page.on("request", (request) => {
          const traceparent = request.headers()["traceparent"];
          const match = traceparent ? /^[0-9a-f]{2}-([0-9a-f]{32})-/.exec(traceparent) : null;
          if (match?.[1]) {
            const entry: (typeof traceIds)[number] = {
              id: match[1],
              at: Date.now(),
              url: request.url(),
              source: "browser",
            };
            traceIds.push(entry);
            inflight.set(request, entry);
          }
        });
        page.on("requestfinished", async (request) => {
          const entry = inflight.get(request);
          if (!entry) return;
          inflight.delete(request);
          entry.ms = Date.now() - entry.at;
          entry.status = (await request.response().catch(() => null))?.status();
        });
        page.on("requestfailed", (request) => {
          const entry = inflight.get(request);
          if (!entry) return;
          inflight.delete(request);
          entry.ms = Date.now() - entry.at;
        });
        return {
          browser,
          context,
          page,
          videoTmp,
          shots: { count: 0 },
          traceIds,
        };
      }),
      ({ page, context, shots }) =>
        Effect.promise(async () => {
          const step = async (label: string, action: (page: Page) => Promise<void>) => {
            // Acting on the page IS focusing the browser window — and when
            // filming, enterFocus lingers a beat on whatever the developer was
            // looking at before tabbing here.
            await enterFocus(dir, "browser");
            await context.tracing.group(label);
            try {
              await action(page);
            } finally {
              await context.tracing.groupEnd();
            }
            await page.screenshot({
              path: join(dir, `${String(shots.count++).padStart(2, "0")}-${slug(label)}.png`),
            });
            // Hold this step's result on screen so the film is readable (the
            // consent screen, the success page, …). No-op unless filming.
            await beat();
          };
          try {
            await drive({ page, step });
          } catch (error) {
            // Freeze the scene: the artifact dir shows the screen at failure.
            await page.screenshot({ path: join(dir, "failure.png") }).catch(() => {});
            throw error;
          }
        }),
      ({ browser, context, page, videoTmp, traceIds }) =>
        Effect.promise(async () => {
          appendTraces(dir, traceIds);
          await context.tracing.stop({ path: join(dir, "trace.zip") }).catch(() => {});
          const video = page.video();
          await context.close(); // flushes the recording
          await browser.close();
          const recordedPath = await video?.path().catch(() => undefined);
          if (recordedPath) {
            try {
              // mp4 plays everywhere (Safari/iOS don't do webm).
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
                join(dir, "session.mp4"),
              ]);
            } catch {
              copyFileSync(recordedPath, join(dir, "session.webm"));
            }
          }
          rmSync(videoTmp, { recursive: true, force: true });
        }),
    ),
});
