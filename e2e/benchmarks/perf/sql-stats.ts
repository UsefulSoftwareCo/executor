/**
 * SQL span statistics for a perf stage window, from executor-next-test-traces.
 *
 * Foreground means spans in the traces the load runner sent (its sampled traceparents); everything
 * else in the window on that stage is background (schedules, queues, workflows). Only span names,
 * durations and numeric wire attributes are read.
 */
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { dataset } from "./flamechart.ts";

export class SqlStatsFailed extends Schema.TaggedError<SqlStatsFailed>()("SqlStatsFailed", {
  message: Schema.String,
}) {}

const Tabular = Schema.Struct({
  tables: Schema.Array(
    Schema.Struct({
      fields: Schema.Array(Schema.Struct({ name: Schema.String })),
      columns: Schema.Array(Schema.Array(Schema.Unknown)),
    }),
  ),
});

/** Run one APL query and return its first table as records. */
export const apl = (query: string, from: Date, to: Date) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("AXIOM_TOKEN");
    const organization = yield* Config.option(Config.NonEmptyString("AXIOM_ORG_ID"));
    const request = yield* HttpClientRequest.post(
      "https://api.axiom.co/v1/datasets/_apl?format=tabular",
    ).pipe(
      HttpClientRequest.bearerToken(Redacted.value(token)),
      HttpClientRequest.setHeaders(
        Option.isSome(organization) ? { "x-axiom-org-id": organization.value } : {},
      ),
      HttpClientRequest.bodyJson({
        apl: query,
        startTime: from.toISOString(),
        endTime: to.toISOString(),
      }),
    );
    const response = yield* (yield* HttpClient.HttpClient).execute(request);
    if (response.status !== 200)
      return yield* new SqlStatsFailed({
        message: `Axiom ${response.status}: ${(yield* response.text).slice(0, 300)}`,
      });
    const payload = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Tabular)));
    const table = payload.tables[0];
    if (table === undefined) return [];
    const count = table.columns[0]?.length ?? 0;
    return Array.from({ length: count }, (_, row) =>
      Object.fromEntries(
        table.fields.map((field, index) => [field.name, table.columns[index]?.[row] ?? null]),
      ),
    );
  });

const number = (value: unknown) => (typeof value === "number" ? Math.round(value * 10) / 10 : 0);

/** Aggregate SQL spans for the given traces (foreground) and the rest of the stage (background). */
export const sqlStats = (input: {
  readonly slug: string;
  readonly from: Date;
  readonly to: Date;
  readonly traceIds: readonly string[];
}) =>
  Effect.gen(function* () {
    if (!/^[a-z0-9-]+$/.test(input.slug))
      return yield* new SqlStatsFailed({ message: "Invalid stage slug" });
    const traces = input.traceIds.filter((id) => /^[a-f0-9]{32}$/.test(id));
    const environment = `['resource.deployment.environment.name'] == 'test-${input.slug}'`;
    const names = `name in ('sql.execute', 'sql.wire', 'sql.connect', 'sql.transaction', 'auth.sql.timing')`;
    const metrics = `n = count(),
      p50 = percentile(duration / 1ms, 50), p95 = percentile(duration / 1ms, 95),
      p99 = percentile(duration / 1ms, 99), max = max(duration / 1ms),
      over300 = countif(duration > 300ms), over1s = countif(duration > 1s),
      firstOver1s = countif(toreal(['attributes.custom']['db.wire.first_message_ms']) > 1000),
      authP95 = percentile(toreal(['attributes.custom']['db.query.duration_ms']), 95),
      traces = dcount(trace_id)`;
    // Axiom limits the query body; chunk the foreground trace set.
    const chunks: string[][] = [];
    for (let index = 0; index < traces.length; index += 400)
      chunks.push(traces.slice(index, index + 400));
    const foreground: Record<string, Record<string, number>> = {};
    const sums = (
      target: Record<string, Record<string, number>>,
      rows: readonly Record<string, unknown>[],
    ) => {
      for (const row of rows) {
        const name = String(row.name);
        const existing = target[name];
        const n = number(row.n);
        if (existing === undefined) {
          target[name] = Object.fromEntries(
            Object.entries(row)
              .filter(([key]) => key !== "name")
              .map(([key, value]) => [key, number(value)]),
          );
          continue;
        }
        // Percentiles across chunks are weighted approximations; counts are exact.
        const total = existing.n! + n;
        for (const key of ["p50", "p95", "p99", "authP95"])
          existing[key] =
            Math.round(((existing[key]! * existing.n! + number(row[key]) * n) / total) * 10) / 10;
        existing.max = Math.max(existing.max!, number(row.max));
        for (const key of ["n", "over300", "over1s", "firstOver1s", "traces"])
          existing[key] = existing[key]! + number(row[key]);
      }
    };
    for (const chunk of chunks)
      sums(
        foreground,
        yield* apl(
          `['${dataset}'] | where ${environment} and ${names} and trace_id in (${chunk.map((id) => `'${id}'`).join(",")}) | summarize ${metrics} by name`,
          input.from,
          input.to,
        ),
      );
    const all: Record<string, Record<string, number>> = {};
    sums(
      all,
      yield* apl(
        `['${dataset}'] | where ${environment} and ${names} | summarize ${metrics} by name`,
        input.from,
        input.to,
      ),
    );
    const background = Object.fromEntries(
      Object.entries(all).map(([name, row]) => [
        name,
        {
          n: row.n! - (foreground[name]?.n ?? 0),
          over300: row.over300! - (foreground[name]?.over300 ?? 0),
          over1s: row.over1s! - (foreground[name]?.over1s ?? 0),
        },
      ]),
    );
    const execute = foreground["sql.execute"];
    return {
      slug: input.slug,
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      foregroundTraces: traces.length,
      foreground,
      background,
      all,
      foregroundExecuteOver1sRate:
        execute === undefined || execute.n === 0 ? null : execute.over1s! / execute.n!,
      connectsPerForegroundTrace:
        traces.length === 0 ? null : (foreground["sql.connect"]?.n ?? 0) / traces.length,
    };
  });
