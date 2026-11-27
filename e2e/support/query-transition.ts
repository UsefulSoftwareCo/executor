import { Deferred, Effect } from "effect";
import type { Route } from "playwright";
import { Browser } from "./browser.ts";
import { driver } from "./platform.ts";

export const holdQuery = (
  paths: readonly string[] | RegExp,
  outcome: "continue" | "fail" | "undeclared",
  options: {
    readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    readonly allRequests?: boolean;
    readonly query?: Readonly<Record<string, string>>;
  } = {},
) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const requested = yield* Deferred.make<string>();
    const release = yield* Deferred.make<void>();
    const active = new Set<Promise<void>>();
    let claimed = false;
    const match = (url: URL) =>
      (paths instanceof RegExp ? paths.test(url.pathname) : paths.includes(url.pathname)) &&
      Object.entries(options.query ?? {}).every(
        ([key, value]) => url.searchParams.get(key) === value,
      );
    const intercept = (route: Route) => {
      // oxlint-disable-next-line executor/no-manual-effect-runtime-in-tests -- Playwright route handlers must return a Promise
      const request = Effect.runPromise(
        Effect.gen(function* () {
          if (
            (claimed && !options.allRequests) ||
            route.request().method() !== (options.method ?? "GET")
          ) {
            yield* driver("Continue an unrelated request", () => route.fallback());
            return;
          }
          claimed = true;
          yield* Deferred.succeed(requested, new URL(route.request().url()).pathname);
          yield* Deferred.await(release);
          yield* driver("Release the held query", () =>
            outcome === "fail"
              ? route.abort("failed")
              : outcome === "undeclared"
                ? route.fulfill({ status: 599, contentType: "text/plain", body: "undeclared" })
                : route.fallback(),
          );
        }),
      );
      active.add(request);
      return request.finally(() => active.delete(request));
    };
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(release, undefined);
        yield* browser.use("Remove the query hold", (page) => page.unroute(match, intercept));
        yield* Effect.forEach(
          [...active],
          (request) => driver("Drain the query hold", () => request),
          {
            concurrency: "unbounded",
          },
        );
      }).pipe(Effect.orDie),
    );
    yield* browser.use("Hold the next matching query", (page) => page.route(match, intercept));
    return {
      requested: Deferred.await(requested).pipe(Effect.timeout("30 seconds")),
      release: Deferred.succeed(release, undefined),
    };
  });

export const refreshVisiblePage = Effect.flatMap(Browser, (browser) =>
  browser.use("Return to the visible page", (page) =>
    page.evaluate(() => {
      if (document.visibilityState !== "visible") throw new Error("The test page is not visible");
      window.dispatchEvent(new Event("visibilitychange"));
    }),
  ),
);

export const idleReconciliationMillis = 30_000;
export const installBrowserClock = Effect.flatMap(Browser, (browser) =>
  browser.use("Control the browser clock", (page) => page.context().clock.install()),
);
export const advanceToReconciliation = Effect.flatMap(Browser, (browser) =>
  browser.use("Advance to the next idle reconciliation", (page) =>
    page.context().clock.runFor(idleReconciliationMillis),
  ),
);
