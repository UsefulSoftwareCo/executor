/**
 * Time between the API Worker forwarding an MCP request and its session object answering it.
 * Each organization's PAT addresses its own session object. A round waits out the idle gap, so
 * Cloudflare has usually evicted the object, then opens a session (`idle`), makes sequential
 * calls (`warm`) and parallel calls on the same session (`concurrent`). The hop is
 * `mcp.session.forward` minus the object's `http.server` span: both are measured on their own
 * isolate's clock, so the difference holds even when the two clocks disagree.
 */
import { Clock, Console, Effect } from "effect";
import type { PerfTarget } from "./scenarios.ts";
import { mcpSession, type McpExchange } from "./client.ts";
import { spansFor, type Span } from "./flamechart.ts";

type Kind = "idle" | "warm" | "concurrent";

export interface SessionHopSample {
  readonly org: string;
  readonly round: number;
  readonly kind: Kind;
  readonly method: string;
  readonly at: string;
  readonly status: number;
  readonly clientMs: number;
  readonly traceId: string;
  /** Forward duration minus the session object's request duration, from the stage trace. */
  readonly hopMs: number | undefined;
}

const quantile = (values: readonly number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))] ?? Number.NaN;
};

const hop = (spans: readonly Span[]) => {
  const forward = spans.find((span) => span.name === "mcp.session.forward");
  if (forward === undefined) return undefined;
  const session = spans.find(
    (span) => span.parentSpanId === forward.spanId && span.name.startsWith("http.server"),
  );
  return session === undefined ? undefined : forward.durationMs - session.durationMs;
};

export const runSessionHop = (input: {
  readonly target: PerfTarget;
  readonly orgs: readonly string[];
  readonly gapSeconds: number;
  readonly rounds: number;
  readonly warm: number;
  readonly concurrent: number;
}) =>
  Effect.gen(function* () {
    const measured: Omit<SessionHopSample, "hopMs">[] = [];
    const record = (org: string, round: number, kind: Kind, exchanges: readonly McpExchange[]) =>
      Effect.gen(function* () {
        const at = new Date(yield* Clock.currentTimeMillis).toISOString();
        for (const exchange of exchanges)
          if (exchange.httpMethod === "POST")
            measured.push({
              org,
              round,
              kind,
              method: exchange.method,
              at,
              status: exchange.status,
              clientMs: exchange.clientMs,
              traceId: exchange.traceId,
            });
      });
    yield* Effect.forEach(
      input.orgs,
      (org, index) =>
        Effect.gen(function* () {
          const entry = input.target.org(org);
          // Stagger organizations so their idle requests do not arrive together.
          yield* Effect.sleep(`${index * 20} seconds`);
          for (let round = 0; round < input.rounds; round++) {
            yield* Effect.sleep(`${input.gapSeconds} seconds`);
            const session = yield* mcpSession(
              input.target.control.origin,
              entry.pat,
              entry.organization.id,
            );
            yield* record(org, round, "idle", session.exchanges.slice(0, 1));
            for (let call = 0; call < input.warm; call++) {
              const { exchanges } = yield* session.callTool("execute", { code: "return 1" });
              yield* record(org, round, "warm", exchanges);
            }
            const parallel = yield* Effect.all(
              Array.from({ length: input.concurrent }, () =>
                session.callTool("execute", { code: "return 1" }),
              ),
              { concurrency: "unbounded" },
            );
            yield* record(
              org,
              round,
              "concurrent",
              parallel.flatMap(({ exchanges }) => exchanges),
            );
            yield* session.close.pipe(Effect.ignore);
          }
        }),
      { concurrency: "unbounded", discard: true },
    );
    // Traces arrive after their requests; each lookup retries while its spans are missing.
    const samples: SessionHopSample[] = yield* Effect.forEach(
      measured,
      (sample) =>
        spansFor(input.target.control.slug, sample.traceId, new Date(sample.at)).pipe(
          Effect.map((spans) => ({ ...sample, hopMs: hop(spans) })),
          Effect.catch(() => Effect.succeed({ ...sample, hopMs: undefined })),
        ),
      { concurrency: 4 },
    );
    for (const kind of ["idle", "warm", "concurrent"] as const) {
      const values = samples.flatMap((sample) =>
        sample.kind === kind && sample.hopMs !== undefined ? [sample.hopMs] : [],
      );
      if (values.length > 0)
        yield* Console.log(
          `${kind.padEnd(10)} n=${values.length} hop p50=${Math.round(quantile(values, 0.5))} ms p95=${Math.round(quantile(values, 0.95))} ms p99=${Math.round(quantile(values, 0.99))} ms`,
        );
    }
    return samples;
  });
