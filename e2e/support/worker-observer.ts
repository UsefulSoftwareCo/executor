/** An authored module that reports which loaded Worker served it and what credentials it saw. */
import { expect } from "@effect/vitest";
import { Schema } from "effect";

/**
 * One authored observation: the isolate, its call count, the credential seen before this one and,
 * when the app fetches a resource, the authorization that resource received.
 */
export const Observation = Schema.Struct({
  isolate: Schema.String,
  calls: Schema.Number,
  previous: Schema.NullOr(Schema.String),
  token: Schema.String,
  fetched: Schema.NullOr(Schema.String),
});
/** A workflow run's observation, with the run identifier its body received. */
export const RunObservation = Schema.Struct({ ...Observation.fields, run: Schema.String });

/**
 * Module state survives only while the runtime keeps the same loaded Worker. With a resource URL,
 * each observation also fetches it through the Worker's outbound network with the current token.
 */
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

/**
 * A key-account app whose query and workflow both observe the Worker. Queries of an app with a
 * database (deployed with `databaseFiles`) run in its data facet; without one, queries and workflows share one Worker.
 */
export const observerApp = (options: {
  readonly name: string;
  readonly database: boolean;
  readonly resource: string | null;
}) => `import { defineApp, defineProvider, secrets, object, string, query, workflow, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(options.name)}, auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) })
} });
${observer(options.resource)}
export default defineApp({ accounts: { service } }, {
  tools: router({ probe: query({ input: object({}) }, async (ctx) => observe(ctx.accounts.service.fields.token)) }),
  workflows: { probe: workflow({ input: object({}) }, async (ctx) => ({
    ...(await ctx.step.do("probe", async (step) => observe(step.accounts.service.fields.token))),
    run: ctx.runId,
  })) },
});`;

/** Serial calls of one account whose build loads are counted from their traces. */
export const loadRounds = 20;

/**
 * Every call of one account runs in the same loaded Worker, and only a cold start loads the build.
 * A call is cold exactly when the module has observed no earlier call. Background discovery can
 * start the Worker first, so the first call loads at most once; later calls never load.
 */
export const expectOneLoadPerColdStart = (
  calls: ReadonlyArray<{ readonly observation: typeof Observation.Type; readonly loads: number }>,
) => {
  expect(new Set(calls.map((call) => call.observation.isolate)).size).toBe(1);
  expect(calls.slice(1).every((call) => call.observation.calls > 1)).toBe(true);
  // A warm call reads, decodes and transfers no app code.
  expect(
    calls.map((call) => call.loads),
    "only a cold start loads the build",
  ).toEqual(calls.map((call) => (call.observation.calls === 1 ? call.loads : 0)));
  expect(calls[0]!.loads).toBeLessThanOrEqual(1);
};

/**
 * Concurrent calls of two accounts of one app: each account keeps its own Worker, every call
 * receives its own credential, and neither Worker ever holds the other account's credential.
 */
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

/**
 * Concurrent calls of two accounts of an app with a database, on a host that unloads the data
 * facet a call of other accounts replaced. The app runs one facet at a time, so alternating calls
 * start fresh facet Workers. Every call still receives its own credential, module state lives only
 * within one Worker, and no Worker ever serves both accounts.
 */
export const expectIsolatedAccountsAcrossReplacedFacets = (
  first: { readonly observed: ReadonlyArray<typeof Observation.Type>; readonly token: string },
  second: { readonly observed: ReadonlyArray<typeof Observation.Type>; readonly token: string },
) => {
  for (const { observed, token } of [first, second])
    for (const entry of observed)
      // A fresh Worker has seen no credential; a loaded one has seen only this account's.
      expect(entry).toMatchObject({ token, previous: entry.calls === 1 ? null : token });
  const firstIsolates = new Set(first.observed.map((entry) => entry.isolate));
  expect(
    second.observed.filter((entry) => firstIsolates.has(entry.isolate)),
    "no Worker served both accounts",
  ).toEqual([]);
};

/**
 * Build loads of an app whose data facets were replaced and unloaded. The app Worker loads once.
 * A facet loads only at a cold start: once for every fresh facet a call observed, plus at most one
 * facet per runtime that background discovery started and another account's call replaced before
 * any call observed it.
 */
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
