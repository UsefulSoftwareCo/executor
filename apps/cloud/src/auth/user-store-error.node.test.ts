// `UserStoreError` is the public failure of every cloud user-store call, and it
// used to carry NOTHING: no operation, no reason, no message. Sentry grouped
// every store failure — a connect timeout, a missing table, a constraint
// violation — into one titleless issue, and the only cause detail (the
// pretty-printed Effect cause stuffed into a Sentry `extra`) is scrubbed
// server-side, so the issue was undiagnosable from Sentry alone.
//
// This pins the two safe classification fields it must carry instead:
// `operation` (already in hand at the call site) and `reason` (classified from
// the driver cause the way `statusFromWorkOSCause` classifies WorkOS causes).
import { createServer, type Server, type Socket } from "node:net";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import postgres from "postgres";

import { UserStoreService } from "./context";
import { ServiceAdapterError, userStoreReasonFromCause, type UserStoreError } from "./errors";
import { DbService } from "../db/db";

// A socket that completes the TCP handshake and then says nothing — exactly
// what a wedged Hyperdrive/Postgres endpoint looks like to postgres.js, and the
// only way to obtain the driver's REAL connect-timeout error object rather than
// a hand-written imitation of it.
const blackHolePort = async (): Promise<{
  readonly port: number;
  readonly close: () => Promise<void>;
}> => {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  // oxlint-disable-next-line executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: the fixture cannot run without a bound port
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        // The timed-out client leaves its half-open socket attached; without
        // dropping it first, `close` waits for a peer that will never speak.
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
};

const realConnectTimeoutError = async (): Promise<unknown> => {
  const hole = await blackHolePort();
  const sql = postgres(`postgresql://postgres:postgres@127.0.0.1:${hole.port}/postgres`, {
    max: 1,
    connect_timeout: 1,
    fetch_types: false,
    onnotice: () => undefined,
  });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: capturing the driver's own thrown error IS the fixture
  try {
    await sql`select 1`;
    // oxlint-disable-next-line executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: the fixture is unusable if the socket answered
    throw new Error("expected the connect to time out");
  } catch (error) {
    return error;
  } finally {
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: best-effort teardown of a connection that never opened
    await sql.end({ timeout: 0 }).catch(() => undefined);
    await hole.close();
  }
};

// Drizzle re-throws driver failures wrapped in its own error with the failing
// SQL in the message and the driver error in `.cause` — the shape production
// actually reports (`Failed query: select … -> write CONNECT_TIMEOUT …`).
const wrappedLikeDrizzle = (cause: unknown): Error =>
  // oxlint-disable-next-line executor/no-error-constructor -- boundary: reproducing the driver wrapper shape the store really fails with
  Object.assign(new Error('Failed query: select "id" from "organizations" where "id" = $1'), {
    cause,
  });

const stubDb = Layer.succeed(DbService)({ db: {} as never });

const failingStoreCall = (
  operation: string,
  failure: unknown,
): Effect.Effect<Result.Result<never, UserStoreError>> =>
  Effect.gen(function* () {
    const users = yield* UserStoreService;
    // oxlint-disable-next-line executor/no-promise-reject -- boundary: the store adapter lifts a REJECTING promise; rejecting is the fixture
    return yield* users.use(operation, () => Promise.reject(failure));
  }).pipe(
    Effect.provide(UserStoreService.Live.pipe(Layer.provide(stubDb))),
    Effect.result,
  ) as Effect.Effect<Result.Result<never, UserStoreError>>;

describe("UserStoreError classification", () => {
  it("classifies the driver cause chain", async () => {
    const driverError = await realConnectTimeoutError();

    expect(userStoreReasonFromCause(wrappedLikeDrizzle(driverError))).toBe("connect_timeout");
    expect(
      userStoreReasonFromCause(new ServiceAdapterError({ cause: wrappedLikeDrizzle(driverError) })),
    ).toBe("connect_timeout");
    expect(
      userStoreReasonFromCause(
        // oxlint-disable-next-line executor/no-error-constructor -- boundary: a SQLSTATE failure shape
        Object.assign(new Error('relation "organizations" does not exist'), { code: "42P01" }),
      ),
    ).toBe("query");
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: a failure with nothing to classify
    expect(userStoreReasonFromCause(new Error("something else"))).toBe("unknown");
  }, 20_000);

  it("carries operation, reason and a stable message on the public error", async () => {
    const driverError = await realConnectTimeoutError();

    const result = await Effect.runPromise(
      failingStoreCall("getOrganization", wrappedLikeDrizzle(driverError)),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure.operation).toBe("getOrganization");
    expect(result.failure.reason).toBe("connect_timeout");
    expect(result.failure.message).toContain("getOrganization");
    expect(result.failure.message).toContain("connect_timeout");
  }, 20_000);
});
