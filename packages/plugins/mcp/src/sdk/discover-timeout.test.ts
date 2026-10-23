import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { McpConnector } from "./connection";
import { discoverTools, resolveDiscoverTimeoutMs } from "./discover";

const ENV = "EXECUTOR_MCP_DISCOVERY_TIMEOUT_MS";

// A server that never answers the handshake, so only the deadline ends discovery.
const neverConnects: McpConnector = Effect.never;

const withEnv = <A, E, R>(value: string | undefined, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[ENV];
      if (value === undefined) delete process.env[ENV];
      else process.env[ENV] = value;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[ENV];
        else process.env[ENV] = previous;
      }),
  );

describe("MCP discovery timeout", () => {
  it.effect("defaults to 30 seconds", () =>
    withEnv(
      undefined,
      Effect.sync(() => expect(resolveDiscoverTimeoutMs()).toBe(30_000)),
    ),
  );

  it.effect("ignores a value that is not a positive integer", () =>
    Effect.gen(function* () {
      for (const value of ["", "abc", "0", "-5", "1.5"]) {
        const resolved = yield* withEnv(value, Effect.sync(resolveDiscoverTimeoutMs));
        expect(resolved).toBe(30_000);
      }
    }),
  );

  it.live("uses EXECUTOR_MCP_DISCOVERY_TIMEOUT_MS when discovery has no explicit timeout", () =>
    withEnv(
      "250",
      Effect.gen(function* () {
        const failure = yield* discoverTools(neverConnects).pipe(Effect.flip);
        expect(failure.message).toBe("MCP discovery timed out after 250ms");
        expect(failure.timedOut).toBe(true);
      }),
    ),
  );

  it.live("an explicit timeout wins over the environment", () =>
    withEnv(
      "60000",
      Effect.gen(function* () {
        const failure = yield* discoverTools(neverConnects, 100).pipe(Effect.flip);
        expect(failure.message).toBe("MCP discovery timed out after 100ms");
      }),
    ),
  );
});
