// Regression for the dev-db PGlite socket protocol-interleaving bug (patched
// in patches/@electric-sql%2Fpglite-socket@0.1.4.patch).
//
// PGLiteSocketServer's QueryQueueManager used to enqueue each postgres wire
// FRAME (Parse, Bind, Execute, Sync) as its own queue entry against the one
// shared PGlite session. With more than one connection (the dev-db now allows
// many — see scripts/dev-db.ts maxConnections), two clients' extended-protocol
// pipelines interleaved: client A's Parse (5 params) ... client B's Parse
// (1 param) ... A's Bind now hits B's unnamed statement:
//
//   PostgresError: bind message supplies 5 parameters, but prepared
//   statement "" requires 1
//
// which surfaced in e2e as random 500s ("Failed to load tools", StorageError)
// on whichever request lost the race — the residual per-spec CI flakes after
// the connection-storm fix. The patch batches all frames of one socket data
// event into a single queue entry and adds handler affinity while a pipeline
// is open, so one client's Parse..Sync executes atomically.
//
// This test drives concurrent clients issuing unprepared parameterized queries
// with DIFFERENT parameter counts (the exact drizzle/postgres-js shape) through
// one PGLiteSocketServer and asserts zero protocol corruption.

import { setTimeout as sleep } from "node:timers/promises";
import { connect, type Socket } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";

const PORT = 45998;
const CLIENTS = 6;
const QUERIES_PER_CLIENT = 40;

const makeClient = (port: number, connectTimeout = 5) =>
  postgres(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: connectTimeout,
    fetch_types: false,
    prepare: true,
    onnotice: () => undefined,
  });

// Hand-rolled wire client: connect and complete the trust-auth startup, so a
// test can then speak raw protocol frames (e.g. a lone Parse) that postgres.js
// would never emit on its own. Resolves after ReadyForQuery so the next write
// is its own data event — and its own queue entry — on the server.
const openWireClient = async (port: number): Promise<Socket> => {
  const socket: Socket = connect(port, "127.0.0.1");
  await new Promise<void>((res, rej) => {
    socket.once("connect", res);
    socket.once("error", rej);
  });
  const startupBody = Buffer.concat([
    Buffer.from([0, 3, 0, 0]),
    Buffer.from("user\0postgres\0database\0postgres\0\0"),
  ]);
  const startup = Buffer.concat([Buffer.alloc(4), startupBody]);
  startup.writeInt32BE(startup.length, 0);
  socket.write(startup);
  await new Promise<void>((res) => {
    socket.on("data", (chunk: Buffer) => {
      if (chunk.includes(0x5a)) res(); // 'Z' = ReadyForQuery
    });
  });
  return socket;
};

/**
 * Run a bystander's query with a bounded deadline and, on the deadline, fail
 * with the server's internals instead of vitest's bare 30s timeout.
 *
 * The reap/ghost scenarios have each wedged ONCE in CI (runs 32933818134 and
 * 33019527020: the bystander's startup was served, then its query hung until
 * the test timeout) while ~800 replays of the isolated scenarios on macOS and
 * Linux, idle and CPU-starved, never reproduced it. Until it fires again there
 * is nothing to fix, so make the next occurrence carry its own diagnosis:
 * the queue/handler stats at wedge time, plus whether a FRESH connection still
 * completes startup (a latched queue serves nobody; per-handler affinity
 * pinning still answers new startups).
 */
const diagnoseWedge = async <T>(
  run: () => Promise<T>,
  context: { readonly server: PGLiteSocketServer; readonly port: number },
  deadlineMs = 20_000,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void (async () => {
        const stats = JSON.stringify(context.server.getStats());
        // oxlint-disable-next-line executor/no-promise-catch -- test boundary: the probe outcome is diagnostic text, never a failure path
        const freshStartup = await Promise.race([
          openWireClient(context.port).then((socket) => {
            socket.destroy();
            return "completes";
          }),
          sleep(3_000).then(() => "hangs"),
        ]).catch(() => "errors");
        // oxlint-disable-next-line executor/no-promise-reject -- test boundary: adapt the deadline to the assertion path with the diagnosis attached
        reject(
          // oxlint-disable-next-line executor/no-error-constructor -- test boundary: the diagnosis rides the assertion failure
          new Error(
            `bystander wedged for ${deadlineMs}ms; server stats=${stats}; fresh startup ${freshStartup}`,
          ),
        );
      })();
    }, deadlineMs);
  });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: the deadline timer must be cleared on every path
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

// A Parse frame for an unnamed statement: opens an extended-protocol pipeline
// that only a later Sync (or the server's recovery) closes.
const parseFrame = (query: string): Buffer => {
  const body = Buffer.concat([Buffer.from(`\0${query}\0`), Buffer.from([0, 0])]);
  const frame = Buffer.concat([Buffer.from("P"), Buffer.alloc(4), body]);
  frame.writeInt32BE(4 + body.length, 1);
  return frame;
};

describe("dev-db PGlite socket under concurrent connections", () => {
  it(
    "serves interleaved multi-connection pipelines without protocol corruption",
    { timeout: 60_000 },
    async () => {
      const db = await PGlite.create();
      const server = new PGLiteSocketServer({
        db,
        port: PORT,
        host: "127.0.0.1",
        maxConnections: 100,
      });
      await server.start();

      let ok = 0;
      const errors: string[] = [];

      const worker = async (id: number) => {
        const sql = makeClient(PORT, 10);
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: postgres.js is promise-native and the socket must be closed on every path
        try {
          for (let q = 0; q < QUERIES_PER_CLIENT; q++) {
            // Alternate 1-param and 5-param unprepared queries: maximally
            // collision-prone unnamed-statement shapes across connections.
            if ((id + q) % 2 === 0) {
              await sql.unsafe(`select $1::int as one`, [1]);
            } else {
              await sql.unsafe(`select $1::int, $2::text, $3::text, $4::text, $5::text`, [
                1,
                "b",
                "c",
                "d",
                "e",
              ]);
            }
            ok++;
          }
        } catch (cause) {
          // oxlint-disable-next-line executor/no-unknown-error-message -- test boundary: the raw PostgresError message IS the assertion payload
          errors.push(String(cause));
        } finally {
          // oxlint-disable-next-line executor/no-promise-catch -- test boundary: postgres.js is promise-native; a failed teardown must not mask the assertion
          await sql.end({ timeout: 5 }).catch(() => {});
        }
      };

      await Promise.all(Array.from({ length: CLIENTS }, (_, i) => worker(i)));
      await server.stop();
      await db.close();

      expect(errors, `protocol corruption under concurrency:\n${errors.join("\n")}`).toEqual([]);
      expect(ok).toBe(CLIENTS * QUERIES_PER_CLIENT);
    },
  );

  // Regression for the CI e2e "cloud signIn: callback set no session (500)"
  // cascade: QueryQueueManager.processQueue used to `return` out of its drain
  // loop when a query REJECTED (as opposed to returning a wire-level
  // ErrorResponse), leaving `processing` latched true. From then on every
  // enqueue — including brand-new connections' startup packets — sat in the
  // queue forever: in-flight requests hung, postgres.js reconnects died with
  // CONNECT_TIMEOUT, and the whole dev stack was bricked until restart. The
  // patch rejects the one entry, drops pipeline affinity, and keeps draining.
  it(
    "a rejected query fails one client, not the whole socket server",
    { timeout: 30_000 },
    async () => {
      const port = 45997;
      const db = await PGlite.create();
      const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 100 });
      await server.start();

      const first = makeClient(port);
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: sockets must be closed on every path
      try {
        expect((await first.unsafe(`select 1 as one`))[0]).toEqual({ one: 1 });

        // Force the NEXT protocol exchange to reject at the JS level, the shape
        // PGlite produces when the shared session is broken mid-run.
        const real = db.execProtocolRawStream.bind(db);
        let arm = true;
        (db as { execProtocolRawStream: typeof real }).execProtocolRawStream = (...args) => {
          if (arm) {
            arm = false;
            // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- test boundary: simulating a PGlite internal failure requires a raw throw
            throw new Error("synthetic PGlite failure");
          }
          return real(...args);
        };

        await expect(first.unsafe(`select 2 as two`)).rejects.toThrow();

        // The poisoned entry must take down only its own connection: a fresh
        // client (new socket, full startup handshake) still gets served.
        const second = makeClient(port);
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: sockets must be closed on every path
        try {
          expect((await second.unsafe(`select 3 as three`))[0]).toEqual({ three: 3 });
        } finally {
          // oxlint-disable-next-line executor/no-promise-catch -- test boundary: a failed teardown must not mask the assertion
          await second.end({ timeout: 5 }).catch(() => {});
        }
      } finally {
        // oxlint-disable-next-line executor/no-promise-catch -- test boundary: a failed teardown must not mask the assertion
        await first.end({ timeout: 5 }).catch(() => {});
        await server.stop();
        await db.close();
      }
    },
  );

  // Regression for the sporadic `write CONNECTION_ENDED` 500s: the server's
  // idleTimeout backstop used to kill ANY connection with no traffic for the
  // window, which is the resting state of every healthy postgres.js pool
  // connection (idle_timeout: 0) held by a long-lived scope. The backstop now
  // only fires on a connection that is actually blocking the shared session —
  // an open pipeline or an open transaction.
  it("an idle-at-rest connection outlives the idle backstop", { timeout: 30_000 }, async () => {
    const port = 45996;
    const db = await PGlite.create();
    const server = new PGLiteSocketServer({
      db,
      port,
      host: "127.0.0.1",
      maxConnections: 100,
      idleTimeout: 250,
    });
    await server.start();

    const sql = makeClient(port);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: sockets must be closed on every path
    try {
      expect((await sql.unsafe(`select 1 as one`))[0]).toEqual({ one: 1 });
      await sleep(900);
      expect((await sql.unsafe(`select 2 as two`))[0]).toEqual({ two: 2 });
    } finally {
      // oxlint-disable-next-line executor/no-promise-catch -- test boundary: a failed teardown must not mask the assertion
      await sql.end({ timeout: 5 }).catch(() => {});
      await server.stop();
      await db.close();
    }
  });

  // The backstop's actual job still works: a client that opens a pipeline
  // (Parse sent, never Sync) and goes silent holds queue affinity, which
  // starves every other connection. The idle timer must reap exactly that
  // client and hand the queue back.
  it(
    "a client stalled mid-pipeline is reaped and the queue recovers",
    { timeout: 30_000 },
    async () => {
      const port = 45995;
      const db = await PGlite.create();
      const server = new PGLiteSocketServer({
        db,
        port,
        host: "127.0.0.1",
        maxConnections: 100,
        idleTimeout: 250,
      });
      await server.start();

      // Hand-rolled wire client: complete the trust-auth startup, then send a
      // lone Parse. Its last frame type ('P') marks the pipeline open, so the
      // handler takes affinity and every other connection queues behind it.
      const staller = await openWireClient(port);
      staller.write(parseFrame("select 1"));

      const bystander = makeClient(port, 10);
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: sockets must be closed on every path
      try {
        // Connects and queries only once the staller is reaped (~250ms).
        expect(
          (await diagnoseWedge(() => bystander.unsafe(`select 4 as four`), { server, port }))[0],
        ).toEqual({ four: 4 });
      } finally {
        // oxlint-disable-next-line executor/no-promise-catch -- test boundary: a failed teardown must not mask the assertion
        await bystander.end({ timeout: 5 }).catch(() => {});
        staller.destroy();
        await server.stop();
        await db.close();
      }
    },
  );

  // Regression for the reap SLOT LEAK: detach(true) removes the socket's
  // listeners before destroying it, so a server-initiated teardown (the idle
  // backstop) never fired the server's 'close' bookkeeping — the reaped
  // handler stayed in the server's handlers set forever, burning one
  // maxConnections slot per reap. Enough reaps over a long run and the server
  // answers every NEW connection with "Too many connections" while the
  // process, the port, and PGlite are all healthy — postgres.js surfaces that
  // as the same CONNECT_TIMEOUT cascade as the queue wedges. The server now
  // drops the handler when it dispatches its terminal error.
  it("reaped handlers release their connection slots", { timeout: 30_000 }, async () => {
    const port = 45993;
    const db = await PGlite.create();
    const server = new PGLiteSocketServer({
      db,
      port,
      host: "127.0.0.1",
      maxConnections: 2,
      idleTimeout: 250,
    });
    await server.start();

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: sockets must be closed on every path
    try {
      // Burn through more reaps than there are slots: each staller opens a
      // pipeline and goes silent, so the idle backstop reaps it (the server
      // destroys the socket — its 'close' marks that reap complete).
      for (let i = 0; i < 3; i++) {
        const staller = await openWireClient(port);
        staller.write(parseFrame(`select ${i + 1}`));
        await new Promise<void>((res) => staller.once("close", res));
      }

      expect(
        server.getStats().activeConnections,
        "reaped handlers stay counted against maxConnections",
      ).toBe(0);

      const sql = makeClient(port);
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: sockets must be closed on every path
      try {
        expect((await sql.unsafe(`select 6 as six`))[0]).toEqual({ six: 6 });
      } finally {
        // oxlint-disable-next-line executor/no-promise-catch -- test boundary: a failed teardown must not mask the assertion
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    } finally {
      await server.stop();
      await db.close();
    }
  });

  // Regression for the second wedge mode behind the same CI cascade: a client
  // whose socket dies WHILE its pipeline-opening entry is executing. detach()
  // clears pipeline affinity before the entry finishes, so the queue then
  // assigned affinity to the already-dead handler — and nothing ever cleared
  // it: the dead handler has no timers left, and every other connection
  // (including fresh startups) queued behind the ghost forever. The queue now
  // tracks detached handlers and repairs affinity they can no longer release.
  it(
    "a client that dies mid-execution does not leave the queue pinned to its ghost",
    { timeout: 30_000 },
    async () => {
      const port = 45994;
      const db = await PGlite.create();

      // Hold the marker query in flight long enough that the disconnect below
      // reliably lands while the entry is EXECUTING (after detach's cleanup,
      // before the queue takes affinity for it).
      const real = db.execProtocolRawStream.bind(db);
      (db as { execProtocolRawStream: typeof real }).execProtocolRawStream = async (...args) => {
        if (Buffer.from(args[0]).includes("ghost_marker")) await sleep(300);
        return real(...args);
      };

      const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 100 });
      await server.start();

      const ghost = await openWireClient(port);
      ghost.write(parseFrame("select 'ghost_marker'"));
      // Give the data event time to reach the queue and start executing, then
      // die without a trace mid-flight.
      await sleep(100);
      ghost.destroy();

      const bystander = makeClient(port);
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: sockets must be closed on every path
      try {
        expect(
          (await diagnoseWedge(() => bystander.unsafe(`select 5 as five`), { server, port }))[0],
        ).toEqual({ five: 5 });
      } finally {
        // oxlint-disable-next-line executor/no-promise-catch -- test boundary: a failed teardown must not mask the assertion
        await bystander.end({ timeout: 5 }).catch(() => {});
        await server.stop();
        await db.close();
      }
    },
  );
});
