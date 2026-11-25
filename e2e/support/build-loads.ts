import { Effect, FileSystem, Path, Schedule } from "effect";
import { Evidence, Telemetry } from "./evidence.ts";
import { Target } from "./platform.ts";

export const buildLoadSpan = "runtime.app.build.load";

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

export const unreadableBuild = (marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      target = yield* Target;
    const directory = path.join(target.directory, "data", "builds");
    const builds: string[] = [];
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
