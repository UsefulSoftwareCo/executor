/**
 * Waterfall flamecharts from delivered test-stage traces.
 *
 * Spans come from the Axiom dataset executor-next-test-traces, filtered to one `test-*` stage and one
 * trace ID. Only span names, services, timings and status are rendered; attributes are not.
 * Output is an SVG plus a PNG rendered by Playwright's Chromium.
 */
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Option,
  Path,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { chromium } from "playwright";

export class FlamechartFailed extends Schema.TaggedError<FlamechartFailed>()("FlamechartFailed", {
  message: Schema.String,
}) {}

export interface Span {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly service: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly error: boolean;
}

const Tabular = Schema.Struct({
  status: Schema.Struct({ isPartial: Schema.Boolean }),
  tables: Schema.Array(
    Schema.Struct({
      fields: Schema.Array(Schema.Struct({ name: Schema.String })),
      columns: Schema.Array(Schema.Array(Schema.Unknown)),
    }),
  ),
});
const Row = Schema.Struct({
  spanId: Schema.String,
  parentSpanId: Schema.NullOr(Schema.String),
  name: Schema.String,
  service: Schema.NullOr(Schema.String),
  start: Schema.String,
  durationMs: Schema.Number,
  status: Schema.NullOr(Schema.String),
});

export const dataset = "executor-next-test-traces";

/** Read one trace from a test stage. The window should bracket the request (minutes, not days). */
export const fetchTrace = (input: {
  readonly slug: string;
  readonly traceId: string;
  readonly from: Date;
  readonly to: Date;
}) =>
  Effect.gen(function* () {
    if (!/^[a-z0-9-]+$/.test(input.slug))
      return yield* new FlamechartFailed({ message: "Invalid stage slug" });
    if (!/^[a-f0-9]{32}$/.test(input.traceId))
      return yield* new FlamechartFailed({ message: "Invalid trace ID" });
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
        apl: `['${dataset}'] | where ['resource.deployment.environment.name'] == 'test-${input.slug}' and trace_id == '${input.traceId}' | project spanId=span_id, parentSpanId=parent_span_id, name, service=['service.name'], start=_time, durationMs=duration/1ms, status=['status.code'] | take 20000`,
        startTime: input.from.toISOString(),
        endTime: input.to.toISOString(),
      }),
    );
    const response = yield* (yield* HttpClient.HttpClient)
      .pipe(HttpClient.filterStatusOk)
      .execute(request);
    const payload = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Tabular)));
    const spans: Span[] = [];
    for (const table of payload.tables) {
      const count = table.columns[0]?.length ?? 0;
      for (let row = 0; row < count; row++) {
        const value = yield* Schema.decodeUnknownEffect(Row)(
          Object.fromEntries(
            table.fields.map((field, index) => [field.name, table.columns[index]?.[row] ?? null]),
          ),
        );
        spans.push({
          spanId: value.spanId,
          parentSpanId: value.parentSpanId === "" ? null : value.parentSpanId,
          name: value.name,
          service: value.service ?? "unknown",
          startMs: Date.parse(value.start),
          durationMs: value.durationMs,
          error: value.status === "ERROR" || value.status === "Error",
        });
      }
    }
    return { spans, partial: payload.status.isPartial };
  });

const palette = [
  "#4e79a7",
  "#f28e2b",
  "#59a14f",
  "#b07aa1",
  "#76b7b2",
  "#edc948",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
  "#e15759",
];
const colour = (service: string) => {
  let hash = 0;
  for (const char of service) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
};
const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Row {
  readonly span: Span;
  readonly depth: number;
}

/** Depth-first order with children by start time; spans below `minMs` beyond `maxRows` are folded. */
const order = (spans: readonly Span[], maxRows: number) => {
  const ids = new Set(spans.map((span) => span.spanId));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const span of spans) {
    if (span.parentSpanId === null || !ids.has(span.parentSpanId)) roots.push(span);
    else children.set(span.parentSpanId, [...(children.get(span.parentSpanId) ?? []), span]);
  }
  const rows: Row[] = [];
  const visit = (span: Span, depth: number) => {
    rows.push({ span, depth });
    for (const child of (children.get(span.spanId) ?? []).sort((a, b) => a.startMs - b.startMs))
      visit(child, depth + 1);
  };
  for (const root of roots.sort((a, b) => a.startMs - b.startMs)) visit(root, 0);
  if (rows.length <= maxRows) return { rows, folded: 0, threshold: 0 };
  const threshold = [...rows].map((row) => row.span.durationMs).sort((a, b) => b - a)[maxRows - 1]!;
  const kept = rows.filter((row) => row.span.durationMs >= threshold).slice(0, maxRows);
  return { rows: kept, folded: rows.length - kept.length, threshold };
};

const rowHeight = 18;

/** Render one waterfall. `scaleMs` lets side-by-side charts share the same time axis. */
export const waterfall = (input: {
  readonly title: string;
  readonly spans: readonly Span[];
  readonly width: number;
  readonly scaleMs?: number;
  readonly maxRows?: number;
}) => {
  const { rows, folded, threshold } = order(input.spans, input.maxRows ?? 250);
  const start = Math.min(...input.spans.map((span) => span.startMs));
  const end = Math.max(...input.spans.map((span) => span.startMs + span.durationMs));
  const total = end - start;
  const scale = input.scaleMs ?? total;
  const label = 360,
    chart = input.width - label - 20,
    top = 56;
  const x = (ms: number) => label + (ms / Math.max(1, scale)) * chart;
  const services = [...new Set(input.spans.map((span) => span.service))].sort();
  const lines: string[] = [];
  lines.push(
    `<text x="10" y="20" font-size="14" font-weight="600">${escape(input.title)}</text>`,
    `<text x="10" y="38" font-size="11" fill="#555">${input.spans.length} spans, ${Math.round(total)} ms wall${folded ? `; ${folded} spans under ${threshold.toFixed(1)} ms folded` : ""}</text>`,
  );
  services.forEach((service, index) => {
    const lx = label + index * 150;
    lines.push(
      `<rect x="${lx}" y="28" width="10" height="10" fill="${colour(service)}"/>`,
      `<text x="${lx + 14}" y="37" font-size="10">${escape(service)}</text>`,
    );
  });
  for (let tick = 0; tick <= 10; tick++) {
    const ms = (scale / 10) * tick;
    const tx = x(ms);
    lines.push(
      `<line x1="${tx}" y1="${top - 6}" x2="${tx}" y2="${top + rows.length * rowHeight}" stroke="#eee"/>`,
      `<text x="${tx}" y="${top - 8}" font-size="9" fill="#777" text-anchor="middle">${Math.round(ms)}</text>`,
    );
  }
  rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    const bx = x(row.span.startMs - start);
    const bw = Math.max(1, x(row.span.startMs - start + row.span.durationMs) - bx);
    const ms =
      row.span.durationMs >= 10
        ? Math.round(row.span.durationMs)
        : Math.round(row.span.durationMs * 10) / 10;
    const text = `${"  ".repeat(Math.min(row.depth, 12))}${row.span.name}`;
    lines.push(
      `<text x="10" y="${y + 13}" font-size="10" xml:space="preserve">${escape(text.length > 58 ? `${text.slice(0, 57)}…` : text)}</text>`,
      `<rect x="${bx}" y="${y + 3}" width="${bw}" height="${rowHeight - 5}" fill="${colour(row.span.service)}"${row.span.error ? ' stroke="#d00" stroke-width="1.5"' : ""}><title>${escape(`${row.span.name} (${row.span.service}) ${ms} ms`)}</title></rect>`,
      `<text x="${Math.min(bx + bw + 3, input.width - 60)}" y="${y + 13}" font-size="9" fill="#333">${ms} ms</text>`,
    );
  });
  const height = top + rows.length * rowHeight + 16;
  return {
    height,
    body: lines.join("\n"),
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${height}" font-family="Helvetica, Arial, sans-serif"><rect width="100%" height="100%" fill="white"/>\n${lines.join("\n")}\n</svg>`,
    totalMs: total,
  };
};

/** Two waterfalls side by side on a shared time scale. */
export const sideBySide = (
  left: { readonly title: string; readonly spans: readonly Span[] },
  right: { readonly title: string; readonly spans: readonly Span[] },
) => {
  const extent = (spans: readonly Span[]) =>
    Math.max(...spans.map((span) => span.startMs + span.durationMs)) -
    Math.min(...spans.map((span) => span.startMs));
  const scaleMs = Math.max(extent(left.spans), extent(right.spans));
  const width = 1100;
  const a = waterfall({ ...left, width, scaleMs });
  const b = waterfall({ ...right, width, scaleMs });
  const height = Math.max(a.height, b.height);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 2 + 20}" height="${height}" font-family="Helvetica, Arial, sans-serif"><rect width="100%" height="100%" fill="white"/>\n<g>${a.body}</g>\n<line x1="${width + 10}" y1="0" x2="${width + 10}" y2="${height}" stroke="#ccc"/>\n<g transform="translate(${width + 20},0)">${b.body}</g>\n</svg>`;
};

/** Write `<base>.svg` and `<base>.png` (Chromium screenshot of the SVG). */
export const writeChart = (base: string, svg: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(base), { recursive: true });
    yield* fs.writeFileString(`${base}.svg`, svg);
    const width = Number(/width="(\d+)"/.exec(svg)?.[1] ?? 1200);
    const height = Number(/height="(\d+)"/.exec(svg)?.[1] ?? 800);
    const png = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => chromium.launch(),
        catch: () => new FlamechartFailed({ message: "Chromium did not start" }),
      }),
      (browser) =>
        Effect.tryPromise({
          try: () =>
            browser
              .newPage({ viewport: { width, height: Math.min(height, 16000) } })
              .then((page) =>
                page
                  .setContent(`<html><body style="margin:0">${svg}</body></html>`)
                  .then(() => page.screenshot({ fullPage: true, type: "png" })),
              ),
          catch: () => new FlamechartFailed({ message: "PNG rendering failed" }),
        }),
      (browser) => Effect.promise(() => browser.close()),
    );
    yield* fs.writeFile(`${base}.png`, png);
    yield* Console.log(`Wrote ${base}.svg and ${base}.png`);
  });

const ResultFile = Schema.Struct({
  kind: Schema.Literals(["perf-run", "perf-compare"]),
  slug: Schema.optional(Schema.String),
  a: Schema.optional(Schema.Struct({ slug: Schema.String })),
  b: Schema.optional(Schema.Struct({ slug: Schema.String })),
  results: Schema.Array(Schema.Unknown),
});
const Measured = Schema.Struct({
  id: Schema.String,
  samples: Schema.Array(
    Schema.Struct({
      ok: Schema.Boolean,
      at: Schema.String,
      clientMs: Schema.Number,
      traceId: Schema.optional(Schema.String),
    }),
  ),
});
const CompareEntry = Schema.Struct({ id: Schema.String, a: Measured, b: Measured });

type Pick = { readonly traceId: string; readonly at: string; readonly clientMs: number };
const pick = (
  samples: typeof Measured.Type.samples,
  which: "median" | "slowest",
): Pick | undefined => {
  const ok = samples
    .filter((sample) => sample.ok && sample.traceId !== undefined)
    .sort((a, b) => a.clientMs - b.clientMs);
  const chosen = which === "slowest" ? ok[ok.length - 1] : ok[Math.floor((ok.length - 1) / 2)];
  return chosen === undefined
    ? undefined
    : { traceId: chosen.traceId!, at: chosen.at, clientMs: chosen.clientMs };
};

/** Fetch with a bounded wait for ingestion; the window brackets the sample time. */
export const spansFor = (slug: string, traceId: string, at: Date, minutes = 15) =>
  fetchTrace({
    slug,
    traceId,
    from: new Date(at.getTime() - minutes * 60_000),
    to: new Date(at.getTime() + minutes * 60_000),
  }).pipe(
    Effect.flatMap((trace) =>
      trace.spans.length === 0
        ? Effect.fail(new FlamechartFailed({ message: `No spans yet for ${traceId}` }))
        : Effect.succeed(trace.spans),
    ),
    Effect.retry({ times: 3, schedule: Schedule.spaced("20 seconds") }),
  );

const fileSafe = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, "_");

/** Render median and slowest samples of every scenario in a run or comparison file. */
export const renderResults = (input: {
  readonly file: string;
  readonly output: string;
  readonly scenarios: string;
  readonly which: readonly ("median" | "slowest")[];
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const file = yield* fs
      .readFileString(input.file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ResultFile))));
    const patterns = input.scenarios
      .split(",")
      .filter((part) => part.trim() !== "")
      .map((part) => new RegExp(part.trim()));
    const wanted = (id: string) => patterns.length === 0 || patterns.some((p) => p.test(id));
    const rendered: { scenario: string; which: string; traceId: string; file: string }[] = [];
    const attempt = <A, R>(effect: Effect.Effect<A, unknown, R>, what: string) =>
      effect.pipe(
        Effect.map(Option.some),
        Effect.catchCause(() => Console.error(`Skipped ${what}`).pipe(Effect.as(Option.none<A>()))),
      );
    if (file.kind === "perf-run") {
      const slug = file.slug!;
      for (const raw of file.results) {
        const entry = yield* Schema.decodeUnknownEffect(Measured)(raw);
        if (!wanted(entry.id)) continue;
        for (const which of input.which) {
          const chosen = pick(entry.samples, which);
          if (chosen === undefined) continue;
          const base = path.join(input.output, fileSafe(`${entry.id}.${which}`));
          const done = yield* attempt(
            spansFor(slug, chosen.traceId, new Date(chosen.at)).pipe(
              Effect.flatMap((spans) =>
                writeChart(
                  base,
                  waterfall({
                    title: `${entry.id} — ${which} sample, client ${Math.round(chosen.clientMs)} ms — test-${slug} trace ${chosen.traceId}`,
                    spans,
                    width: 1400,
                  }).svg,
                ),
              ),
            ),
            `${entry.id} ${which}`,
          );
          if (Option.isSome(done))
            rendered.push({
              scenario: entry.id,
              which,
              traceId: chosen.traceId,
              file: `${base}.png`,
            });
        }
      }
    } else {
      const slugA = file.a!.slug,
        slugB = file.b!.slug;
      for (const raw of file.results) {
        const entry = yield* Schema.decodeUnknownEffect(CompareEntry)(raw);
        if (!wanted(entry.id)) continue;
        for (const which of input.which) {
          const left = pick(entry.a.samples, which),
            right = pick(entry.b.samples, which);
          if (left === undefined || right === undefined) continue;
          const base = path.join(input.output, fileSafe(`${entry.id}.${which}.compare`));
          const done = yield* attempt(
            Effect.all([
              spansFor(slugA, left.traceId, new Date(left.at)),
              spansFor(slugB, right.traceId, new Date(right.at)),
            ]).pipe(
              Effect.flatMap(([a, b]) =>
                writeChart(
                  base,
                  sideBySide(
                    {
                      title: `${slugA} — ${entry.id} ${which}, client ${Math.round(left.clientMs)} ms — ${left.traceId}`,
                      spans: a,
                    },
                    {
                      title: `${slugB} — ${entry.id} ${which}, client ${Math.round(right.clientMs)} ms — ${right.traceId}`,
                      spans: b,
                    },
                  ),
                ),
              ),
            ),
            `${entry.id} ${which}`,
          );
          if (Option.isSome(done))
            rendered.push({
              scenario: entry.id,
              which,
              traceId: `${left.traceId} vs ${right.traceId}`,
              file: `${base}.png`,
            });
        }
      }
    }
    yield* fs.writeFileString(
      path.join(input.output, "flamecharts.json"),
      JSON.stringify(rendered, null, 2),
    );
    return rendered;
  });
