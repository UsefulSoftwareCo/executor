/**
 * First app-supervisor call after an idle gap. Cloudflare evicts an idle supervisor after about
 * ten seconds, and its next call often starts a fresh isolate. Each gap gets its own app, so its
 * supervisor always sees exactly that idle time before the measured read.
 */
import { Clock, Console, Effect } from "effect";
import type { PerfTarget } from "./scenarios.ts";
import { spansFor } from "./flamechart.ts";

/** App tab whose read first asks the supervisor for a kept evaluated result. */
const tab = "skills";
/** The supervisor calls a read makes; the earliest one is the call that waits for a wake. */
const supervisorCalls = new Set(["storage.evaluated.read", "runtime.cloud.cache"]);

export interface IdleSample {
  readonly gapSeconds: number;
  readonly round: number;
  /** `first` follows the idle gap; `second` follows it at once, against a warm supervisor. */
  readonly kind: "first" | "second";
  readonly at: string;
  readonly status: number;
  readonly clientMs: number;
  readonly serverMs: number | undefined;
  readonly traceId: string;
  /** Duration of the request's first supervisor call, from the stage trace. */
  readonly supervisorMs: number | undefined;
}

const quantile = (values: readonly number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
};

export const runIdle = (input: {
  readonly target: PerfTarget;
  readonly org: string;
  readonly gaps: readonly number[];
  readonly rounds: number;
}) =>
  Effect.gen(function* () {
    const entry = input.target.org(input.org);
    const pairs = input.gaps.flatMap((gapSeconds, index) => {
      const app = entry.apps[index];
      return app === undefined ? [] : [{ gapSeconds, app }];
    });
    if (pairs.length < input.gaps.length)
      return yield* Effect.die(
        new Error(`${input.org} has ${entry.apps.length} apps for ${input.gaps.length} gaps`),
      );
    const client = yield* input.target.owner(input.org);
    const measured: Omit<IdleSample, "supervisorMs">[] = [];
    yield* Effect.forEach(
      pairs,
      ({ gapSeconds, app }) =>
        Effect.gen(function* () {
          const path = `/api/organizations/${entry.organization.id}/apps/${app.id}/${tab}`;
          // Start every supervisor from a known warm state.
          yield* client.request("GET", path);
          for (let round = 0; round < input.rounds; round++) {
            yield* Effect.sleep(`${gapSeconds} seconds`);
            for (const kind of ["first", "second"] as const) {
              const response = yield* client.request("GET", path);
              measured.push({
                gapSeconds,
                round,
                kind,
                at: new Date(yield* Clock.currentTimeMillis).toISOString(),
                status: response.status,
                clientMs: response.clientMs,
                serverMs: response.serverMs,
                traceId: response.traceId,
              });
            }
          }
        }),
      { concurrency: "unbounded", discard: true },
    );
    // Traces arrive after their requests; each lookup retries while its spans are missing.
    const samples: IdleSample[] = yield* Effect.forEach(
      measured,
      (sample) =>
        spansFor(input.target.control.slug, sample.traceId, new Date(sample.at)).pipe(
          Effect.map((spans) =>
            spans
              .filter((span) => supervisorCalls.has(span.name))
              .sort((a, b) => a.startMs - b.startMs)
              .at(0),
          ),
          Effect.map((span) => ({ ...sample, supervisorMs: span?.durationMs })),
          Effect.catch(() => Effect.succeed({ ...sample, supervisorMs: undefined })),
        ),
      { concurrency: 4 },
    );
    const groups = new Map<string, number[]>();
    for (const sample of samples)
      if (sample.supervisorMs !== undefined) {
        const key = `${sample.kind} ${sample.gapSeconds}s`;
        groups.set(key, [...(groups.get(key) ?? []), sample.supervisorMs]);
      }
    for (const [key, values] of groups)
      yield* Console.log(
        `${key.padEnd(12)} n=${values.length} supervisor p50=${Math.round(quantile(values, 0.5))} ms p90=${Math.round(quantile(values, 0.9))} ms max=${Math.round(Math.max(...values))} ms`,
      );
    return samples;
  });
