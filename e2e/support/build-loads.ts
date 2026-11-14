/**
 * Count how often a host loaded an app's retained build. Each host's build loader records every
 * load as a span in the calling trace, so the counts come from delivered telemetry rather than
 * from inside the runtime.
 */
import { Effect, FileSystem, Path, Schedule } from "effect";
import { Evidence, Telemetry } from "./evidence.ts";
import { Target } from "./platform.ts";

/** The span each host's build loader records when a runtime cold start asks for app code. */
export const buildLoadSpan = "runtime.app.build.load";

/** The build loads recorded in the latest request's trace, once its server span has arrived. */
export const latestRequestBuildLoads = (label: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence,
      telemetry = yield* Telemetry;
    const request = (yield* evidence.requests).at(-1);
    if (request === undefined) return yield* Effect.die("Request evidence is missing");
    const trace = yield* telemetry.query(request.traceId).pipe(
      Effect.flatMap((result) =>
        result.data.some(({ span }) => span.operationName.startsWith("http.server"))
          ? Effect.succeed(result)
          : Effect.fail(new Error("The request trace has not reached the collector")),
      ),
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }),
    );
    const loads = trace.data.filter(({ span }) => span.operationName === buildLoadSpan);
    yield* evidence.json(`build-loads-${label}.json`, {
      traceId: request.traceId,
      loads: loads.map(({ span }) => span.tags),
    });
    return loads.length;
  });

/**
 * Every build load of one app, in any trace including background discovery, counted per runtime:
 * the app Worker or data facet of one account selection. Waits until at least one load has arrived
 * and the counts hold across three reads, so delivery lag is not mistaken for a missing load.
 */
export const appBuildLoads = (app: string) =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry,
      evidence = yield* Evidence;
    const read = telemetry.spans(buildLoadSpan, { app }).pipe(
      Effect.map((spans) => {
        const counts: Record<string, number> = {};
        for (const tags of spans) {
          const runtime = `${tags["executor.runtime.mode"]} ${tags["executor.worker.identity"]}`;
          counts[runtime] = (counts[runtime] ?? 0) + 1;
        }
        return counts;
      }),
    );
    let previous = "",
      stable = 0;
    for (let attempt = 0; attempt < 60; attempt++) {
      const current = yield* read;
      const encoded = JSON.stringify(Object.entries(current).sort());
      stable = encoded === previous && Object.keys(current).length > 0 ? stable + 1 : 0;
      if (stable === 2) {
        yield* evidence.json(`build-loads-${app}.json`, current);
        return current;
      }
      previous = encoded;
      yield* Effect.sleep("1 second");
    }
    return yield* Effect.die(`Build loads of ${app} did not settle: ${previous}`);
  });

/**
 * Make the retained build whose authored source contains `marker` unreadable to the host, as a
 * brief storage failure would, until the returned effect restores it or the scope closes. Self-host
 * and local keep builds as files in the server's data directory; a cold start that asks for the
 * build meanwhile fails to load.
 */
export const unreadableBuild = (marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      target = yield* Target;
    const directory = path.join(target.directory, "data", "builds");
    const builds: string[] = [];
    // Each build's record is `<build>/worker.json`; the framework it links is stored apart.
    for (const name of yield* fs.readDirectory(directory)) {
      const file = path.join(directory, name, "worker.json");
      if (!name.startsWith("bld_") || !(yield* fs.exists(file))) continue;
      if ((yield* fs.readFileString(file)).includes(marker)) builds.push(file);
    }
    if (builds.length !== 1)
      return yield* Effect.die(`Expected one retained build of ${marker}, found ${builds.length}`);
    const [build] = builds as [string];
    const hidden = `${build}.unreadable`;
    yield* fs.rename(build, hidden);
    let restored = false;
    const restore = Effect.suspend(() => {
      if (restored) return Effect.void;
      restored = true;
      return fs.rename(hidden, build).pipe(Effect.orDie);
    });
    yield* Effect.addFinalizer(() => restore);
    return restore;
  });
