import { DurableObject } from "cloudflare:workers";
import { Effect, ManagedRuntime, Schema } from "effect";
import * as Sqlite from "@effect/sql-sqlite-do/SqliteClient";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { makeDurableCoordinator, LiveQueryError } from "../../src/cloudflare.ts";
import { QueryId } from "../../src/index.ts";

// Real workerd fixture. The only injected failure is notification delivery after
// a committed write, to exercise the persisted recovery path across eviction.
export class LiveDatabase extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const self = this;
    this.instance = crypto.randomUUID();
    this.suppressDelivery = false;
    this.evaluations = 0;
    this.runtime = ManagedRuntime.make(Sqlite.layer({ storage: ctx.storage }));
    this.ready = ctx.blockConcurrencyWhile(() =>
      this.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          self.sql = sql;
          yield* sql`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`;
          yield* sql`CREATE TABLE IF NOT EXISTS unrelated (id INTEGER PRIMARY KEY)`;
          yield* sql`CREATE TABLE IF NOT EXISTS access (caller TEXT PRIMARY KEY, allowed INTEGER NOT NULL)`;
          yield* sql`INSERT OR IGNORE INTO access (caller, allowed) VALUES ('alice', 1)`;
          const coordinator = yield* makeDurableCoordinator({
            namespace: "test-db",
            sql,
            host: {
              getWebSockets: () => {
                if (self.suppressDelivery) throw new Error("delivery unavailable");
                return ctx.getWebSockets();
              },
              setAlarm: (timestamp) => ctx.storage.setAlarm(timestamp),
              deleteAlarm: () => ctx.storage.deleteAlarm(),
            },
            resolve: (descriptor) =>
              Effect.gen(function* () {
                self.evaluations += 1;
                if (descriptor.query !== "messages")
                  return yield* new LiveQueryError({ code: "unknownQuery" });
                if (descriptor.arguments !== null)
                  return yield* new LiveQueryError({ code: "invalidArguments" });
                const access =
                  yield* sql`SELECT allowed FROM access WHERE caller = ${descriptor.caller}`;
                if (access[0]?.allowed !== 1)
                  return yield* new LiveQueryError({ code: "unauthorized" });
                const rows = yield* sql`SELECT id, body FROM messages ORDER BY id`;
                const value = yield* Schema.decodeUnknownEffect(
                  Schema.Array(Schema.Struct({ id: Schema.Number, body: Schema.String })),
                )(rows);
                return { value, tables: ["messages", "access"] };
              }).pipe(
                Effect.catchTags({
                  SqlError: () => Effect.fail(new LiveQueryError({ code: "failed" })),
                  SchemaError: () => Effect.fail(new LiveQueryError({ code: "failed" })),
                }),
              ),
          });
          yield* coordinator.recover;
          self.coordinator = coordinator;
        }),
      ),
    );
  }

  async fetch(request) {
    const self = this;
    await this.ready;
    const path = new URL(request.url).pathname;
    if (path === "/subscribe") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      await this.runtime.runPromise(
        this.coordinator.subscribe(pair[1], {
          namespace: "test-db",
          query: QueryId.make("messages"),
          arguments: null,
          // Test authentication: supplied by the server, never read from a query.
          caller: "alice",
        }),
      );
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (path === "/stats")
      return Response.json({ instance: this.instance, evaluations: this.evaluations });
    if (path === "/unrelated") {
      await this.runtime.runPromise(
        this.coordinator.mutate(
          ["unrelated"],
          this.sql`INSERT OR IGNORE INTO unrelated (id) VALUES (1)`,
        ),
      );
      return new Response("ok");
    }
    if (path === "/revoke") {
      await this.runtime.runPromise(
        this.coordinator.mutate(
          ["access"],
          this.sql`UPDATE access SET allowed = 0 WHERE caller = 'alice'`,
        ),
      );
      return new Response("ok");
    }
    if (path === "/nested") {
      await this.runtime.runPromise(
        this.coordinator.mutate(
          [],
          Effect.gen(function* () {
            yield* self.coordinator
              .mutate(
                ["messages"],
                Effect.gen(function* () {
                  yield* self.sql`INSERT INTO messages (body) VALUES ('nested rollback')`;
                  return yield* Effect.fail("rollback savepoint");
                }),
              )
              .pipe(Effect.catch(() => Effect.void));
            yield* self.coordinator.mutate(
              ["messages"],
              self.sql`INSERT INTO messages (body) VALUES ('third')`,
            );
          }),
        ),
      );
      return new Response("ok");
    }
    if (path === "/write" || path === "/failed-delivery" || path === "/rollback") {
      const body = await request.text();
      if (path === "/failed-delivery") this.suppressDelivery = true;
      const write = Effect.gen(function* () {
        yield* self.sql`INSERT INTO messages (body) VALUES (${body})`;
        if (path === "/rollback") return yield* Effect.fail("intentional rollback");
      });
      const result = await this.runtime.runPromise(
        this.coordinator.mutate(["messages"], write).pipe(Effect.result),
      );
      return new Response(result._tag === "Success" ? "ok" : "rolled back", {
        status: result._tag === "Success" ? 200 : 409,
      });
    }
    return new Response("not found", { status: 404 });
  }

  async alarm() {
    await this.ready;
    await this.runtime.runPromise(this.coordinator.recover);
  }

  webSocketMessage() {}
  webSocketClose(socket, code, reason) {
    socket.close(code, reason);
  }
  webSocketError(socket) {
    socket.close(1011, "Socket failed");
  }
}

export default {
  fetch(request, env) {
    return env.LIVE.get(env.LIVE.idFromName("database")).fetch(request);
  },
};
