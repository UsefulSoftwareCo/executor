import { Deferred, Effect, Schema } from "effect";
import { Browser } from "./browser.ts";

export const InstallationDirectory = Schema.Struct({
  apps: Schema.Array(Schema.Unknown),
  accounts: Schema.Array(Schema.Unknown),
  pendingApp: Schema.Boolean,
});

export const holdTeamInstallation = (
  paths: readonly string[],
  directory: typeof InstallationDirectory.Type,
) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const requested = yield* Deferred.make<void>();
    let pending = true;
    const match = (url: URL) => paths.includes(url.pathname);
    const release = browser.use("Release team installation responses", (page) =>
      page.unroute(match),
    );
    yield* Effect.addFinalizer(() => release.pipe(Effect.orDie));
    yield* browser.use("Hold the missing app while installation runs", (page) =>
      page.route(match, (route) => {
        // oxlint-disable-next-line executor/no-manual-effect-runtime-in-tests -- Playwright route handlers are plain callbacks
        Effect.runSync(Deferred.succeed(requested, undefined));
        return route.fulfill({ json: { ...directory, apps: [], pendingApp: pending } });
      }),
    );
    return {
      requested: Deferred.await(requested).pipe(Effect.timeout("30 seconds")),
      stop: Effect.sync(() => {
        pending = false;
      }),
      resume: Effect.sync(() => {
        pending = true;
      }),
      release,
    };
  });
