/**
 * How long a deployed run's stage waited for database connections, read once after its scenarios
 * and before teardown. A stage's PlanetScale branch is reached through the stage's own Hyperdrive
 * configuration; when the pool between them runs short, statements wait for a connection, which
 * Hyperdrive reports as connection latency. Production's own configuration stays near 0 ms, so a
 * run far above the morning's 2-6 ms measured a test database's ceiling, not the product.
 *
 * The figure comes from Cloudflare's Hyperdrive analytics for the stage's configuration, found by
 * the runtime role the branch carries. When that cannot be read, it comes from the stage's own
 * spans: per minute, the average `sql.execute` minus the average `sql.wire`, the time a statement
 * spent before its round trip. It informs and never fails or delays a run: every failure is
 * recorded as `unavailable` with its reason, and the whole reading is bounded.
 */
import { Clock, Config, Console, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { reveal, secretConfig } from "../support/failure-text.ts";
import {
  connectionLevel,
  databaseConnectionsFile,
  type DatabaseConnections,
} from "../database-connections.ts";

/** Minutes with fewer statements say little about a pool, so they are not a worst minute. */
const minimumQueries = 100;

/** One minute's statements and their average latency, in milliseconds. */
type Minute = { readonly queries: number; readonly latencyMs: number };

/** The run's figure from its minutes; exported for its spec. */
export const summarize = (source: "hyperdrive" | "spans", minutes: ReadonlyArray<Minute>) => {
  const counted = minutes.filter((minute) => minute.queries >= minimumQueries);
  const queries = counted.reduce((total, minute) => total + minute.queries, 0);
  if (queries === 0) return undefined;
  const averageMs =
    counted.reduce((total, minute) => total + minute.queries * minute.latencyMs, 0) / queries;
  const worstMinuteMs = Math.max(...counted.map((minute) => minute.latencyMs));
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    source,
    level: connectionLevel(averageMs, worstMinuteMs),
    averageMs: round(averageMs),
    worstMinuteMs: round(worstMinuteMs),
    minutes: counted.length,
    queries,
  } satisfies DatabaseConnections;
};

const Roles = Schema.Struct({ data: Schema.Array(Schema.Struct({ username: Schema.String })) });
const Configs = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({ id: Schema.String, origin: Schema.Struct({ user: Schema.String }) }),
  ),
});
const Analytics = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({
      accounts: Schema.Array(
        Schema.Struct({
          hyperdriveQueriesAdaptiveGroups: Schema.Array(
            Schema.Struct({
              count: Schema.Number,
              avg: Schema.Struct({ connectionLatency: Schema.NullOr(Schema.Number) }),
              dimensions: Schema.Struct({ datetimeMinute: Schema.String }),
            }),
          ),
        }),
      ),
    }),
  }),
});
const SpanMinutes = Schema.Struct({
  buckets: Schema.Struct({
    totals: Schema.Array(
      Schema.Struct({
        aggregations: Schema.Array(Schema.Struct({ value: Schema.NullOr(Schema.Number) })),
      }),
    ),
  }),
});

class Unreadable extends Schema.TaggedError<Unreadable>()("Unreadable", {
  note: Schema.String,
}) {}
const unreadable = (note: string) => () => new Unreadable({ note });

/** The stage's connection latency from Cloudflare's Hyperdrive analytics. */
const fromHyperdrive = (stage: string, since: Date) =>
  Effect.gen(function* () {
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const organization = yield* Config.NonEmptyString("PLANETSCALE_ORGANIZATION");
    const database = yield* Config.NonEmptyString("TEST_STAGE_DATABASE");
    const planetscaleId = yield* secretConfig("PLANETSCALE_API_TOKEN_ID");
    const planetscaleToken = yield* secretConfig("PLANETSCALE_API_TOKEN");
    const account = yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID");
    const cloudflare = yield* secretConfig("CLOUDFLARE_API_TOKEN");
    // The branch carries the stage's roles; its Hyperdrive configuration connects as one of them.
    const roles = yield* http
      .execute(
        HttpClientRequest.get(
          `https://api.planetscale.com/v1/organizations/${organization}/databases/${database}/branches/${stage}/roles?per_page=100`,
        ).pipe(
          HttpClientRequest.setHeader(
            "authorization",
            `${reveal(planetscaleId)}:${reveal(planetscaleToken)}`,
          ),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(Roles)),
        Effect.mapError(unreadable("The branch's roles could not be read")),
      );
    const users = new Set(roles.data.map((role) => role.username));
    const configs = yield* http
      .execute(
        HttpClientRequest.get(
          `https://api.cloudflare.com/client/v4/accounts/${account}/hyperdrive/configs?per_page=100`,
        ).pipe(HttpClientRequest.bearerToken(cloudflare)),
      )
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(Configs)),
        Effect.mapError(unreadable("The Hyperdrive configurations could not be listed")),
      );
    const ids = configs.result
      .filter((config) => users.has(config.origin.user))
      .map((config) => config.id);
    if (ids.length === 0)
      return yield* new Unreadable({ note: "No Hyperdrive configuration uses the branch" });
    const until = new Date(yield* Clock.currentTimeMillis);
    const query = `{ viewer { accounts(filter: {accountTag: ${JSON.stringify(account)}}) {
      hyperdriveQueriesAdaptiveGroups(limit: 10000, filter: {configId_in: ${JSON.stringify(ids)}, datetime_geq: ${JSON.stringify(since.toISOString())}, datetime_leq: ${JSON.stringify(until.toISOString())}}) {
        count avg { connectionLatency } dimensions { datetimeMinute }
      } } } }`;
    const analytics = yield* HttpClientRequest.post(
      "https://api.cloudflare.com/client/v4/graphql",
    ).pipe(
      HttpClientRequest.bearerToken(cloudflare),
      HttpClientRequest.bodyJson({ query }),
      Effect.flatMap(http.execute),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(Analytics)),
      Effect.mapError(unreadable("Cloudflare's Hyperdrive analytics could not be read")),
    );
    // Groups of several configurations or cache statuses share a minute; weigh them by count.
    const byMinute = new Map<string, { queries: number; weighted: number }>();
    for (const group of analytics.data.viewer.accounts.flatMap(
      (entry) => entry.hyperdriveQueriesAdaptiveGroups,
    )) {
      const minute = byMinute.get(group.dimensions.datetimeMinute) ?? { queries: 0, weighted: 0 };
      minute.queries += group.count;
      minute.weighted += group.count * (group.avg.connectionLatency ?? 0);
      byMinute.set(group.dimensions.datetimeMinute, minute);
    }
    const summary = summarize(
      "hyperdrive",
      [...byMinute.values()].map(({ queries, weighted }) => ({
        queries,
        latencyMs: weighted / queries,
      })),
    );
    if (summary === undefined)
      return yield* new Unreadable({ note: "Hyperdrive reported no queries for the stage" });
    return summary;
  });

/** The stage's statement time before its round trip, from its own spans. */
const fromSpans = (
  stage: string,
  since: Date,
  axiom: {
    readonly token: Redacted.Redacted<string>;
    readonly organization: string;
    readonly dataset: string;
  },
) =>
  Effect.gen(function* () {
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const apl = `['${axiom.dataset}'] | where ['resource.deployment.environment.name'] == ${JSON.stringify(stage)} and name in ('sql.execute', 'sql.wire') | summarize execute=avgif(duration, name == 'sql.execute'), wire=avgif(duration, name == 'sql.wire'), queries=countif(name == 'sql.execute') by bin(_time, 1m)`;
    const response = yield* HttpClientRequest.post(
      "https://api.axiom.co/v1/datasets/_apl?format=legacy",
    ).pipe(
      HttpClientRequest.bearerToken(axiom.token),
      HttpClientRequest.setHeader("x-axiom-org-id", axiom.organization),
      HttpClientRequest.bodyJson({ apl, startTime: since.toISOString() }),
      Effect.flatMap(http.execute),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(SpanMinutes)),
      Effect.mapError(unreadable("The stage's spans could not be read")),
    );
    // Durations are nanoseconds; each bucket's aggregations are execute, wire and queries.
    const minutes = response.buckets.totals.flatMap(({ aggregations }) => {
      const [execute, wire, queries] = aggregations.map((aggregation) => aggregation.value);
      return execute === null || execute === undefined || wire === null || wire === undefined
        ? []
        : [{ queries: queries ?? 0, latencyMs: Math.max(0, (execute - wire) / 1e6) }];
    });
    const summary = summarize("spans", minutes);
    if (summary === undefined)
      return yield* new Unreadable({ note: "The stage recorded no SQL spans" });
    return summary;
  });

const describe = (record: DatabaseConnections) =>
  record.source === "unavailable"
    ? `Database connection latency: unavailable (${record.note ?? "no reason recorded"}).`
    : `Database connection latency: ${record.level}, average ${record.averageMs} ms, worst minute ${record.worstMinuteMs} ms over ${record.minutes} minutes and ${record.queries} statements, from ${record.source === "hyperdrive" ? "Cloudflare's Hyperdrive analytics" : "the stage's own spans (Hyperdrive's analytics were unavailable)"}${record.note === undefined ? "" : `: ${record.note}`}.`;

/**
 * Read and record the stage's connection latency. Bounded to 45 seconds; never fails.
 */
export const recordDatabaseConnections = (environment: {
  readonly slug: string;
  readonly directory: string;
  readonly startedAt: Date;
  readonly axiom: {
    readonly token: Redacted.Redacted<string>;
    readonly organization: string;
    readonly dataset: string;
  };
}) =>
  Effect.gen(function* () {
    const stage = `test-${environment.slug}`;
    const record: DatabaseConnections = yield* fromHyperdrive(stage, environment.startedAt).pipe(
      Effect.catchTag("Unreadable", ({ note }) =>
        fromSpans(stage, environment.startedAt, environment.axiom).pipe(
          Effect.map((summary) => ({ ...summary, note })),
          Effect.catchTag("Unreadable", (spans) =>
            Effect.succeed<DatabaseConnections>({
              source: "unavailable",
              level: "unknown",
              note: `${note}; ${spans.note}`,
            }),
          ),
        ),
      ),
      Effect.catchTag("ConfigError", () =>
        Effect.succeed<DatabaseConnections>({
          source: "unavailable",
          level: "unknown",
          note: "The run has no credentials to read it",
        }),
      ),
    );
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    yield* fs.writeFileString(
      path.join(environment.directory, databaseConnectionsFile),
      JSON.stringify(record, null, 2),
    );
    yield* Console.log(describe(record));
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
    if (Option.isSome(summary))
      yield* fs.writeFileString(summary.value, `${describe(record)}\n`, { flag: "a" });
  }).pipe(
    Effect.timeout("45 seconds"),
    Effect.catchCause(() =>
      Console.log("Database connection latency: unavailable (the reading did not finish)."),
    ),
  );
