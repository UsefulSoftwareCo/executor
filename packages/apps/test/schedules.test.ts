/** Interval schedules are floored at one minute, because dispatch coalesces overdue ticks. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { minimumIntervalMilliseconds, ScheduleTiming } from "../src/contracts/schedules.ts";
import { cron, interval, mutation, object, string } from "../src/index.ts";

const record = mutation({ input: object({ message: string() }) }, async (_ctx, input) => input);
const input = { message: "Heartbeat" };
const timing = (declaration: { readonly timing: ScheduleTiming }) =>
  declaration.timing.kind === "interval" ? declaration.timing.milliseconds : null;

test("the floor is one minute", () => {
  assert.equal(minimumIntervalMilliseconds, 60_000);
});

for (const duration of [{ seconds: 1 }, { seconds: 30 }, { seconds: 59 }] as const) {
  test(`interval(${JSON.stringify(duration)}) is rejected at declaration`, () => {
    assert.throws(
      () => interval(duration, record, input),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("Schedule intervals must be at least 60 seconds"),
    );
  });
}

for (const [duration, milliseconds] of [
  [{ seconds: 60 }, 60_000],
  [{ seconds: 90 }, 90_000],
  [{ minutes: 1 }, 60_000],
  [{ minutes: 5 }, 300_000],
  [{ hours: 1 }, 3_600_000],
] as const) {
  test(`interval(${JSON.stringify(duration)}) resolves to ${milliseconds}ms`, () => {
    assert.equal(timing(interval(duration, record, input)), milliseconds);
  });
}

test("the floor also guards timing arriving over a boundary", () => {
  assert.throws(() =>
    Schema.decodeUnknownSync(ScheduleTiming)({ kind: "interval", milliseconds: 59_999 }),
  );
  assert.deepEqual(
    Schema.decodeUnknownSync(ScheduleTiming)({ kind: "interval", milliseconds: 60_000 }),
    { kind: "interval", milliseconds: 60_000 },
  );
});

test("calendar schedules keep their own one-minute cron floor", () => {
  const declaration = cron({ expression: "*/1 * * * *", timezone: "UTC" }, record, input);
  assert.equal(declaration.timing.kind, "cron");
});
