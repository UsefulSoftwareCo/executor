/**
 * A self-host or local process keeps at most its configured number of app Workers loaded, however
 * many apps and account selections are called. Each Worker is named by app, build and account
 * selection; an authored module reports a per-isolate identifier from module state, so a Worker
 * the runtime unloaded and loaded again reports a new identifier and no earlier calls.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { requestGate } from "../support/request-gate.ts";
import { appsManifest, databaseFiles } from "../support/apps-release.ts";
import { appWorkerBudgetLimit as limit, appWorkerIdleSeconds, scenarios } from "../test-plan.ts";

/** Apps and account selections beyond the limit: two apps with three accounts each. */
const beyondLimit = { apps: 2, accountsPerApp: 3, database: false };
/**
 * Apps with databases beyond the limit, each running its queries in its own data facet. A tool
 * call of such an app takes its kind from the kept tool listing, so it loads only its facet and
 * takes one of the limit's slots. The first call of each selection also evaluates that listing in
 * the app Worker; the sweeps after it would leave room for only half as many recent selections if
 * a call loaded the app Worker as well.
 */
const facetsBeyondLimit = { apps: limit + 2, accountsPerApp: 1, database: true };
const facetCallWorkers = 1;

const Observation = Schema.Struct({
  isolate: Schema.String,
  calls: Schema.Number,
  token: Schema.String,
});
type Observation = typeof Observation.Type;
const App = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({
        service: Schema.Struct({ provider: Schema.String }),
      }),
    }),
  }),
});
const HostedApp = Schema.Struct({ id: Schema.String });
const SetupStatus = Schema.Struct({ status: Schema.String });
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  value: Schema.Json,
});

interface Workload {
  readonly apps: number;
  readonly accountsPerApp: number;
  /** An app with a database runs its queries in a data facet. */
  readonly database: boolean;
}

/**
 * A key-account app whose probe reports its isolate, after an optional request it waits for. Its
 * other queries build a chain of cache refreshes that keeps a call's release running: `chain`
 * returns a stale value and refreshes it in the background once the `first` flag is set; that
 * refresh reads a second stale key, whose own refresh waits for the `second` flag and then
 * stores "refreshed".
 */
const budgetApp = (
  name: string,
) => `import { defineApp, defineProvider, secrets, object, string, boolean, query, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) })
} });
let isolate;
let calls = 0;
let held;
let dropped;
export default defineApp({ accounts: { service } }, {
  tools: router({
    probe: query({ input: object({ gate: string().optional() }) }, async (ctx, input) => {
      isolate ??= crypto.randomUUID();
      calls++;
      if (input.gate !== undefined) await (await fetch(input.gate)).text();
      return { isolate, calls, token: ctx.accounts.service.fields.token };
    }),
    seed: query({ input: object({}) }, async (ctx) => {
      for (const key of ["first", "second"])
        await ctx.cache.get({ key, schema: string(), freshFor: 0, staleFor: "10 minutes", load: async () => "seed" });
      return true;
    }),
    chain: query({ input: object({}) }, async (ctx) => {
      const flag = async (cache, name, signal) => {
        while (!(await cache.read(name, boolean()))) {
          if (signal.aborted) throw new Error("Refresh cancelled");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      return ctx.cache.get({ key: "first", schema: string(), freshFor: 0, staleFor: "10 minutes", load: async ({ cache, signal }) => {
        await flag(cache, "first-flag", signal);
        await cache.get({ key: "second", schema: string(), freshFor: 0, staleFor: "10 minutes", load: async ({ cache, signal }) => {
          await flag(cache, "second-flag", signal);
          return "refreshed";
        } });
        return "refreshed";
      } });
    }),
    flag: query({ input: object({ name: string() }) }, async (ctx, { name }) => {
      await ctx.cache.write([{ key: name, value: true }], "10 minutes");
      return true;
    }),
    chained: query({ input: object({}) }, async (ctx) => (await ctx.cache.read("second", string())) ?? null),
    hold: query({ input: object({}) }, async () => {
      held = { payload: "x".repeat(1024) };
      dropped = new WeakRef(held);
      // Short-lived allocations run minor collections, which move the held object to the old
      // generation; only a major collection frees it there.
      let churn = 0;
      for (let round = 0; round < 64; round++) churn += new Array(131072).fill(round).length;
      return churn > 0;
    }),
    drop: query({ input: object({}) }, async () => {
      held = undefined;
      return true;
    }),
    collected: query({ input: object({}) }, async () => dropped !== undefined && dropped.deref() === undefined),
  }),
});`;

interface Selection {
  readonly label: string;
  readonly token: string;
  readonly observe: (gate?: string) => Effect.Effect<Observation, unknown, never>;
  /** Call one of the app's queries and return its value. */
  readonly query: (name: string, input?: object) => Effect.Effect<unknown, unknown, never>;
}

/** Self-host: apps, accounts and profiles through one organization's routes. */
const hostedSelections = ({ apps, accountsPerApp, database }: Workload) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const selections: Selection[] = [];
    for (let index = 0; index < apps; index++) {
      const name = `Worker budget ${index} ${randomUUID().slice(0, 8)}`;
      const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name,
        files: [
          { path: "index.ts", content: budgetApp(name) },
          appsManifest,
          ...databaseFiles(database),
        ],
      });
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
      const app = yield* body(HostedApp, deployed);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      const path = `${prefix}/apps/${app.id}`;
      for (let account = 0; account < accountsPerApp; account++) {
        const token = `synthetic-budget-${index}-${account}`;
        const profile = yield* createProfile(actors.owner, path);
        const pending = yield* api.request(actors.owner, "POST", `${path}/connections`, {
          requirement: "service",
          profile: profile.id,
        });
        expect(pending.status, JSON.stringify(pending.body)).toBe(200);
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${(yield* body(Resource, pending)).id}/submit`,
          { method: "key", label: name, fields: { token } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const created = (yield* body(Resource, saved)).id;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/accounts/${created}`).pipe(Effect.orDie),
        );
        // Profile setup discovers the app in the background; wait so it is done before the calls.
        yield* api.request(actors.owner, "GET", `${path}/profiles/${profile.id}`).pipe(
          Effect.flatMap((response) => body(SetupStatus, response)),
          Effect.flatMap((current) =>
            current.status !== "pending"
              ? Effect.void
              : Effect.fail(new Error("Profile setup has not finished")),
          ),
          Effect.retry({
            schedule: Schedule.spaced("200 millis"),
            times: 100,
          }),
        );
        const query = (name: string, input: object = {}) =>
          api
            .request(actors.owner, "POST", `${path}/tools/call`, {
              profile: profile.id,
              tool: name,
              input,
            })
            .pipe(
              Effect.tap((response) =>
                Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
              ),
              Effect.flatMap((response) => body(Schema.Json, response)),
            );
        selections.push({
          label: `app ${index} account ${account}`,
          token,
          query,
          observe: (gate) =>
            query("probe", gate === undefined ? {} : { gate }).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Observation)),
            ),
        });
      }
    }
    return selections;
  });

/** Local: apps, accounts and profiles through the agent API. */
const localSelections = ({ apps, accountsPerApp, database }: Workload) =>
  Effect.gen(function* () {
    const api = yield* Api,
      target = yield* Target,
      session = yield* api.session();
    const agent: Session = {
      ...session,
      send: (method, path, data, headers = {}) => {
        const { origin: _origin, ...agentHeaders } = headers;
        return session.send(method, path, data, {
          ...agentHeaders,
          authorization: `Bearer ${Redacted.value(target.apiKey)}`,
        });
      },
    };
    const owner = "worker-budget-e2e";
    const selections: Selection[] = [];
    for (let index = 0; index < apps; index++) {
      const name = `Worker budget ${index} ${randomUUID().slice(0, 8)}`;
      const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
        owner,
        name,
        files: [
          { path: "index.ts", content: budgetApp(name) },
          appsManifest,
          ...databaseFiles(database),
        ],
      });
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
      const { app } = yield* body(App, deployed);
      const path = `/v1/apps/${app.id}`;
      const accounts: string[] = [];
      // Remove the app before the accounts its profiles select.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          expect((yield* api.request(agent, "DELETE", path)).status).toBe(200);
          for (const account of accounts)
            expect((yield* api.request(agent, "DELETE", `/v1/accounts/${account}`)).status).toBe(
              200,
            );
        }).pipe(Effect.orDie),
      );
      for (let account = 0; account < accountsPerApp; account++) {
        const token = `synthetic-budget-${index}-${account}`;
        const created = yield* api.request(agent, "POST", "/v1/accounts", {
          owner,
          provider: app.requirements.accounts.service.provider,
          method: "key",
          label: name,
          fields: { token },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const id = (yield* body(Resource, created)).id;
        accounts.push(id);
        const profile = yield* createProfile(agent, path, {
          owner,
          subject: "local",
        });
        expect(
          (yield* selectProfileAccounts(agent, path, profile.id, {
            service: id,
          })).status,
        ).toBe(200);
        // Profile setup calls the selection's Worker in the background. Wait until it is done, so
        // its calls cannot change which Workers were used most recently while the scenario runs.
        const setup = yield* api.request(agent, "GET", `${path}/profiles/${profile.id}`).pipe(
          Effect.flatMap((response) => body(SetupStatus, response)),
          Effect.flatMap((current) =>
            current.status !== "pending"
              ? Effect.succeed(current.status)
              : Effect.fail(new Error("Profile setup has not finished")),
          ),
          Effect.retry({
            schedule: Schedule.spaced("200 millis"),
            times: 100,
          }),
        );
        expect(setup, `profile setup of app ${index} account ${account}`).toBe("ready");
        const query = (name: string, input: object = {}) =>
          api
            .request(agent, "POST", "/v1/tools/call", {
              app: app.id,
              profile: profile.id,
              tool: name,
              input,
            })
            .pipe(
              Effect.tap((response) =>
                Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
              ),
              Effect.flatMap((response) => body(Completed, response)),
              Effect.map((completed) => completed.value),
            );
        selections.push({
          label: `app ${index} account ${account}`,
          token,
          query,
          observe: (gate) =>
            query("probe", gate === undefined ? {} : { gate }).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Observation)),
            ),
        });
      }
    }
    return selections;
  });

/** Call a selection and check it ran with its own credential. */
const observe = (selection: Selection, gate?: string) =>
  selection
    .observe(gate)
    .pipe(
      Effect.tap((observation) =>
        Effect.sync(() => expect(observation.token, selection.label).toBe(selection.token)),
      ),
    );

/**
 * More apps and account selections than the limit: after every selection has been called, a
 * sweep over all of them finds at most `limit` still loaded, the most recently used ones stay
 * loaded, and every Worker that was unloaded loads again with the right credential. A call that
 * loads `workersPerCall` Workers leaves room for `limit / workersPerCall` recent selections.
 */
const boundedByConfiguration = (selections: ReadonlyArray<Selection>, workersPerCall = 1) =>
  Effect.gen(function* () {
    expect(selections.length).toBeGreaterThan(limit);
    const first: Observation[] = [];
    for (const selection of selections) first.push(yield* observe(selection));
    // Every selection has its own Worker.
    expect(new Set(first.map((entry) => entry.isolate)).size).toBe(selections.length);

    const swept: Observation[] = [];
    for (const selection of selections) swept.push(yield* observe(selection));
    const stillLoaded = swept.filter((entry, index) => entry.isolate === first[index]!.isolate);
    expect(
      stillLoaded.length,
      `selections still loaded after calling ${selections.length}: ${stillLoaded.length}`,
    ).toBeLessThanOrEqual(limit);
    // An unloaded Worker starts again with no module state from its earlier isolate.
    for (const [index, entry] of swept.entries())
      if (entry.isolate !== first[index]!.isolate) expect(entry.calls).toBe(1);

    // The most recently used Workers stay loaded: calling them again, newest first, loads none.
    const kept = Math.floor(limit / workersPerCall);
    expect(kept, "the limit leaves room for a recent selection").toBeGreaterThan(0);
    const recent = selections.slice(-kept).reverse();
    const recentSwept = swept.slice(-kept).reverse();
    for (const [index, selection] of recent.entries()) {
      const again = yield* observe(selection);
      expect(again.isolate, selection.label).toBe(recentSwept[index]!.isolate);
      expect(again.calls).toBe(recentSwept[index]!.calls + 1);
    }
  });

/** Three accounts of one app, each with its own Worker. */
const inFlight = { apps: 1, accountsPerApp: 3, database: false };

/**
 * With a limit of one, a Worker with a call in flight is never unloaded while other Workers load
 * beside it and exceed the limit; each of them is unloaded once its own call finishes.
 */
const inFlightKept = (selections: ReadonlyArray<Selection>) =>
  Effect.gen(function* () {
    const [busy, second, third] = selections as [Selection, Selection, Selection];
    const before = yield* observe(busy);
    const gate = yield* requestGate;
    const pending = yield* observe(busy, `${gate.origin}/wait`).pipe(Effect.forkChild);
    // The busy call is inside its Worker, waiting for the gate, before the others load.
    yield* gate.arrived;
    const secondFirst = yield* observe(second);
    const thirdFirst = yield* observe(third);
    yield* gate.release;
    const during = yield* Fiber.join(pending);
    expect(during.isolate, "the busy Worker finished its call in the same isolate").toBe(
      before.isolate,
    );
    expect(during.calls).toBe(before.calls + 1);
    // The busy Worker was released last, so it stays; the others were unloaded above the limit.
    const after = yield* observe(busy);
    expect(after.isolate).toBe(before.isolate);
    const secondAgain = yield* observe(second);
    expect(secondAgain.isolate, "an idle Worker above the limit was unloaded").not.toBe(
      secondFirst.isolate,
    );
    expect(secondAgain.calls).toBe(1);
    const thirdAgain = yield* observe(third);
    expect(thirdAgain.isolate, "the third Worker was unloaded once its call finished").not.toBe(
      thirdFirst.isolate,
    );
    expect(thirdAgain.calls).toBe(1);
  });

/** Two apps with one account each, whose Workers take turns under a limit of one. */
const releaseHeld = { apps: 2, accountsPerApp: 1, database: false };

/**
 * A call's release drains its cache refreshes in the Worker for up to 35 seconds before its
 * caller stops waiting. A release still running past that limit keeps its Worker loaded until it
 * settles: another Worker loading above the limit does not unload it, and its last refresh
 * completes and stores its value.
 */
const releaseKeptPastItsLimit = (selections: ReadonlyArray<Selection>) =>
  Effect.gen(function* () {
    const [refreshing, other] = selections as [Selection, Selection];
    const before = yield* observe(refreshing);
    yield* refreshing.query("seed");
    // Returns the stale value; its release now waits for the refresh chain.
    expect(yield* refreshing.query("chain")).toBe("seed");
    // The second refresh starts here and must still be running when the release limit passes.
    yield* Effect.sleep("12 seconds");
    yield* refreshing.query("flag", { name: "first-flag" });
    yield* Effect.sleep("25 seconds");
    // Past the release limit: loading another Worker above the limit must not unload this one.
    yield* observe(other);
    const during = yield* observe(refreshing);
    expect(during.isolate, "the Worker with an unfinished release stayed loaded").toBe(
      before.isolate,
    );
    yield* refreshing.query("flag", { name: "second-flag" });
    const chained = yield* refreshing.query("chained").pipe(
      Effect.repeat({
        until: (value) => value === "refreshed",
        schedule: Schedule.spaced("250 millis"),
        times: 20,
      }),
    );
    expect(chained, "the refresh that outlived the release limit completed").toBe("refreshed");
  });

/** One app with a database and two accounts, whose queries alternate between them. */
const replacedFacets = { apps: 1, accountsPerApp: 2, database: true };

/**
 * An app with a database runs one data facet at a time. When a call selects other accounts, the
 * facet it replaces is unloaded rather than kept for the rest of the process, so selecting the
 * first accounts again starts a fresh Worker with its own credential.
 */
const replacedFacetUnloaded = (selections: ReadonlyArray<Selection>) =>
  Effect.gen(function* () {
    const [first, second] = selections as [Selection, Selection];
    const before = yield* observe(first);
    const again = yield* observe(first);
    expect(again.isolate, "calls of one selection share its facet Worker").toBe(before.isolate);
    const other = yield* observe(second);
    expect(other.isolate).not.toBe(before.isolate);
    const back = yield* observe(first);
    expect(back.isolate, "the replaced facet Worker was unloaded").not.toBe(before.isolate);
    expect(back.calls).toBe(1);
  });

/**
 * How long the data supervisor stays idle so the runtime evicts it and builds a new one for the
 * next call. The pinned workerd evicts an idle Durable Object after about ten seconds.
 */
const supervisorEvicted = "20 seconds";

/**
 * The runtime evicts an idle data supervisor but keeps the facet Workers it loaded. Calls that
 * alternate account selections with the supervisor evicted in between still unload each replaced
 * facet, so the app keeps one facet Worker rather than one per account selection ever used.
 */
const replacedFacetUnloadedAfterEviction = (selections: ReadonlyArray<Selection>) =>
  Effect.gen(function* () {
    const [first, second] = selections as [Selection, Selection];
    const before = yield* observe(first);
    yield* Effect.sleep(supervisorEvicted);
    const other = yield* observe(second);
    expect(other.isolate).not.toBe(before.isolate);
    yield* Effect.sleep(supervisorEvicted);
    const back = yield* observe(first);
    expect(back.isolate, "the facet replaced before the eviction was unloaded").not.toBe(
      before.isolate,
    );
    expect(back.calls).toBe(1);
    yield* Effect.sleep(supervisorEvicted);
    const otherAgain = yield* observe(second);
    expect(otherAgain.isolate, "the second facet was unloaded as well").not.toBe(other.isolate);
    expect(otherAgain.calls).toBe(1);
  });

/** One app with two accounts, one called and left idle and one kept busy, and an app with a database. */
const idleWorkers = { apps: 1, accountsPerApp: 2, database: false };
const idleFacet = { apps: 1, accountsPerApp: 1, database: true };
/** Longer than the idle time, with room for the sweep to unload what expired. */
const idleLongEnough = `${appWorkerIdleSeconds * 2 + 2} seconds` as const;

/**
 * Below the limit, an app Worker and a data facet left idle for the configured idle time are
 * unloaded while the scenario makes no requests, so the next call starts a fresh isolate. A Worker
 * with a call in flight for longer than the idle time stays loaded, and so does one released just
 * now.
 */
const idleUnloaded = (workers: ReadonlyArray<Selection>, facets: ReadonlyArray<Selection>) =>
  Effect.gen(function* () {
    const [idle, busy] = workers as [Selection, Selection];
    const [facet] = facets as [Selection];
    const idleBefore = yield* observe(idle);
    const facetBefore = yield* observe(facet);
    const busyBefore = yield* observe(busy);
    const gate = yield* requestGate;
    const pending = yield* observe(busy, `${gate.origin}/wait`).pipe(Effect.forkChild);
    yield* gate.arrived;
    // No requests reach the product while the idle time passes; only the busy call is in flight.
    yield* Effect.sleep(idleLongEnough);
    yield* gate.release;
    const during = yield* Fiber.join(pending);
    expect(during.isolate, "the Worker with a call in flight stayed loaded").toBe(
      busyBefore.isolate,
    );
    expect(during.calls).toBe(busyBefore.calls + 1);
    const after = yield* observe(busy);
    expect(after.isolate, "a Worker released just now stays loaded").toBe(busyBefore.isolate);
    expect(after.calls).toBe(during.calls + 1);
    const idleAgain = yield* observe(idle);
    expect(idleAgain.isolate, "the idle Worker was unloaded").not.toBe(idleBefore.isolate);
    expect(idleAgain.calls).toBe(1);
    const facetAgain = yield* observe(facet);
    expect(facetAgain.isolate, "the idle data facet was unloaded").not.toBe(facetBefore.isolate);
    expect(facetAgain.calls).toBe(1);
  });

/** One app with one account, with or without a database. */
const collectedWorker = { apps: 1, accountsPerApp: 1, database: false };
const collectedFacet = { apps: 1, accountsPerApp: 1, database: true };
/** How long an isolate waits after one collection before the next. */
const collectionInterval = "11 seconds";

/**
 * An old-generation object only a WeakRef holds is freed once its isolate runs a major
 * collection. Its small heap would not start one by itself, so the object is gone only because the
 * isolate collected its garbage after a call made once the collection interval had passed.
 */
const garbageCollected = (selections: ReadonlyArray<Selection>) =>
  Effect.gen(function* () {
    const [selection] = selections as [Selection];
    expect(yield* selection.query("hold")).toBe(true);
    expect(yield* selection.query("drop")).toBe(true);
    yield* Effect.sleep(collectionInterval);
    yield* observe(selection);
    const collected = yield* selection.query("collected").pipe(
      Effect.repeat({
        until: (value) => value === true,
        schedule: Schedule.spaced("250 millis"),
        times: 20,
      }),
    );
    expect(collected, `${selection.label}: the dropped object was collected`).toBe(true);
  });

layer(HostedLive, { excludeTestServices: true })("App Worker budget", (it) => {
  it.effect(
    scenarios.appWorkerGarbageCollected.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          yield* hostedSelections(collectedWorker).pipe(Effect.flatMap(garbageCollected));
          yield* hostedSelections(collectedFacet).pipe(Effect.flatMap(garbageCollected));
        }),
      ),
    { timeout: 120_000 },
  );
  it.effect(
    scenarios.appWorkerIdleUnloaded.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const workers = yield* hostedSelections(idleWorkers);
          const facets = yield* hostedSelections(idleFacet);
          yield* idleUnloaded(workers, facets);
        }),
      ),
    { timeout: 120_000 },
  );
  it.effect(scenarios.appWorkerBudget.title, (context) =>
    withHostedCase(
      context,
      hostedSelections(beyondLimit).pipe(Effect.flatMap(boundedByConfiguration)),
    ),
  );
  it.effect(scenarios.appWorkerBudgetInFlight.title, (context) =>
    withHostedCase(context, hostedSelections(inFlight).pipe(Effect.flatMap(inFlightKept))),
  );
  it.effect(
    scenarios.appWorkerReleaseHeld.title,
    (context) =>
      withHostedCase(
        context,
        hostedSelections(releaseHeld).pipe(Effect.flatMap(releaseKeptPastItsLimit)),
      ),
    { timeout: 120_000 },
  );
  it.effect(scenarios.appDataFacetUnloaded.title, (context) =>
    withHostedCase(
      context,
      hostedSelections(replacedFacets).pipe(Effect.flatMap(replacedFacetUnloaded)),
    ),
  );
  it.effect(scenarios.appDataFacetBudget.title, (context) =>
    withHostedCase(
      context,
      hostedSelections(facetsBeyondLimit).pipe(
        Effect.flatMap((selections) => boundedByConfiguration(selections, facetCallWorkers)),
      ),
    ),
  );
  it.effect(
    scenarios.appDataFacetUnloadedAfterEviction.title,
    (context) =>
      withHostedCase(
        context,
        hostedSelections(replacedFacets).pipe(Effect.flatMap(replacedFacetUnloadedAfterEviction)),
      ),
    { timeout: 180_000 },
  );
});

layer(TestLive, { excludeTestServices: true })("Local app Worker budget", (it) => {
  it.effect(scenarios.localAppWorkerBudget.title, (context) =>
    withCase(context, localSelections(beyondLimit).pipe(Effect.flatMap(boundedByConfiguration))),
  );
});
