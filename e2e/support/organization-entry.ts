import { Deferred, Effect } from "effect";
import type { Frame, Request, Route } from "playwright";
import { Browser } from "./browser.ts";
import { driver } from "./platform.ts";

/** Wait for the public navigation hint written after the foreground organization's access check. */
export const waitForLastOrganization = (organization: string) =>
  Effect.flatMap(Browser, (browser) =>
    browser.use("The foreground organization is remembered", (page) =>
      page.waitForFunction((expected) => {
        const name = `executor-ui${location.port === "" ? "" : `-${location.port}`}=`;
        const cookie = document.cookie.split("; ").find((value) => value.startsWith(name));
        if (cookie === undefined) return false;
        let hint: unknown;
        try {
          hint = JSON.parse(decodeURIComponent(cookie.slice(name.length)));
        } catch {
          return false;
        }
        return (
          typeof hint === "object" &&
          hint !== null &&
          "lastOrganization" in hint &&
          hint.lastOrganization === expected
        );
      }, organization),
    ),
  );

/** Hold real organization reads so the pending view can be inspected before a destination exists. */
export const holdOrganizationEntry = Effect.gen(function* () {
  const browser = yield* Browser;
  const arrived = yield* Deferred.make<void>();
  const released = yield* Deferred.make<void>();
  const active = new Set<Promise<void>>();
  const hold = (route: Route) => {
    const pending = Effect.runPromise(
      Effect.gen(function* () {
        yield* Deferred.succeed(arrived, undefined);
        yield* Deferred.await(released);
        yield* driver("Continue the original organization read", () => route.fallback());
      }),
    );
    active.add(pending);
    return pending.finally(() => active.delete(pending));
  };
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Deferred.succeed(released, undefined);
      yield* browser.use("Remove the organization read hold", (page) =>
        page.unroute("**/api/auth/organization/list", hold),
      );
      yield* Effect.forEach(
        [...active],
        (pending) => driver("Drain the organization read hold", () => pending),
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.orDie),
  );
  yield* browser.use("Hold organization reads", (page) =>
    page.route("**/api/auth/organization/list", hold),
  );
  return {
    requested: Deferred.await(arrived).pipe(Effect.timeout("30 seconds")),
    release: Deferred.succeed(released, undefined),
  };
});

/** Observe real inventory reads across root restoration and canonical URL replacement. */
export const trackOrganizationInventory = Effect.gen(function* () {
  const browser = yield* Browser;
  const paths: string[] = [];
  const requested = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && /^\/api\/organizations\/[^/]+\/inventory$/.test(path))
      paths.push(path);
  };
  yield* browser.use("Observe inventory requests", (page) =>
    Promise.resolve(page.on("request", requested)),
  );
  yield* Effect.addFinalizer(() =>
    browser
      .use("Stop observing inventory requests", (page) =>
        Promise.resolve(page.off("request", requested)),
      )
      .pipe(Effect.orDie),
  );
  return paths;
});

/** Observe browser destinations, including SPA navigation, without changing any response. */
export const trackEntryNavigations = Effect.gen(function* () {
  const browser = yield* Browser;
  const paths: string[] = [];
  const navigated = (frame: Frame) => {
    if (frame.parentFrame() === null) paths.push(new URL(frame.url()).pathname);
  };
  yield* browser.use("Observe entry destinations", (page) =>
    Promise.resolve(page.on("framenavigated", navigated)),
  );
  yield* Effect.addFinalizer(() =>
    browser
      .use("Stop observing entry destinations", (page) =>
        Promise.resolve(page.off("framenavigated", navigated)),
      )
      .pipe(Effect.orDie),
  );
  return paths;
});
