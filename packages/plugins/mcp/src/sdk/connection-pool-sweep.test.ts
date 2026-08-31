// ---------------------------------------------------------------------------
// Idle eviction must reach every parked connection, not only the one being
// asked for.
//
// The TTL used to be consulted against `idle.get(key)` alone, so an identity
// that was never dialled again was never examined again — its session stayed
// open and authenticated indefinitely, holding the bearer it was dialled with.
// The advertised five-minute bound only applied to connections that happened to
// be reused.
//
// Driven with a fake connector rather than a real MCP server, because the thing
// under test is exactly WHEN `close()` is called, and a fake makes that directly
// observable instead of inferred from session counts.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
// oxlint-disable-next-line executor/no-vitest-import -- boundary: system-time control comes from vitest itself
import { afterEach, vi } from "vitest";

import type { McpConnection, McpConnector } from "./connection";
import { createMcpConnectionPool } from "./connection-pool";

const IDLE_TTL_MS = 5 * 60 * 1_000;

afterEach(() => {
  vi.useRealTimers();
});

/** A connector whose connection records the moment it is closed. */
const fakeConnector = (state: { closed: boolean }): McpConnector =>
  Effect.sync(
    () =>
      ({
        client: {} as McpConnection["client"],
        close: async () => {
          state.closed = true;
        },
      }) satisfies McpConnection,
  );

/** A connection whose `close()` is accepted and then never answered — the
 *  server that goes quiet mid-teardown. */
const hangingConnector = (): McpConnector =>
  Effect.sync(
    () =>
      ({
        client: {} as McpConnection["client"],
        close: () => new Promise<void>(() => {}),
      }) satisfies McpConnection,
  );

describe("MCP connection pool idle sweep", () => {
  it.effect("closes an expired connection parked under a DIFFERENT key", () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      const pool = createMcpConnectionPool();
      const stale = { closed: false };
      const other = { closed: false };

      // Park a connection under "stale" and never ask for that key again.
      yield* pool.withConnection("stale", fakeConnector(stale), () => Effect.void);
      expect(stale.closed).toBe(false);

      vi.advanceTimersByTime(IDLE_TTL_MS + 1_000);

      // Activity on an UNRELATED key is what must now reclaim it.
      yield* pool.withConnection("other", fakeConnector(other), () => Effect.void);

      expect(stale.closed).toBe(true);
      yield* pool.close();
    }),
  );

  it.effect("leaves a connection that is still inside the idle window alone", () =>
    Effect.gen(function* () {
      // The other half: sweeping must not become "close everything on any
      // activity", which would destroy pooling while still passing the test
      // above.
      vi.useFakeTimers();
      const pool = createMcpConnectionPool();
      const fresh = { closed: false };
      const other = { closed: false };

      yield* pool.withConnection("fresh", fakeConnector(fresh), () => Effect.void);
      vi.advanceTimersByTime(IDLE_TTL_MS - 1_000);
      yield* pool.withConnection("other", fakeConnector(other), () => Effect.void);

      expect(fresh.closed).toBe(false);
      yield* pool.close();
    }),
  );

  it.effect("still reuses a parked connection for the same key", () =>
    Effect.gen(function* () {
      // Guards the pool's whole reason for existing: a sweep that quietly broke
      // reuse would leave both tests above green.
      vi.useFakeTimers();
      const pool = createMcpConnectionPool();
      const first = { closed: false };
      let dials = 0;
      const counting: McpConnector = Effect.suspend(() => {
        dials += 1;
        return fakeConnector(first);
      });

      yield* pool.withConnection("same", counting, () => Effect.void);
      yield* pool.withConnection("same", counting, () => Effect.void);

      expect(dials).toBe(1);
      yield* pool.close();
    }),
  );

  it.effect("a close that never answers does not strand the acquire that swept it", () =>
    Effect.gen(function* () {
      // The sweep is paid for by whichever invocation happens to acquire next,
      // so an unresponsive teardown is a live caller's latency. Only `Date` is
      // faked here: the wait being asserted is an Effect sleep, which belongs to
      // `it.effect`'s TestClock, and faking the platform timers underneath it
      // would leave nothing to advance.
      vi.useFakeTimers({ toFake: ["Date"] });
      const pool = createMcpConnectionPool();
      const other = { closed: false };

      yield* pool.withConnection("hung", hangingConnector(), () => Effect.void);
      vi.advanceTimersByTime(IDLE_TTL_MS + 1_000);

      const fiber = yield* Effect.forkChild(
        pool.withConnection("other", fakeConnector(other), () => Effect.void),
      );

      // Past the close timeout, but nowhere near "forever": an unbounded close
      // would leave this fiber suspended and the join below would never return.
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Fiber.join(fiber);

      // The unrelated connection was served, not collateral damage.
      expect(other.closed).toBe(false);
      yield* pool.close();
    }),
  );
});
