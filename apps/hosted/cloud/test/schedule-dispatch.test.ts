import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { makeScheduleDispatch } from "../src/implementation/schedule-dispatch.ts";

test("due schedules run while profile maintenance is held, without overlapping maintenance passes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const dispatch = yield* makeScheduleDispatch;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const scheduled = yield* Deferred.make<void>();
        let maintenancePasses = 0;
        let scheduledPasses = 0;
        const profiles = Effect.gen(function* () {
          maintenancePasses++;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
        });
        const schedules = Effect.gen(function* () {
          scheduledPasses++;
          yield* Deferred.succeed(scheduled, undefined);
        });
        const first = yield* dispatch(profiles, schedules).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Deferred.await(scheduled).pipe(Effect.timeout("1 second"));
        yield* dispatch(profiles, schedules).pipe(Effect.timeout("1 second"));
        assert.equal(maintenancePasses, 1);
        assert.equal(scheduledPasses, 2);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* dispatch(profiles, schedules);
        assert.equal(maintenancePasses, 2);
        assert.equal(scheduledPasses, 3);
      }),
    ),
  ));

test("profile failure retains its cause and waits for independently admitted schedule work", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const dispatch = yield* makeScheduleDispatch;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let completed = false;
        const work = yield* dispatch(
          Effect.fail("profile storage unavailable"),
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            completed = true;
          }),
        ).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(started).pipe(Effect.timeout("1 second"));
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(work);
        assert.equal(completed, true);
        assert.deepEqual(result, Exit.fail("profile storage unavailable"));
      }),
    ),
  ));

test("coordinator cancellation releases both operations and permits later maintenance", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const dispatch = yield* makeScheduleDispatch;
        const profileStarted = yield* Deferred.make<void>();
        const scheduleStarted = yield* Deferred.make<void>();
        const released: string[] = [];
        const held = (name: string, started: Deferred.Deferred<void>) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => released.push(name))),
          );
        const work = yield* dispatch(
          held("profiles", profileStarted),
          held("schedules", scheduleStarted),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(profileStarted);
        yield* Deferred.await(scheduleStarted);
        yield* Fiber.interrupt(work);
        assert.deepEqual(released.sort(), ["profiles", "schedules"]);
        let maintained = false;
        yield* dispatch(
          Effect.sync(() => {
            maintained = true;
          }),
          Effect.void,
        );
        assert.equal(maintained, true);
      }),
    ),
  ));
