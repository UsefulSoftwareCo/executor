/**
 * The background service harness tells a server's process from another that Windows later gives
 * its ID by the start time it recorded when the server registered (`sameProcess` in
 * `e2e/support/background-service.ts`). Liveness polls run in short windows, such as a server's
 * ten seconds to stop, so the gone direction must not wait for a start time, and a live ID with
 * another start time must never be taken for the old process. These cases use real processes; the
 * start time a Windows reader would give is supplied.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Clock, Effect, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { alive, sameProcess } from "../support/background-service.ts";

/** A process that runs until this case kills it. */
const sleeper = Effect.gen(function* () {
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* processes.spawn(
    ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
});

layer(NodeServices.layer, { excludeTestServices: true })("process identity", (it) => {
  it.effect("a process ID that names no process reads as gone at once, without a start time", () =>
    Effect.gen(function* () {
      const child = yield* sleeper;
      const pid = Number(child.pid);
      yield* child.kill();
      yield* child.exitCode.pipe(Effect.ignore);
      let asked = 0;
      const startTime = () =>
        Effect.sync(() => {
          asked += 1;
          return Option.some("recorded");
        });
      const before = yield* Clock.currentTimeMillis;
      const same = yield* sameProcess(pid, "recorded", { alive, startTime });
      const took = (yield* Clock.currentTimeMillis) - before;
      expect(same).toBe(false);
      expect(asked, "a gone process needs no start time").toBe(0);
      expect(took, "milliseconds").toBeLessThan(100);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a live process ID whose start time is not the recorded one reads as another process",
    () =>
      Effect.gen(function* () {
        const child = yield* sleeper;
        const pid = Number(child.pid);
        const started = (answer: Option.Option<string>) => () => Effect.succeed(answer);
        // The ID now names a process that started at another time: Windows reused it.
        expect(
          yield* sameProcess(pid, "recorded", { alive, startTime: started(Option.some("later")) }),
        ).toBe(false);
        // The process went between the existence check and the start time read.
        expect(
          yield* sameProcess(pid, "recorded", { alive, startTime: started(Option.none()) }),
        ).toBe(false);
        // The process the start time was recorded for still runs.
        expect(
          yield* sameProcess(pid, "recorded", {
            alive,
            startTime: started(Option.some("recorded")),
          }),
        ).toBe(true);
        // Without a recorded start time, as on Linux and macOS, the ID alone decides.
        expect(
          yield* sameProcess(pid, undefined, { alive, startTime: started(Option.none()) }),
        ).toBe(true);
        yield* child.kill();
      }).pipe(Effect.scoped),
  );
});
