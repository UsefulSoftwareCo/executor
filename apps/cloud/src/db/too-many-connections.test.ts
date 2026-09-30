/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- test doubles: simulate the driver's rejected promise and its Error-shaped cause chain */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Result, Schedule } from "effect";
import { TestClock } from "effect/testing";

import {
  TOO_MANY_CONNECTIONS_RETRIES,
  TOO_MANY_CONNECTIONS_SQLSTATE,
  describeRefusedAttempt,
  isTooManyConnectionsError,
  retryTooManyConnections,
  retryWhileTooManyConnections,
} from "./too-many-connections";

// The shape postgres.js + Drizzle produce in the deploy log: Drizzle's
// "Failed query" error with the driver's PostgresError (SQLSTATE `code`) as
// its cause.
const refused = () =>
  Object.assign(new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"'), {
    cause: Object.assign(
      new Error("remaining connection slots are reserved for roles with the SUPERUSER attribute"),
      { code: TOO_MANY_CONNECTIONS_SQLSTATE },
    ),
  });

const noDelay = Schedule.recurs(2);

describe("isTooManyConnectionsError", () => {
  it("matches SQLSTATE 53300 anywhere in the cause chain", () => {
    expect(isTooManyConnectionsError(refused())).toBe(true);
    expect(isTooManyConnectionsError({ code: "53300" })).toBe(true);
  });

  it("rejects other driver codes and non-errors", () => {
    expect(isTooManyConnectionsError({ code: "CONNECT_TIMEOUT" })).toBe(false);
    expect(isTooManyConnectionsError(new Error("boom"))).toBe(false);
    expect(isTooManyConnectionsError(undefined)).toBe(false);
    expect(isTooManyConnectionsError("53300")).toBe(false);
  });
});

describe("retryWhileTooManyConnections", () => {
  it("retries a refused connection and resolves with the first success", async () => {
    let calls = 0;
    const refusals: number[] = [];
    const result = await retryWhileTooManyConnections(
      async () => {
        calls += 1;
        if (calls < 3) throw refused();
        return "applied";
      },
      { schedule: noDelay, onRefused: (_, attempt) => refusals.push(attempt) },
    );
    expect(result).toEqual(Result.succeed("applied"));
    expect(calls).toBe(3);
    expect(refusals).toEqual([1, 2]);
  });

  it("rethrows any other failure without retrying", async () => {
    let calls = 0;
    const failure = Object.assign(new Error("Failed query: alter table"), {
      cause: { code: "42P01" },
    });
    const result = await retryWhileTooManyConnections(
      async () => {
        calls += 1;
        throw failure;
      },
      { schedule: noDelay },
    );
    expect(Result.isFailure(result) && result.failure).toBe(failure);
    expect(calls).toBe(1);
  });

  it("rethrows the last refusal once the schedule is spent", async () => {
    let calls = 0;
    const failures: unknown[] = [];
    const result = await retryWhileTooManyConnections(
      async () => {
        calls += 1;
        const failure = refused();
        failures.push(failure);
        throw failure;
      },
      { schedule: noDelay },
    );
    expect(calls).toBe(3);
    expect(Result.isFailure(result) && result.failure).toBe(failures[2]);
  });
});

describe("the production schedule", () => {
  // Virtual time: the production cadence is thirty seconds between attempts,
  // and a test that waited it out for real would take a quarter of an hour.
  // `it.effect` runs under the TestClock, which the schedule's sleeps use.
  it.effect("retries every thirty seconds and gives up after about fifteen minutes", () =>
    Effect.gen(function* () {
      let calls = 0;
      const refusals: number[] = [];
      const fiber = yield* Effect.forkChild(
        Effect.result(
          retryTooManyConnections(
            Effect.suspend(() => {
              calls += 1;
              return Effect.fail(refused());
            }),
            { onRefused: (_, attempt) => refusals.push(attempt) },
          ),
        ),
      );

      yield* TestClock.adjust("29 seconds");
      expect(calls).toBe(1);
      yield* TestClock.adjust("1 second");
      expect(calls).toBe(2);

      // Attempt n runs at (n - 1) × 30 s: the thirtieth at 14:30, the last at 15:00.
      yield* TestClock.adjust("14 minutes");
      expect(calls).toBe(TOO_MANY_CONNECTIONS_RETRIES);
      yield* TestClock.adjust("30 seconds");
      const result = yield* Fiber.join(fiber);

      expect(calls).toBe(TOO_MANY_CONNECTIONS_RETRIES + 1);
      expect(refusals.at(-1)).toBe(TOO_MANY_CONNECTIONS_RETRIES + 1);
      expect(Result.isFailure(result) && isTooManyConnectionsError(result.failure)).toBe(true);
    }),
  );
});

describe("describeRefusedAttempt", () => {
  it("says when it will retry and when it is giving up", () => {
    expect(describeRefusedAttempt(1)).toBe(
      `Postgres refused the connection: no free connection slots (attempt 1 of ${TOO_MANY_CONNECTIONS_RETRIES + 1}); retrying in 30 seconds`,
    );
    expect(describeRefusedAttempt(TOO_MANY_CONNECTIONS_RETRIES + 1)).toMatch(/giving up$/);
  });
});
