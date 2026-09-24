/** Trace the real PostgreSQL driver against a synthetic TCP startup peer. */
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import { PgClient, PgConnection, PgPool } from "@effect/sql-pg";
import { Cause, Deferred, Effect, Exit, Match, Option, Redacted, Schema, Tracer } from "effect";
import { SqlError } from "effect/unstable/sql/SqlError";
import { sqlTracing } from "../src/implementation/sql-tracing.ts";

const ready = (socket: Socket, processId: number) => {
  const key = Buffer.alloc(13);
  key.writeUInt8(75);
  key.writeInt32BE(12, 1);
  key.writeInt32BE(processId, 5);
  socket.write(
    Buffer.concat([
      Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0]), // AuthenticationOk
      key,
      Buffer.from([90, 0, 0, 0, 5, 73]), // ReadyForQuery, idle
    ]),
  );
};

const withPeer = async (
  respond: (socket: Socket, processId: number) => void,
  run: (peer: {
    readonly options: PgConnection.Config;
    readonly started: Effect.Effect<void>;
    readonly closed: Effect.Effect<void>;
    readonly connections: () => number;
  }) => Promise<void>,
) => {
  const sockets = new Set<Socket>();
  const started = Deferred.makeUnsafe<void>();
  const closed = Deferred.makeUnsafe<void>();
  let connections = 0;
  const server = createServer((socket) => {
    const processId = ++connections;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => {
      sockets.delete(socket);
      Deferred.doneUnsafe(closed, Effect.void);
    });
    let input = Buffer.alloc(0);
    const startup = (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      if (input.length < 4 || input.length < input.readInt32BE(0)) return;
      socket.off("data", startup);
      Deferred.doneUnsafe(started, Effect.void);
      respond(socket, processId);
    };
    socket.on("data", startup);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    await run({
      options: {
        host: "127.0.0.1",
        port: address.port,
        username: "synthetic-user",
        password: Redacted.make("synthetic-password"),
        database: "synthetic-database",
        ssl: false,
        prepare: false,
      },
      started: Deferred.await(started),
      closed: Deferred.await(closed),
      connections: () => connections,
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
};

const recording = () => {
  const spans: Tracer.NativeSpan[] = [];
  return {
    spans,
    tracer: Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    }),
    connections: () => spans.filter((span) => span.name === "sql.connect"),
  };
};

const outcome = (span: Tracer.NativeSpan) =>
  Match.value(span.status).pipe(
    Match.tag("Ended", (status) => ({ exit: status.exit })),
    Match.tag("Started", () => assert.fail("Connection span did not end")),
    Match.exhaustive,
  ).exit;

test(
  "SQL comments and wire parents identify the same statement without changing parameters",
  { timeout: 5_000 },
  () =>
    withPeer(
      (socket, processId) => {
        ready(socket, processId);
        socket.once("data", (frame) => {
          assert.ok(Buffer.isBuffer(frame));
          assert.equal(frame[0], 80); // Extended protocol Parse
          const sql = frame.subarray(6, frame.indexOf(0, 6)).toString();
          assert.match(sql, /^SELECT \$1\n\/\*traceparent='00-[0-9a-f]{32}-[0-9a-f]{16}-01'\*\/$/);
          assert.doesNotMatch(sql, /synthetic-private-value/);
          assert.ok(frame.includes(Buffer.from("synthetic-private-value")));
          socket.write(
            Buffer.concat([
              Buffer.from([49, 0, 0, 0, 4, 50, 0, 0, 0, 4, 110, 0, 0, 0, 4]),
              Buffer.from([67, 0, 0, 0, 13]),
              Buffer.from("SELECT 0\0"),
              Buffer.from([90, 0, 0, 0, 5, 73]),
            ]),
          );
        });
      },
      async (peer) => {
        const trace = recording();
        await Effect.runPromise(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`SELECT ${"synthetic-private-value"}`;
          }).pipe(
            Effect.provide(PgClient.layer(peer.options)),
            Effect.provide(sqlTracing),
            Effect.provideService(Tracer.Tracer, trace.tracer),
          ),
        );
        const statement = trace.spans.find((span) => span.name === "sql.execute");
        const wire = trace.spans.find((span) => span.name === "sql.wire");
        assert.ok(statement && wire);
        assert.equal(Option.getOrUndefined(wire.parent)?.spanId, statement.spanId);
        assert.equal(wire.traceId, statement.traceId);
        assert.equal(
          statement.attributes.get("db.query.text"),
          `SELECT $1\n/*traceparent='00-${statement.traceId}-${statement.spanId}-01'*/`,
        );
      },
    ),
);

test(
  "wire spans distinguish first response from protocol completion without recording values",
  { timeout: 5_000 },
  () =>
    withPeer(
      (socket, processId) => {
        ready(socket, processId);
        socket.once("data", () => {
          setTimeout(() => {
            socket.write(
              Buffer.concat([
                Buffer.from([49, 0, 0, 0, 4]), // ParseComplete
                Buffer.from([50, 0, 0, 0, 4]), // BindComplete
                Buffer.from([110, 0, 0, 0, 4]), // NoData
                Buffer.from([67, 0, 0, 0, 13]),
                Buffer.from("SELECT 0\0"),
              ]),
            );
            setTimeout(() => socket.write(Buffer.from([90, 0, 0, 0, 5, 73])), 25);
          }, 25);
        });
      },
      async (peer) => {
        const trace = recording();
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const connection = yield* PgConnection.make(peer.options);
            return yield* connection.query("SELECT $1", ["synthetic-private-value"]);
          }).pipe(Effect.scoped, Effect.provideService(Tracer.Tracer, trace.tracer)),
        );
        assert.equal(result.rowCount, 0);
        const wire = trace.spans.find((span) => span.name === "sql.wire");
        assert.ok(wire);
        assert.ok(Exit.isSuccess(outcome(wire)));
        const first = wire.attributes.get("db.wire.first_message_ms");
        const complete = wire.attributes.get("db.wire.command_complete_ms");
        const readyAt = wire.attributes.get("db.wire.ready_ms");
        assert.ok(typeof first === "number" && first >= 15);
        assert.ok(typeof complete === "number" && complete >= first);
        assert.ok(typeof readyAt === "number" && readyAt >= complete + 15);
        assert.ok(Number(wire.attributes.get("db.wire.request_bytes")) > 0);
        assert.doesNotMatch(
          JSON.stringify([...wire.attributes]),
          /SELECT|synthetic-private-value|synthetic-user|synthetic-password/,
        );
      },
    ),
);

test("wire failure ends the span and retains the driver connection error", { timeout: 5_000 }, () =>
  withPeer(
    (socket, processId) => {
      ready(socket, processId);
      socket.once("data", () => socket.destroy());
    },
    async (peer) => {
      const trace = recording();
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const connection = yield* PgConnection.make(peer.options);
          return yield* connection.query("SELECT $1", ["synthetic-private-value"]);
        }).pipe(Effect.scoped, Effect.provideService(Tracer.Tracer, trace.tracer)),
      );
      assert.ok(Exit.isFailure(result));
      assert.ok(Schema.is(SqlError)(Cause.squash(result.cause)));
      const wire = trace.spans.find((span) => span.name === "sql.wire");
      assert.ok(wire);
      const exit = outcome(wire);
      assert.ok(Exit.isFailure(exit));
      assert.equal(Cause.squash(exit.cause), Cause.squash(result.cause));
      assert.doesNotMatch(JSON.stringify([...wire.attributes]), /synthetic-private-value/);
    },
  ),
);

test("physical connection spans preserve lazy pool reuse and replacement", { timeout: 5_000 }, () =>
  withPeer(ready, async (peer) => {
    const trace = recording();
    await Effect.runPromise(
      Effect.gen(function* () {
        const pool = yield* PgPool.make({ ...peer.options, maxConnections: 1 });
        assert.equal(peer.connections(), 0);
        assert.equal(trace.connections().length, 0);
        const first = yield* Effect.scoped(pool.get);
        const connected = trace.connections()[0];
        assert.ok(connected);
        assert.ok(Exit.isSuccess(outcome(connected)));
        const reused = yield* Effect.scoped(pool.get);
        assert.equal(reused.processId, first.processId);
        assert.equal(trace.connections().length, 1);
        yield* pool.invalidate(first);
        const replacement = yield* Effect.scoped(pool.get);
        assert.notEqual(replacement.processId, first.processId);
        assert.equal(peer.connections(), 2);
      }).pipe(
        Effect.scoped,
        Effect.withSpan("fixture.read"),
        Effect.provideService(Tracer.Tracer, trace.tracer),
      ),
    );
    const parent = trace.spans.find((span) => span.name === "fixture.read");
    assert.ok(parent);
    assert.equal(trace.connections().length, 2);
    for (const span of trace.connections()) {
      assert.ok(Exit.isSuccess(outcome(span)));
      assert.equal(span.kind, "client");
      assert.equal(Option.getOrUndefined(span.parent)?.spanId, parent.spanId);
      assert.deepEqual([...span.attributes], []);
    }
  }),
);

test(
  "failed connection spans preserve the driver error without connection attributes",
  { timeout: 5_000 },
  () =>
    withPeer(
      (socket) => socket.end(),
      async (peer) => {
        const trace = recording();
        const result = await Effect.runPromiseExit(
          PgConnection.make(peer.options).pipe(
            Effect.scoped,
            Effect.provideService(Tracer.Tracer, trace.tracer),
          ),
        );
        assert.ok(Exit.isFailure(result));
        assert.ok(Schema.is(SqlError)(Cause.squash(result.cause)));
        const span = trace.connections()[0];
        assert.ok(span);
        assert.equal(trace.connections().length, 1);
        const exit = outcome(span);
        assert.ok(Exit.isFailure(exit));
        assert.equal(Cause.squash(exit.cause), Cause.squash(result.cause));
        assert.deepEqual([...span.attributes], []);
      },
    ),
);

test("cancelled connection spans end and release the pending socket", { timeout: 5_000 }, () =>
  withPeer(
    () => {},
    async (peer) => {
      const trace = recording();
      const controller = new AbortController();
      const pending = Effect.runPromiseExit(
        PgConnection.make(peer.options).pipe(
          Effect.scoped,
          Effect.provideService(Tracer.Tracer, trace.tracer),
        ),
        { signal: controller.signal },
      );
      await Effect.runPromise(peer.started);
      controller.abort();
      const result = await pending;
      await Effect.runPromise(peer.closed);
      assert.ok(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));
      const span = trace.connections()[0];
      assert.ok(span);
      const exit = outcome(span);
      assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      assert.deepEqual([...span.attributes], []);
    },
  ),
);
