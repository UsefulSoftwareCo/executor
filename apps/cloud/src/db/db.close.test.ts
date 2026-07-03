// Contract: the postgres pool finalizer must AWAIT the connection teardown.
//
// The cloud MCP auth seam (`makeMcpOrganizationAuthServices`) builds a fresh
// postgres pool on EVERY `/mcp` request and closes it in its `acquireRelease`
// finalizer. That finalizer used to be fire-and-forget (`Effect.runFork(
// sql.end({ timeout: 0 }))`): it returned before the socket was torn down, so
// under sustained MCP load closed-but-unreaped sockets piled up against the
// dev PGlite server (effectively single-connection) faster than it reaped
// them. New connects queued behind the backlog, request latency climbed into
// the tens of seconds, and the e2e cloud dev stack hung after a few minutes:
// the CI cascade flake.
//
// These tests characterize the contract the old fire-and-forget close violated
// (`closePostgres` itself is new alongside them): it must (a) call `sql.end`
// with a NON-zero drain window (a clean Terminate, not an abandon) and (b)
// return an Effect that does not complete until `sql.end` has resolved, even
// when the teardown takes real wall-clock time. All asserted with a fake `sql`
// whose `end()` completion is observable, so the tests are fast and need no
// live database.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { POSTGRES_END_TIMEOUT_SECONDS, closePostgres } from "./db";

describe("closePostgres", () => {
  it.effect("passes a non-zero drain window to sql.end (clean Terminate, not abandon)", () =>
    Effect.gen(function* () {
      let received: { timeout?: number } | undefined;
      const fakeSql = {
        end: (options?: { timeout?: number }) => {
          received = options;
          return Promise.resolve();
        },
      };

      yield* closePostgres(fakeSql);

      expect(received?.timeout).toBe(POSTGRES_END_TIMEOUT_SECONDS);
      expect(POSTGRES_END_TIMEOUT_SECONDS).toBeGreaterThan(0);
    }),
  );

  it.effect("does not complete until sql.end resolves (awaits the teardown)", () =>
    Effect.gen(function* () {
      // `end` records an ordering marker only after an async tick. If
      // `closePostgres` awaits it, the "close completed" marker lands AFTER the
      // "end resolved" marker. The old fire-and-forget close returned before
      // `end` ran, so "close completed" would land FIRST.
      const order: string[] = [];
      const fakeSql = {
        end: () =>
          // Defer resolution across a microtask so a non-awaiting close would
          // observably finish before this runs.
          Promise.resolve()
            .then(() => Promise.resolve())
            .then(() => {
              order.push("end-resolved");
            }),
      };

      yield* closePostgres(fakeSql);
      order.push("close-completed");

      // Awaiting the teardown means end resolved strictly before close returned.
      expect(order).toEqual(["end-resolved", "close-completed"]);
    }),
  );

  it.effect("awaits a teardown that takes real wall-clock time (bounded by the ceiling)", () =>
    Effect.gen(function* () {
      // `end` resolves only after a real timer delay, not just a microtask.
      // This pins the "we await to completion, the timeout is only a ceiling"
      // contract: closePostgres must stay suspended across the delay rather
      // than resolving early.
      const order: string[] = [];
      const fakeSql = {
        end: () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              order.push("end-resolved");
              resolve();
            }, 75);
          }),
      };

      const startedAt = Date.now();
      yield* closePostgres(fakeSql);
      order.push("close-completed");

      expect(order).toEqual(["end-resolved", "close-completed"]);
      // Slack of a few ms: platform timers may fire marginally early.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(70);
    }),
  );

  it.effect("swallows sql.end failures (a teardown error must not fail the request scope)", () =>
    Effect.gen(function* () {
      const fakeSql = {
        // A rejected teardown (connection already gone) must not surface as a
        // scope failure.
        // oxlint-disable-next-line executor/no-promise-reject -- test fake: model `sql.end` (a raw postgres.js promise) rejecting
        end: () => new Promise<void>((_resolve, reject) => reject("connection already gone")),
      };
      const exit = yield* Effect.exit(closePostgres(fakeSql));
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );
});
