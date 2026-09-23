import { Deferred, Effect } from "effect";
import type { Route } from "playwright";
import { Browser } from "./browser.ts";
import { driver } from "./platform.ts";

/** Hold real responses independently; scope cleanup releases and drains every intercepted request. */
export const dashboardLoadingProbe = Effect.gen(function* () {
  const browser = yield* Browser;
  const resourcesRequested = yield* Deferred.make<void>();
  const content = yield* Deferred.make<void>();
  const metadata = yield* Deferred.make<void>();
  const session = yield* Deferred.make<void>();
  const sessionRequested = yield* Deferred.make<void>();
  const requests: string[] = [];
  const active = new Set<Promise<void>>();
  const hold = (route: Route) => {
    const pending = Effect.runPromise(
      Effect.gen(function* () {
        const path = new URL(route.request().url()).pathname;
        requests.push(path);
        if (path === "/api/auth/get-session") {
          yield* Deferred.succeed(sessionRequested, undefined);
          yield* Deferred.await(session);
        }
        if (path.endsWith("/resources")) {
          yield* Deferred.succeed(resourcesRequested, undefined);
          yield* Deferred.await(content);
        }
        if (path.endsWith("/access") || path === "/api/auth/organization/list")
          yield* Deferred.await(metadata);
        yield* driver("Continue the original dashboard request", () => route.fallback());
      }),
    );
    active.add(pending);
    return pending.finally(() => active.delete(pending));
  };
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Deferred.succeed(content, undefined);
      yield* Deferred.succeed(metadata, undefined);
      yield* Deferred.succeed(session, undefined);
      yield* browser.use("Remove the loading probe", (page) => page.unroute("**/api/**", hold));
      yield* Effect.forEach(
        [...active],
        (pending) => driver("Drain the loading probe", () => pending),
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.orDie),
  );
  yield* browser.use("Hold content and sidebar reads independently", (page) =>
    page.route("**/api/**", hold),
  );
  return {
    requests,
    resourcesRequested: Deferred.await(resourcesRequested).pipe(Effect.timeout("30 seconds")),
    sessionRequested: Deferred.await(sessionRequested).pipe(Effect.timeout("30 seconds")),
    releaseContent: Deferred.succeed(content, undefined),
    releaseMetadata: Deferred.succeed(metadata, undefined),
    releaseSession: Deferred.succeed(session, undefined),
  };
});
