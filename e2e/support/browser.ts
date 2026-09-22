/** Promise APIs are confined to this driver adapter; Effect owns browser and context scopes. */
import { chromium, type Browser as NativeBrowser, type Page } from "playwright";
import {
  Cause,
  Clock,
  Console,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Redacted,
  Result,
} from "effect";
import { Target, driver, type DriverFailed } from "./platform.ts";
import { Evidence } from "./evidence.ts";
import type { Session } from "./api.ts";
import { RecordingFocus } from "./recording-focus.ts";
import { captureUIObservations } from "./ui-observation.ts";

const launchBrowser = (purpose: "capture" | "render") =>
  Effect.gen(function* () {
    const target = yield* Target;
    return yield* Effect.acquireRelease(
      driver("launch browser", () =>
        chromium.launch({
          headless: !target.metadata.interactive,
          slowMo: purpose === "capture" ? target.recordingPaceMs : 0,
        }),
      ),
      (browser) => driver("close browser", () => browser.close()).pipe(Effect.orDie),
    );
  });

/** Suite-scoped Playwright process injected into browser and recording services. */
export class BrowserDriver extends Context.Service<BrowserDriver, NativeBrowser>()(
  "e2e/BrowserDriver",
) {
  /** Rendering is never paced, even when the source recording was captured slowly. */
  static readonly layer = Layer.effect(BrowserDriver, launchBrowser("render"));
  /** Instrument individual actions, including several actions inside one use call. */
  static readonly captureLayer = Layer.effect(BrowserDriver, launchBrowser("capture"));
}
/** A case-scoped browser with captured steps and a single isolated context. */
export class Browser extends Context.Service<
  Browser,
  {
    readonly use: <A>(
      label: string,
      action: (page: Page) => Promise<A>,
    ) => Effect.Effect<A, DriverFailed>;
    readonly login: (session: Session) => Effect.Effect<void, DriverFailed>;
    readonly checkpoint: (name: string) => Effect.Effect<void, DriverFailed>;
    /** Discard network traces before OAuth; videos and screenshots still capture the UI. */
    readonly omitNetworkTrace: Effect.Effect<void, DriverFailed>;
  }
>()("e2e/Browser") {
  static readonly layer = Layer.effect(
    Browser,
    Effect.gen(function* () {
      const browser = yield* BrowserDriver,
        target = yield* Target,
        evidence = yield* Evidence,
        recording = yield* RecordingFocus,
        fs = yield* FileSystem.FileSystem;
      const clock = yield* Clock.Clock;
      const scope = yield* Effect.scope;
      const navigations: { at: string; url: string; elapsedMs: number; page: number }[] = [];
      const traceIds = new Set<string>();
      const failureReads: Promise<void>[] = [];
      const failedResources: {
        url: string;
        kind: string;
        status?: number;
        error?: string;
        site?: string;
        mode?: string;
        appCookie?: boolean;
        originMatches?: boolean;
      }[] = [];
      let page: Page | undefined;
      let tracing = true;
      const context = yield* driver("create browser context", () =>
        browser.newContext({
          baseURL: target.metadata.origin,
          viewport: { width: 1440, height: 960 },
          recordVideo: { dir: `${evidence.directory}/raw`, size: { width: 1440, height: 960 } },
        }),
      );
      // Register cleanup immediately, before trace/page setup can fail.
      yield* Effect.addFinalizer((exit) =>
        Effect.gen(function* () {
          if (page && Exit.isFailure(exit)) {
            const failedPage = page;
            if (target.metadata.interactive && !Cause.hasInterrupts(exit.cause)) {
              yield* evidence.intervention("Paused at failure");
              yield* driver("pause failed browser", () => failedPage.pause()).pipe(
                Effect.interruptible,
                Effect.ignore,
              );
            }
            const screenshot = yield* driver("failure screenshot", () =>
              failedPage.screenshot(),
            ).pipe(Effect.result);
            if (Result.isSuccess(screenshot))
              yield* evidence.attach("failure.png", "image/png", screenshot.success);
          }
          if (tracing) {
            yield* driver("save browser trace", () =>
              context.tracing.stop({ path: `${evidence.directory}/trace.zip` }),
            ).pipe(Effect.orDie);
            yield* evidence.artifact("Playwright trace", "application/zip", "trace.zip");
          }
          const video = page?.video();
          yield* driver("close browser context", () => context.close()).pipe(Effect.orDie);
          yield* driver("collect sanitized resource failures", () =>
            Promise.all(failureReads),
          ).pipe(Effect.orDie);
          if (video) {
            const source = yield* driver("resolve recording", () => video.path()).pipe(
              Effect.orDie,
            );
            yield* fs.copyFile(source, `${evidence.directory}/raw.webm`).pipe(Effect.orDie);
            yield* evidence.artifact("Browser recording", "video/webm", "raw.webm");
          }
          yield* evidence.json("navigation.json", navigations);
          yield* evidence.json("failed-resources.json", failedResources);
          for (const id of traceIds) yield* evidence.browserTrace(id);
        }),
      );
      yield* driver("start browser trace", () =>
        context.tracing.start({ screenshots: true, snapshots: true, sources: true }),
      );
      const getPage = yield* Effect.cached(
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          page = yield* driver("open browser page", () => context.newPage());
          const current = page;
          const capture = yield* captureUIObservations(current, evidence, scope, target);
          const focus = yield* recording.open({
            kind: "browser",
            title: "Browser",
            file: "recording.mp4",
            startedAtMs: started,
          });
          current.setDefaultTimeout(15000);
          current.setDefaultNavigationTimeout(30000);
          current.on("framenavigated", (frame) => {
            if (frame === current.mainFrame()) {
              const url = new URL(frame.url());
              const now = clock.currentTimeMillisUnsafe();
              navigations.push({
                at: new Date(now).toISOString(),
                url: `${url.origin}${url.pathname}`,
                elapsedMs: now - started,
                page: 0,
              });
            }
          });
          current.on("request", (request) => {
            const id = request.headers()["traceparent"]?.split("-")[1];
            if (id && /^[a-f0-9]{32}$/.test(id)) traceIds.add(id);
          });
          // Retain safe failure evidence even when OAuth requires discarding the network trace.
          current.on("response", (response) => {
            const kind = response.request().resourceType();
            const status = response.status();
            if (
              status < 400 &&
              !(kind === "script" && response.headers()["content-type"]?.includes("text/html"))
            )
              return;
            const url = new URL(response.url());
            failureReads.push(
              response
                .request()
                .allHeaders()
                .then((headers) => {
                  failedResources.push({
                    url: `${url.origin}${url.pathname}`,
                    kind,
                    status,
                    site: headers["sec-fetch-site"] ?? "absent",
                    mode: headers["sec-fetch-mode"] ?? "absent",
                    appCookie: headers.cookie?.includes("__Host-executor_app=") === true,
                    originMatches: headers.origin === undefined || headers.origin === url.origin,
                  });
                })
                .catch(() => {
                  failedResources.push({ url: `${url.origin}${url.pathname}`, kind, status });
                }),
            );
          });
          current.on("requestfailed", (request) => {
            const url = new URL(request.url());
            const reason = request.failure()?.errorText;
            failedResources.push({
              url: `${url.origin}${url.pathname}`,
              kind: request.resourceType(),
              error:
                reason !== undefined && /^net::ERR_[A-Z_]+$/.test(reason)
                  ? reason
                  : "NETWORK_ERROR",
            });
          });
          return { page: current, focus, capture };
        }),
      );
      const use = <A>(label: string, action: (page: Page) => Promise<A>) =>
        evidence.step(
          label,
          Effect.flatMap(getPage, ({ page, focus, capture }) =>
            focus.use(
              label,
              driver(label, () => action(page)).pipe(Effect.tap(() => capture.settle)),
            ),
          ),
        );
      return Browser.of({
        use,
        omitNetworkTrace: Effect.gen(function* () {
          if (tracing) {
            yield* driver("discard credential-bearing browser trace", () => context.tracing.stop());
            tracing = false;
          }
        }),
        login: (session) =>
          Effect.gen(function* () {
            const { focus } = yield* getPage;
            yield* focus.use(
              "Set browser actor",
              Effect.gen(function* () {
                yield* driver("clear browser cookies", () => context.clearCookies());
                const cookies = yield* session.cookies;
                yield* driver("set actor session", () =>
                  context.addCookies([...Redacted.value(cookies)]),
                );
              }),
            );
          }),
        checkpoint: (name) =>
          Effect.gen(function* () {
            const { page, focus } = yield* getPage;
            yield* focus.use(
              name,
              Effect.gen(function* () {
                const screenshot = yield* driver("capture checkpoint", () => page.screenshot());
                yield* evidence.attach(
                  `checkpoint-${navigations.length}-${name.replace(/[^a-z0-9]/gi, "-")}.png`,
                  "image/png",
                  screenshot,
                );
                if (target.metadata.interactive) {
                  yield* evidence.intervention(name);
                  yield* Console.log(
                    `Paused: ${name}. Use the browser, then Resume in Playwright Inspector.`,
                  );
                  yield* driver("manual takeover", () => page.pause());
                }
              }),
            );
          }),
      });
    }),
  );
}
