/**
 * Browser timing through Playwright's Chromium. An interaction is complete when every same-origin
 * request it started (document, assets, API) has finished and the page has been quiet for 300 ms.
 * Telemetry uploads and the analytics proxy are excluded. The measured duration ends at the last
 * such response (or at the URL change when nothing was fetched), not at the end of the quiet window.
 */
import { Effect } from "effect";
import { chromium, type Browser, type Page, type Request } from "playwright";
import type { BrowserCookies } from "../../sdk/contracts.ts";
import { PerfRequestFailed, serverTiming } from "./client.ts";

export interface UiTiming {
  readonly ms: number;
  readonly requests: number;
  readonly apiRequests: number;
  readonly maxServerMs: number | undefined;
  readonly slowestTraceId: string | undefined;
  readonly failed: number;
}

const ignored = (url: URL) =>
  url.pathname.startsWith("/api/telemetry") || /^\/api\/[a-f0-9]{16}\//.test(url.pathname);

export const openBrowser = (origin: string, cookies: BrowserCookies) =>
  Effect.gen(function* () {
    const browser: Browser = yield* Effect.tryPromise({
      try: () => chromium.launch(),
      catch: () =>
        new PerfRequestFailed({ operation: "browser", detail: "Chromium did not start" }),
    });
    const context = yield* Effect.tryPromise({
      try: () =>
        browser
          .newContext({ baseURL: origin, viewport: { width: 1440, height: 900 } })
          .then((created) => created.addCookies([...cookies]).then(() => created)),
      catch: () => new PerfRequestFailed({ operation: "browser", detail: "context setup failed" }),
    });
    const page: Page = yield* Effect.tryPromise({
      try: () => context.newPage(),
      catch: () => new PerfRequestFailed({ operation: "browser", detail: "page failed" }),
    });
    const inflight = new Map<Request, number>();
    let lastEnd = 0,
      tracked: {
        count: number;
        api: number;
        failed: number;
        maxServer?: number;
        slowest?: { ms: number; trace: string | undefined };
      } = { count: 0, api: 0, failed: 0 };
    const relevant = (request: Request) => {
      const url = URL.parse(request.url());
      return url !== null && url.origin === origin && !ignored(url);
    };
    page.on("request", (request) => {
      if (!relevant(request)) return;
      inflight.set(request, performance.now());
      tracked.count++;
      if (new URL(request.url()).pathname.startsWith("/api/")) tracked.api++;
    });
    const finish = (request: Request, failed: boolean) => {
      const started = inflight.get(request);
      if (started === undefined) return;
      inflight.delete(request);
      const now = performance.now();
      lastEnd = Math.max(lastEnd, now);
      if (failed) tracked.failed++;
      void request
        .response()
        .then((response) => response?.allHeaders())
        .then((headers) => {
          const timing = serverTiming(headers?.["server-timing"]);
          if (timing.serverMs !== undefined) {
            tracked.maxServer = Math.max(tracked.maxServer ?? 0, timing.serverMs);
            if (tracked.slowest === undefined || timing.serverMs > tracked.slowest.ms)
              tracked.slowest = { ms: timing.serverMs, trace: timing.traceId };
          }
        })
        .catch(() => undefined);
    };
    page.on("requestfinished", (request) => finish(request, false));
    // A navigation cancelling its predecessor's requests is not a product failure.
    page.on("requestfailed", (request) =>
      finish(request, !(request.failure()?.errorText ?? "").includes("ERR_ABORTED")),
    );

    /** Run an action and wait until its requests settle; returns the interaction duration. */
    const measure = (action: (page: Page) => Promise<unknown>, expectPath?: string) =>
      Effect.tryPromise({
        try: (signal) => {
          tracked = { count: 0, api: 0, failed: 0 };
          inflight.clear();
          const started = performance.now();
          lastEnd = started;
          let urlAt = started;
          return action(page)
            .then(() =>
              expectPath === undefined
                ? undefined
                : page.waitForURL((url) => url.pathname.startsWith(expectPath), {
                    timeout: 30_000,
                  }),
            )
            .then(() => {
              urlAt = performance.now();
            })
            .then(
              () =>
                new Promise<void>((resolve, reject) => {
                  const poll = () => {
                    if (signal.aborted) return reject(new Error("aborted"));
                    const now = performance.now();
                    if (inflight.size === 0 && now - Math.max(lastEnd, urlAt) >= 300)
                      return resolve();
                    if (now - started > 60_000) return reject(new Error("did not settle"));
                    setTimeout(poll, 25);
                  };
                  poll();
                }),
            )
            .then(
              () =>
                // Server-Timing reads resolve asynchronously after requestfinished.
                new Promise<UiTiming>((resolve) =>
                  setTimeout(
                    () =>
                      resolve({
                        ms: Math.max(lastEnd, urlAt) - started,
                        requests: tracked.count,
                        apiRequests: tracked.api,
                        maxServerMs: tracked.maxServer,
                        slowestTraceId: tracked.slowest?.trace,
                        failed: tracked.failed,
                      }),
                    50,
                  ),
                ),
            );
        },
        catch: (cause) =>
          new PerfRequestFailed({ operation: "browser interaction", detail: String(cause) }),
      });
    /** Client-side navigation: click a matching link, or push history like the router does. */
    const navigate = (path: string) =>
      measure(
        (current) =>
          current
            .locator(`a[href="${path}"]`)
            .first()
            .isVisible()
            .catch(() => false)
            .then((visible) =>
              visible
                ? current.locator(`a[href="${path}"]`).first().click()
                : current.evaluate((target) => {
                    window.history.pushState({}, "", target);
                    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
                  }, path),
            ),
        path,
      );
    const load = (path: string) =>
      measure((current) => current.goto(path, { waitUntil: "commit" }), path);
    const close = Effect.promise(() => browser.close());
    return { page, measure, navigate, load, close };
  });
export type BrowserSession = Effect.Success<ReturnType<typeof openBrowser>>;
