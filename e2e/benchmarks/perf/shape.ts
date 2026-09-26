/**
 * Production shape: aggregate quantiles only, never identifiers or customer content.
 *
 * `productionShape` was derived on 2026-09-25 from the Axiom dataset executor-next-v2-traces over
 * the preceding 36 hours (Cloud stage `v2`). `pullShape` repeats those queries so the file can be
 * refreshed; it returns quantiles over organizations or requests and nothing else.
 * Members per organization are not observable in traces; the fixture's three roles are used.
 */
import { Config, Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

/** Quantile table: probabilities in ascending order with their observed values. */
export const Quantiles = Schema.Array(Schema.Tuple([Schema.Number, Schema.Number]));
export type Quantiles = typeof Quantiles.Type;

export const Shape = Schema.Struct({
  source: Schema.String,
  /** Distinct apps touched per organization through dashboard routes (orgs with activity). */
  appsPerOrg: Quantiles,
  /** Distinct accounts touched per organization. */
  accountsPerOrg: Quantiles,
  /** Distinct profiles touched per organization. */
  profilesPerOrg: Quantiles,
  /** Apps and tools in one MCP catalog (per mcp.catalog span). */
  catalogApps: Quantiles,
  catalogTools: Quantiles,
  /** Tool calls per MCP execute. */
  callsPerExecute: Quantiles,
  /** Upstream latency: provider HTTP requests and MCP discovery (ms). */
  upstreamCallMs: Quantiles,
  upstreamListMs: Quantiles,
});
export type Shape = typeof Shape.Type;

export const productionShape: Shape = {
  source: "executor-next-v2-traces, stage v2, 36 h ending 2026-09-25T09:00Z; aggregate quantiles",
  appsPerOrg: [
    [0.1, 1],
    [0.25, 1],
    [0.5, 3],
    [0.75, 5],
    [0.9, 14],
    [0.95, 16],
    [0.99, 24],
  ],
  accountsPerOrg: [
    [0.1, 1],
    [0.25, 1],
    [0.5, 1],
    [0.75, 3],
    [0.9, 8],
    [0.95, 10],
    [0.99, 10],
  ],
  profilesPerOrg: [
    [0.1, 1],
    [0.25, 1],
    [0.5, 2],
    [0.75, 4],
    [0.9, 7],
    [0.99, 7],
  ],
  catalogApps: [
    [0.1, 6],
    [0.25, 8],
    [0.5, 9],
    [0.75, 25],
    [0.9, 25],
    [0.99, 25],
  ],
  catalogTools: [
    [0.1, 122],
    [0.25, 167],
    [0.5, 167],
    [0.75, 1536],
    [0.9, 2029],
    [0.95, 3073],
    [0.99, 3073],
  ],
  callsPerExecute: [
    [0.1, 1],
    [0.25, 1],
    [0.5, 1],
    [0.75, 2],
    [0.9, 4],
    [0.95, 6],
    [0.99, 14],
  ],
  upstreamCallMs: [
    [0.1, 26],
    [0.25, 36],
    [0.5, 65],
    [0.75, 445],
    [0.9, 1854],
    [0.95, 2646],
    [0.99, 4176],
  ],
  upstreamListMs: [
    [0.1, 88],
    [0.25, 182],
    [0.5, 512],
    [0.75, 1222],
    [0.9, 2752],
    [0.95, 3491],
    [0.99, 4341],
  ],
};

const percentiles = [10, 25, 50, 75, 90, 95, 99];
const toQuantiles = (values: readonly number[], scale = 1): Quantiles =>
  values.map((value, index) => [percentiles[index]! / 100, Math.round(value * scale)] as const);

/**
 * Refresh the shape from Axiom. Needs AXIOM_TOKEN with query access to the dataset (and AXIOM_ORG_ID
 * for personal tokens). Only percentile arrays leave Axiom.
 */
export const pullShape = (dataset: string, hours: number) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("AXIOM_TOKEN");
    const organization = yield* Config.String("AXIOM_ORG_ID").pipe(Config.withDefault(""));
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600_000);
    const p = percentiles.join(",");
    const base = `['${dataset}'] | where ['resource.deployment.environment.name'] == "v2"`;
    const org = `${base} and isnotempty(['attributes.url.path']) and ['attributes.url.path'] startswith "/api/organizations/" | extend org = extract("^/api/organizations/([^/]+)", 1, ['attributes.url.path'])`;
    const perOrg = (pattern: string) =>
      `${org} | extend item = extract("${pattern}", 1, ['attributes.url.path']) | where isnotempty(item) | summarize n=dcount(item) by org | summarize p=percentiles_array(n, ${p})`;
    const queries = {
      appsPerOrg: perOrg("/apps/(app_[^/]+)"),
      accountsPerOrg: perOrg("/accounts/([^/]+)"),
      profilesPerOrg: perOrg("/profiles/([^/]+)"),
      catalogApps: `${base} and name == "mcp.catalog" | summarize p=percentiles_array(toint(['attributes.custom']['executor.discovery.apps']), ${p})`,
      catalogTools: `${base} and name == "mcp.catalog" | summarize p=percentiles_array(toint(['attributes.custom']['executor.discovery.tools']), ${p})`,
      callsPerExecute: `${base} and name == "mcp.execute" | summarize p=percentiles_array(toint(['attributes.custom']['executor.tool_call.count']), ${p})`,
      upstreamCallMs: `${base} and name == "provider.http.request" | summarize p=percentiles_array(duration, ${p})`,
      upstreamListMs: `${base} and name == "provider.mcp.discover" | summarize p=percentiles_array(duration, ${p})`,
    };
    const Tabular = Schema.Struct({
      tables: Schema.Array(Schema.Struct({ columns: Schema.Array(Schema.Array(Schema.Unknown)) })),
    });
    const run = (apl: string) =>
      Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(
          "https://api.axiom.co/v1/datasets/_apl?format=tabular",
        ).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.setHeaders(organization ? { "x-axiom-org-id": organization } : {}),
          HttpClientRequest.bodyJson({
            apl,
            startTime: start.toISOString(),
            endTime: end.toISOString(),
          }),
        );
        const response = yield* http.execute(request);
        const table = yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Tabular)),
        );
        const first = table.tables[0]?.columns[0]?.[0];
        return yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Number))(first);
      });
    const result: Record<string, Quantiles> = {};
    for (const [key, apl] of Object.entries(queries)) {
      const values = yield* run(apl);
      // Span durations are nanoseconds.
      result[key] = toQuantiles(values, key.endsWith("Ms") ? 1 / 1_000_000 : 1);
    }
    return yield* Schema.decodeUnknownEffect(Shape)({
      source: `${dataset}, stage v2, ${hours} h ending ${end.toISOString()}; aggregate quantiles`,
      ...result,
    });
  });

/** Seeded PRNG (mulberry32) so a seed reproduces the same synthetic population. */
export const random = (seed: number) => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Inverse-CDF sample with log-linear interpolation between observed quantiles. */
  const quantile = (table: Quantiles) => {
    const u = next();
    const first = table[0]!,
      last = table[table.length - 1]!;
    if (u <= first[0]) return first[1];
    if (u >= last[0]) return last[1];
    for (let index = 1; index < table.length; index++) {
      const [p1, v1] = table[index]!;
      const [p0, v0] = table[index - 1]!;
      if (u <= p1) {
        const f = (u - p0) / (p1 - p0);
        if (v0 <= 0 || v1 <= 0) return v0 + (v1 - v0) * f;
        return Math.exp(Math.log(v0) + (Math.log(v1) - Math.log(v0)) * f);
      }
    }
    return last[1];
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <A>(values: readonly A[]): A => values[Math.floor(next() * values.length)]!,
    quantile,
  };
};
export type Random = ReturnType<typeof random>;

/**
 * Tools per app. The catalog quantiles imply mostly small apps with a few very large ones:
 * a median 9-app catalog holds ~167 tools, while 25-app catalogs reach 1.5k-3k tools.
 * 75% small (3-30), 20% medium (30-150), 5% large (400-2500) reproduces those totals.
 */
export const toolsPerApp = (rng: Random) => {
  const u = rng.next();
  if (u < 0.75) return rng.int(3, 30);
  if (u < 0.95) return rng.int(30, 150);
  return rng.int(400, 2500);
};
