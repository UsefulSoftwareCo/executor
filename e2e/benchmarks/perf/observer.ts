/**
 * Database-side observer for a perf stage's PlanetScale branch.
 *
 * It creates a short-lived monitoring role (pg_monitor, TTL) through the PlanetScale API, then
 * samples pg_stat_activity and blocking PIDs with psql `\watch`. Each sample records only backend
 * state, wait events, ages, the statement's leading keyword and its SQLCommenter traceparent, so a
 * slow `sql.wire` span can be matched to what the origin was doing. SQL text, parameters, rows
 * and credentials are never written. The role password stays in this process's memory.
 */
import { Config, Console, Effect, FileSystem, Redacted, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { randomBytes } from "node:crypto";
import { perfSlug } from "./stage.ts";

export class ObserverFailed extends Schema.TaggedError<ObserverFailed>()("ObserverFailed", {
  message: Schema.String,
}) {}

const Role = Schema.Struct({
  id: Schema.String,
  access_host_url: Schema.String,
  username: Schema.String,
  password: Schema.NullOr(Schema.String),
  database_name: Schema.String,
});

/** One backend in one sample. Ages are milliseconds; `tp` is the statement's traceparent. */
export const Backend = Schema.Struct({
  pid: Schema.Number,
  user: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
  wt: Schema.NullOr(Schema.String),
  we: Schema.NullOr(Schema.String),
  xact: Schema.NullOr(Schema.Number),
  q: Schema.NullOr(Schema.Number),
  st: Schema.NullOr(Schema.Number),
  b: Schema.NullOr(Schema.Number),
  verb: Schema.NullOr(Schema.String),
  tp: Schema.NullOr(Schema.String),
  blockedBy: Schema.Array(Schema.Number),
});
export const Observation = Schema.Struct({
  t: Schema.Number,
  max: Schema.Number,
  reserved: Schema.optional(Schema.Number),
  rows: Schema.Array(Backend),
});
export type Observation = typeof Observation.Type;

const sampleSql = `SELECT json_build_object(
  't', round(extract(epoch from clock_timestamp()) * 1000),
  'max', current_setting('max_connections')::int,
  'reserved', current_setting('superuser_reserved_connections')::int
    + coalesce(nullif(current_setting('reserved_connections', true), ''), '0')::int,
  'rows', coalesce((SELECT json_agg(json_build_object(
    'pid', a.pid, 'user', a.usename, 'state', a.state,
    'wt', a.wait_event_type, 'we', a.wait_event,
    'xact', round(extract(epoch from clock_timestamp() - a.xact_start) * 1000),
    'q', round(extract(epoch from clock_timestamp() - a.query_start) * 1000),
    'st', round(extract(epoch from clock_timestamp() - a.state_change) * 1000),
    'b', round(extract(epoch from clock_timestamp() - a.backend_start) * 1000),
    'verb', upper(split_part(regexp_replace(a.query, '^\\s+', ''), ' ', 1)),
    'tp', substring(a.query from 'traceparent=''([0-9a-f-]{55})'''),
    'blockedBy', to_json(pg_blocking_pids(a.pid))))
   FROM pg_stat_activity a
   WHERE a.backend_type = 'client backend' AND a.pid <> pg_backend_pid()
     AND a.datname = current_database()), '[]'::json))::text AS sample`;

const planetscale = (method: "POST" | "DELETE", path: string, body?: unknown) =>
  Effect.gen(function* () {
    const id = yield* Config.Redacted("PLANETSCALE_API_TOKEN_ID");
    const token = yield* Config.Redacted("PLANETSCALE_API_TOKEN");
    let request = HttpClientRequest.make(method)(`https://api.planetscale.com/v1${path}`).pipe(
      HttpClientRequest.setHeader(
        "authorization",
        `${Redacted.value(id)}:${Redacted.value(token)}`,
      ),
    );
    if (body !== undefined) request = yield* HttpClientRequest.bodyJson(request, body);
    const response = yield* (yield* HttpClient.HttpClient).execute(request);
    if (response.status >= 300)
      return yield* new ObserverFailed({
        message: `PlanetScale ${method} ${path.replace(/\/roles\/.*/, "/roles/…")} returned ${response.status}`,
      });
    return method === "DELETE" ? null : yield* response.json;
  });

/** Observe `test-<slug>` for `seconds`, appending one JSON observation per line to `output`. */
export const observe = (input: {
  readonly slug: string;
  readonly output: string;
  readonly seconds: number;
  readonly intervalMs: number;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      // Share the harness's stage-name guard so the observer never reaches another branch.
      yield* Schema.decodeUnknownEffect(perfSlug)(input.slug).pipe(
        Effect.mapError((error) => new ObserverFailed({ message: error.message })),
      );
      const organization = yield* Config.NonEmptyString("PLANETSCALE_ORGANIZATION");
      const database = yield* Config.NonEmptyString("TEST_STAGE_DATABASE");
      const branch = `test-${input.slug}`;
      const base = `/organizations/${organization}/databases/${database}/branches/${branch}/roles`;
      const role = yield* planetscale("POST", base, {
        name: `perf-observer-${randomBytes(4).toString("hex")}`,
        ttl: Math.max(600, input.seconds + 600),
        inherited_roles: ["pg_monitor", "pg_read_all_stats"],
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Role)));
      yield* Effect.addFinalizer(() =>
        planetscale("DELETE", `${base}/${role.id}`).pipe(Effect.ignore),
      );
      if (role.password === null)
        return yield* new ObserverFailed({ message: "PlanetScale returned no role password" });
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // New roles take a moment to propagate; wait for a successful login first.
      const env = {
        PGHOST: role.access_host_url,
        PGUSER: role.username,
        PGPASSWORD: role.password,
        PGDATABASE: role.database_name,
        PGSSLMODE: "require",
        PGCONNECT_TIMEOUT: "10",
        PATH: process.env.PATH ?? "",
      };
      yield* spawner
        .exitCode(
          ChildProcess.make("psql", ["-X", "-q", "-c", "select 1"], {
            env,
            extendEnv: false,
            stdout: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : Effect.fail(new ObserverFailed({ message: "psql login failed" })),
          ),
          Effect.retry({ times: 20, schedule: Schedule.spaced("3 seconds") }),
        );
      yield* Console.log(`Observing ${branch} for ${input.seconds} s → ${input.output}`);
      const child = yield* spawner.spawn(
        ChildProcess.make("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
          env,
          extendEnv: false,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const ticks = Math.ceil((input.seconds * 1000) / input.intervalMs);
      const script = `${sampleSql}\n\\watch i=${input.intervalMs / 1000} c=${ticks}\n`;
      yield* Stream.make(new TextEncoder().encode(script)).pipe(
        Stream.run(child.stdin),
        Effect.forkScoped,
      );
      yield* fs.writeFileString(input.output, "");
      let count = 0;
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.startsWith("{")),
        Stream.runForEach((line) => {
          count++;
          return fs.writeFileString(input.output, `${line}\n`, { flag: "a" });
        }),
      );
      yield* Console.log(`Wrote ${count} observations.`);
    }),
  );

/** Summaries: origin connections by state, lock waits, and blocked statements' traceparents. */
export const summarizeObservations = (lines: readonly Observation[]) => {
  const perSample = lines.map((line) => {
    const busy = line.rows.filter(
      (row) => row.state === "active" || row.state === "idle in transaction",
    );
    return {
      t: line.t,
      total: line.rows.length,
      active: line.rows.filter((row) => row.state === "active").length,
      idleInTransaction: line.rows.filter((row) => row.state === "idle in transaction").length,
      busy: busy.length,
      lockWaits: line.rows.filter((row) => row.wt === "Lock").length,
      longestTransactionMs: Math.max(0, ...line.rows.map((row) => row.xact ?? 0)),
    };
  });
  const blocked = lines.flatMap((line) =>
    line.rows
      .filter((row) => row.blockedBy.length > 0 || row.wt === "Lock")
      .map((row) => ({
        t: line.t,
        pid: row.pid,
        waitMs: row.q,
        verb: row.verb,
        traceparent: row.tp,
        blockedBy: row.blockedBy,
      })),
  );
  const max = (key: keyof (typeof perSample)[number]) =>
    Math.max(0, ...perSample.map((sample) => sample[key]));
  const histogram = (key: "busy" | "total") => {
    const counts: Record<string, number> = {};
    for (const sample of perSample) counts[sample[key]] = (counts[sample[key]] ?? 0) + 1;
    return counts;
  };
  return {
    samples: lines.length,
    maxConnections: lines[0]?.max ?? null,
    reservedConnections: lines[0]?.reserved ?? null,
    maxBackends: max("total"),
    maxBusy: max("busy"),
    maxIdleInTransaction: max("idleInTransaction"),
    maxLockWaits: max("lockWaits"),
    longestTransactionMs: max("longestTransactionMs"),
    busyHistogram: histogram("busy"),
    backendHistogram: histogram("total"),
    blocked,
  };
};
