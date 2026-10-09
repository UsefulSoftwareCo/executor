/**
 * Cloud closes a request's SQL client when the request ends, but Better Auth can leave a query
 * running past the response: listing API keys starts a delete of expired keys without awaiting
 * it. The request keeps its connection until such a query finishes, and once its wait runs out it
 * cancels the query, reports it, and closes the client only after the statement has stopped.
 *
 * Each scenario creates an expired key and holds a row lock on it, so the plugin's delete waits
 * on that lock for exactly as long as the scenario chooses. The lock pauses every such delete in
 * the Cloud database, so these scenarios get their own Cloud. One also stops the delete's database
 * backend, so its connection answers nothing, not even the cancellation.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, Option, Schedule, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { cloudLocks } from "../support/cloud-locks.ts";
import type { SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { awaitSentryEvents, traceExceptionTypes } from "../support/sentry-events.ts";

const SessionBody = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });
const Holder = Schema.Tuple([Schema.Struct({ pid: Schema.Number })]);
const Activity = Schema.Struct({ pid: Schema.Number, state: Schema.NullOr(Schema.String) });

/** A request under a new trace, so its spans and error reports can be found afterwards. */
const traced = (actor: Session, path: string) =>
  Effect.gen(function* () {
    const traceId = randomBytes(16).toString("hex");
    const response = yield* actor.send("GET", path, undefined, {
      traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
    });
    expect(response.status).toBe(200);
    return { traceId, response };
  });

type Span = (typeof SpanQuery.Type)["data"][number]["span"];

const isAuthQuery = (span: Span) => span.operationName === "auth.sql.timing";

/** The plugin's delete of expired keys: the query whose fate each scenario checks. */
const isCleanup = (span: Span) =>
  isAuthQuery(span) &&
  span.tags["db.query.kind"] === "DeleteQueryNode" &&
  span.tags["db.collection.name"] === "apikey";

/** The request's report of the Better Auth work it had to cancel. */
const isUnsettled = (span: Span) => span.operationName === "auth.invocation.unsettled";

/**
 * The spans of one trace, once its request has ended and exported the ones `until` needs, looked
 * for until `by` (epoch milliseconds; 20 seconds from now unless given).
 */
const traceSpans = (
  traceId: string,
  until: (spans: ReadonlyArray<Span>) => boolean,
  by = Date.now() + 20_000,
) =>
  Effect.flatMap(Telemetry, (telemetry) => telemetry.query(traceId)).pipe(
    Effect.map((found) => found.data.map(({ span }) => span)),
    Effect.filterOrFail(until, () => new Error(`The spans of trace ${traceId} have not arrived`)),
    Effect.retry({ schedule: Schedule.spaced("500 millis"), while: () => Date.now() < by }),
  );

/**
 * An expired API key of the owner, locked by the fixture's open transaction, and a way to list
 * keys until the plugin's delete waits on that lock. The plugin deletes at most once every 10
 * seconds in an isolate, and any request may be the one that does, so a listing that finds no
 * waiting delete tries again after that interval.
 */
const heldCleanup = Effect.gen(function* () {
  const actors = yield* Actors,
    locks = yield* cloudLocks,
    evidence = yield* Evidence;
  const owner = yield* traced(actors.owner, "/api/auth/get-session").pipe(
    Effect.flatMap(({ response }) => body(SessionBody, response)),
  );
  const key = randomUUID();
  yield* locks.run({
    sql: `insert into apikey (id, "configId", name, prefix, start, key, "referenceId", enabled,
      "rateLimitEnabled", "rateLimitTimeWindow", "rateLimitMax", "requestCount", "createdAt",
      "updatedAt", "expiresAt")
      values ($1, 'default', 'Expired', 'exp_', 'exp_ex', $2, $3, true, false, 86400000, 10, 0,
        now() - interval '2 days', now() - interval '2 days', now() - interval '1 day')`,
    params: [key, randomBytes(32).toString("base64url"), owner.user.id],
  });
  // Release first: the delete would otherwise wait on the scenario's own lock.
  yield* Effect.addFinalizer(() =>
    locks.release.pipe(
      Effect.andThen(locks.run({ sql: "delete from apikey where id = $1", params: [key] })),
      Effect.asVoid,
    ),
  );
  const [holder] = yield* locks
    .hold({ sql: "select pg_backend_pid() as pid" })
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Holder)), Effect.orDie);
  yield* locks.hold({ sql: "select id from apikey where id = $1 for update", params: [key] });
  const waiting = locks
    .run({
      sql: `select pid, state from pg_stat_activity
        where $1 = any(pg_blocking_pids(pid)) and query ilike 'delete from "apikey"%'`,
      params: [holder.pid],
    })
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Activity))), Effect.orDie);
  const keyExists = locks
    .run({ sql: "select id from apikey where id = $1", params: [key] })
    .pipe(Effect.map((rows) => rows.length === 1));
  const attempt = Effect.gen(function* () {
    const started = Date.now();
    const { traceId } = yield* traced(actors.owner, "/api/auth/api-key/list");
    const responded = Date.now() - started;
    const blocked = yield* waiting.pipe(
      Effect.filterOrFail((rows) => rows.length > 0),
      Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 30 }),
      Effect.option,
    );
    return { traceId, started, responded, blocked };
  });
  const listing = yield* attempt.pipe(
    Effect.filterOrFail(
      ({ blocked }) => Option.isSome(blocked),
      () => new Error("No listing's expired-key delete waited on the scenario's lock"),
    ),
    Effect.retry({ schedule: Schedule.spaced("10500 millis"), times: 2 }),
    Effect.orDie,
  );
  const backend = Option.getOrThrow(listing.blocked)[0]!;
  yield* evidence.json("held-cleanup.json", {
    traceId: listing.traceId,
    responseMs: listing.responded,
  });
  return { ...listing, backend, locks, waiting, keyExists };
});

layer(HostedLive, { excludeTestServices: true })("Auth cleanup", (it) => {
  it.effect(scenarios.authCleanupAfterResponse.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const held = yield* heldCleanup;
        // The listing answered while its delete still waited on the lock.
        expect(held.responded, "the listing answered before its cleanup").toBeLessThan(5_000);
        yield* Effect.sleep("1 second");
        expect((yield* held.waiting).map(({ pid }) => pid)).toContain(held.backend.pid);
        yield* held.locks.release;

        // The delete finishes on the request's connection: the expired key is gone and its
        // query, reported in the listing's own trace, succeeded.
        yield* held.keyExists.pipe(
          Effect.filterOrFail(
            (exists) => !exists,
            () => new Error("The expired key outlived the released lock: its delete never ran"),
          ),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 25 }),
          Effect.orDie,
        );
        const spans = yield* traceSpans(held.traceId, (spans) => spans.some(isCleanup));
        const deletes = spans.filter(isCleanup);
        expect(deletes).toHaveLength(1);
        expect(deletes[0]!.tags["db.query.success"]).toBe("true");
        expect(spans.filter((span) => isAuthQuery(span) && span.status === "error")).toEqual([]);
      }),
    ),
  );

  it.effect(scenarios.authCleanupTimeout.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const held = yield* heldCleanup;
        // Still holding the lock: the request stops waiting after its 10 second bound and
        // cancels the delete, which leaves the lock queue instead of running later.
        yield* held.waiting.pipe(
          Effect.filterOrFail(
            (rows) => !rows.some(({ pid }) => pid === held.backend.pid),
            () => new Error("The held delete still waited on the lock 20 seconds later"),
          ),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          Effect.orDie,
        );
        const cancelledAfter = Date.now() - held.started;
        expect(cancelledAfter).toBeGreaterThan(9_000);
        expect(cancelledAfter).toBeLessThan(16_000);
        yield* held.locks.release;
        yield* Effect.sleep("1 second");
        expect(yield* held.keyExists, "the cancelled delete did not run").toBe(true);

        // The cut-off query is an interruption, never a database failure, and the request
        // reports the work it had to cancel.
        const spans = yield* traceSpans(
          held.traceId,
          (spans) => spans.some(isCleanup) && spans.some(isUnsettled),
        );
        const deletes = spans.filter(isCleanup);
        expect(deletes).toHaveLength(1);
        expect(deletes[0]!.status).toBe("error");
        expect(
          spans.filter(
            (span) => isAuthQuery(span) && span.tags["db.query.error_code"] !== undefined,
          ),
        ).toEqual([]);
        // Each report is sent on its own, so wait until both have arrived.
        const events = yield* awaitSentryEvents((events) => {
          const types = traceExceptionTypes(events, held.traceId);
          return types.includes("AuthWorkUnsettled") && types.includes("AuthQueryInterrupted");
        });
        const types = traceExceptionTypes(events, held.traceId);
        expect(types).not.toContain("AuthDatabaseFailed");
        yield* Effect.flatMap(Evidence, (evidence) =>
          evidence.json("cancelled-cleanup.json", { cancelledAfter, types }),
        );
      }),
    ),
  );

  it.effect(scenarios.authCleanupStalled.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const held = yield* heldCleanup;
        const pid = held.backend.pid;
        // The delete's backend stops: neither the delete nor its cancellation gets an answer.
        // The scenario's scope resumes it if the scenario ends first.
        yield* held.locks.stop(pid);

        // After its 10 second wait the request cancels the delete and gives the silent
        // connection up after the SQL client's drain bound, 25 seconds after its response at
        // the latest, and then exports its spans. The collector answers at once, so they arrive
        // inside Cloudflare's 30 seconds.
        const spans = yield* traceSpans(
          held.traceId,
          (spans) => spans.some(isCleanup) && spans.some(isUnsettled),
          held.started + 28_000,
        );
        const exportedAfter = Date.now() - held.started;
        expect(exportedAfter, "the cancellation got no answer").toBeGreaterThan(14_000);
        const deletes = spans.filter(isCleanup);
        expect(deletes).toHaveLength(1);
        expect(deletes[0]!.status).toBe("error");
        const gaveUpAfter =
          Date.parse(deletes[0]!.startTime) + deletes[0]!.durationMs - held.started;
        expect(gaveUpAfter, "the delete was given up by the cleanup deadline").toBeLessThan(
          held.responded + 25_000,
        );
        expect(
          spans.filter(
            (span) => isAuthQuery(span) && span.tags["db.query.error_code"] !== undefined,
          ),
        ).toEqual([]);

        // The client closed that connection instead of returning it to its pool: once resumed,
        // the backend finds its socket closed and exits, and the delete never ran.
        yield* held.locks.resume(pid);
        yield* held.locks
          .run({ sql: "select pid from pg_stat_activity where pid = $1", params: [pid] })
          .pipe(
            Effect.filterOrFail(
              (rows) => rows.length === 0,
              () => new Error("The given-up connection's backend is still running"),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 25 }),
            Effect.orDie,
          );
        yield* held.locks.release;
        yield* Effect.sleep("1 second");
        expect(yield* held.keyExists, "the abandoned delete did not run").toBe(true);

        const events = yield* awaitSentryEvents((events) => {
          const types = traceExceptionTypes(events, held.traceId);
          return types.includes("AuthWorkUnsettled") && types.includes("AuthQueryInterrupted");
        });
        const types = traceExceptionTypes(events, held.traceId);
        expect(types).not.toContain("AuthDatabaseFailed");
        yield* Effect.flatMap(Evidence, (evidence) =>
          evidence.json("stalled-cleanup.json", { exportedAfter, gaveUpAfter, types }),
        );
      }),
    ),
  );
});
