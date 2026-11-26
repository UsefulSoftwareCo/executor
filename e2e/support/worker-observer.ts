import { expect } from "@effect/vitest";
import { Schema } from "effect";

export const Observation = Schema.Struct({
  isolate: Schema.String,
  calls: Schema.Number,
  previous: Schema.NullOr(Schema.String),
  token: Schema.String,
  fetched: Schema.NullOr(Schema.String),
});
export const RunObservation = Schema.Struct({ ...Observation.fields, run: Schema.String });

export const observer = (resource: string | null) => `let isolate;
let calls = 0;
let seen = null;
const resource = ${JSON.stringify(resource)};
const observe = async (token) => {
  isolate ??= crypto.randomUUID();
  const previous = seen;
  seen = token;
  const observation = { isolate, calls: ++calls, previous, token };
  if (resource === null) return { ...observation, fetched: null };
  const response = await fetch(resource, { headers: { authorization: "Bearer " + token } });
  return { ...observation, fetched: (await response.json()).authorization };
};`;

export const observerApp = (options: {
  readonly name: string;
  readonly database: boolean;
  readonly resource: string | null;
}) => `import { defineApp, defineProvider, secrets, object, string, query, workflow, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(options.name)}, auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) })
} });
${observer(options.resource)}
export default defineApp({ user: { accounts: { service } } }, {
  tools: router({ probe: query({ input: object({}) }, async (ctx) => observe(ctx.user.accounts.service.fields.token)) }),
  workflows: { probe: workflow({ input: object({}) }, async (ctx) => ({
    ...(await ctx.step.do("probe", async (step) => observe(step.user.accounts.service.fields.token))),
    run: ctx.runId,
  })) },
});`;

export const loadRounds = 20;

export const expectOneLoadPerColdStart = (
  calls: ReadonlyArray<{ readonly observation: typeof Observation.Type; readonly loads: number }>,
) => {
  expect(new Set(calls.map((call) => call.observation.isolate)).size).toBe(1);
  expect(calls.slice(1).every((call) => call.observation.calls > 1)).toBe(true);
  expect(
    calls.map((call) => call.loads),
    "only a cold start loads the build",
  ).toEqual(calls.map((call) => (call.observation.calls === 1 ? call.loads : 0)));
  expect(calls[0]!.loads).toBeLessThanOrEqual(1);
};

export const expectIsolatedAccounts = (
  first: { readonly observed: ReadonlyArray<typeof Observation.Type>; readonly token: string },
  second: { readonly observed: ReadonlyArray<typeof Observation.Type>; readonly token: string },
  firstIsolate: string,
) => {
  for (const entry of first.observed)
    expect(entry).toMatchObject({
      isolate: firstIsolate,
      previous: first.token,
      token: first.token,
    });
  const [initial, ...rest] = second.observed;
  expect(initial).toMatchObject({ previous: null, token: second.token });
  expect(initial!.isolate).not.toBe(firstIsolate);
  for (const entry of rest)
    expect(entry).toMatchObject({
      isolate: initial!.isolate,
      previous: second.token,
      token: second.token,
    });
};

export const expectIsolatedAccountsAcrossReplacedFacets = (
  first: { readonly observed: ReadonlyArray<typeof Observation.Type>; readonly token: string },
  second: { readonly observed: ReadonlyArray<typeof Observation.Type>; readonly token: string },
) => {
  for (const { observed, token } of [first, second])
    for (const entry of observed)
      expect(entry).toMatchObject({ token, previous: entry.calls === 1 ? null : token });
  const firstIsolates = new Set(first.observed.map((entry) => entry.isolate));
  expect(
    second.observed.filter((entry) => firstIsolates.has(entry.isolate)),
    "no Worker served both accounts",
  ).toEqual([]);
};

export const expectFacetLoadsOnlyAtColdStarts = (
  loads: Readonly<Record<string, number>>,
  observed: ReadonlyArray<typeof Observation.Type>,
) => {
  const facets = Object.entries(loads).filter(([runtime]) => runtime.startsWith("facet "));
  const workers = Object.entries(loads).filter(([runtime]) => !runtime.startsWith("facet "));
  expect(Object.fromEntries(workers), "one build load per app Worker").toEqual(
    Object.fromEntries(workers.map(([runtime]) => [runtime, 1])),
  );
  const fresh = observed.filter((entry) => entry.calls === 1).length;
  const facetLoads = facets.reduce((sum, [, count]) => sum + count, 0);
  expect(facetLoads, "every observed cold start loaded the build").toBeGreaterThanOrEqual(fresh);
  expect(facetLoads, "only cold starts load the build").toBeLessThanOrEqual(fresh + facets.length);
};
