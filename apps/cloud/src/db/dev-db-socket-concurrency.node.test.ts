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
      const staller: Socket = connect(port, "127.0.0.1");
      await new Promise<void>((res, rej) => {
        staller.once("connect", res);
        staller.once("error", rej);
      });
      const startupBody = Buffer.concat([
        Buffer.from([0, 3, 0, 0]),
        Buffer.from("user\0postgres\0database\0postgres\0\0"),
      ]);
      const startup = Buffer.concat([Buffer.alloc(4), startupBody]);
      startup.writeInt32BE(startup.length, 0);
      staller.write(startup);
      // Wait for AuthenticationOk + ReadyForQuery before opening the pipeline,
      // so the Parse is its own data event (and its own queue entry).
      await new Promise<void>((res) => {
        staller.on("data", (chunk: Buffer) => {
          if (chunk.includes(0x5a)) res(); // 'Z' = ReadyForQuery
        });
      });
      const parseBody = Buffer.from("\0select 1\0\0\0");
      const parse = Buffer.concat([Buffer.from("P"), Buffer.alloc(4), parseBody]);
      parse.writeInt32BE(4 + parseBody.length, 1);
      staller.write(parse);

      const bystander = makeClient(port, 10);
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: sockets must be closed on every path
      try {
        // Connects and queries only once the staller is reaped (~250ms).
        expect((await bystander.unsafe(`select 4 as four`))[0]).toEqual({ four: 4 });
      } finally {
        // oxlint-disable-next-line executor/no-promise-catch -- test boundary: a failed teardown must not mask the assertion
        await bystander.end({ timeout: 5 }).catch(() => {});
        staller.destroy();
        await server.stop();
        await db.close();
      }
    },
  );
});
