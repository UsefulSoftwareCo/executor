import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import {
  connectionsPath,
  connectLocalAccount,
  linkAccount,
  linkedAccountIds,
} from "../support/app-accounts.ts";
import { linkLocal } from "../support/local-links.ts";
import { requestGate } from "../support/request-gate.ts";
import { appsManifest, databaseFiles } from "../support/apps-release.ts";
import { appWorkerBudgetLimit as limit, appWorkerIdleSeconds, scenarios } from "../test-plan.ts";

const beyondLimit = { apps: 2, accountsPerApp: 3, database: false };
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
const SourceStatus = Schema.Struct({ account: Schema.String, status: Schema.String });
const Inventory = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  value: Schema.Json,
});

interface Workload {
  readonly apps: number;
  readonly accountsPerApp: number;
  readonly database: boolean;
}

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
export default defineApp({ user: { accounts: { service } } }, {
  tools: router({
    probe: query({ input: object({ gate: string().optional() }) }, async (ctx, input) => {
      isolate ??= crypto.randomUUID();
      calls++;
      if (input.gate !== undefined) await (await fetch(input.gate)).text();
      return { isolate, calls, token: ctx.user.accounts.service.fields.token };
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
  readonly query: (name: string, input?: object) => Effect.Effect<unknown, unknown, never>;
}

const organizationSetUp = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  for (const actor of [actors.owner, actors.admin]) {
    const status = yield* api.request(actor, "GET", `${prefix}/inventory`).pipe(
      Effect.flatMap((response) => body(Inventory, response)),
      Effect.flatMap((inventory) => {
        const app = inventory.apps.find((app) => app.name === "Executor");
        return app === undefined
          ? Effect.fail(new Error("The default Executor app is not installed yet"))
          : Effect.succeed(`${prefix}/apps/${app.id}`);
      }),
      Effect.flatMap((path) =>
        Effect.gen(function* () {
          const [key] = yield* linkedAccountIds(actor, path);
          if (key === undefined)
            return yield* Effect.fail(new Error("The managed key is not linked yet"));
          const sources = yield* body(
            Schema.Array(SourceStatus),
            yield* api.request(actor, "GET", `${path}/webhook-sources`),
          );
          const source = sources.find((source) => source.account === key);
          return source === undefined || source.status === "pending"
            ? yield* Effect.fail(new Error("The managed key's webhook source has not been set up"))
            : source.status;
        }),
      ),
      Effect.retry({
        schedule: Schedule.spaced("200 millis"),
        times: 100,
      }),
    );
    expect(status, "the managed key's webhook source was set up").toBe("ready");
  }
});

const hostedSelections = ({ apps, accountsPerApp, database }: Workload) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    yield* organizationSetUp;
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
        const pending = yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(path, "user", "service"),
          {},
        );
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
        const setup = api.request(actors.owner, "GET", `${path}/webhook-sources`).pipe(
          Effect.flatMap((response) => body(Schema.Array(SourceStatus), response)),
          Effect.map((sources) => sources.find((source) => source.account === created)?.status),
          Effect.flatMap((current) =>
            current !== undefined && current !== "pending"
              ? Effect.void
              : Effect.fail(new Error("Webhook source setup has not finished")),
          ),
          Effect.retry({
            schedule: Schedule.spaced("200 millis"),
            times: 100,
          }),
        );
        yield* setup;
        const query = (name: string, input: object = {}) =>
          linkAccount(actors.owner, path, "service", created)
            .pipe(
              Effect.provideService(Api, api),
              Effect.andThen(setup),
              Effect.andThen(
                api.request(actors.owner, "POST", `${path}/tools/call`, {
                  tool: name,
                  input,
                }),
              ),
            )
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
    const owner = "local";
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
        const connected = yield* connectLocalAccount(agent, {
          app: app.id,
          requirement: "service",
          method: "key",
          label: name,
          fields: { token },
        });
        const id = connected.id;
        accounts.push(id);
        const setup = api.request(agent, "GET", `${path}/webhook-sources`).pipe(
          Effect.flatMap((response) => body(Schema.Array(SourceStatus), response)),
          Effect.map((sources) => sources.find((source) => source.account === id)?.status),
          Effect.flatMap((current) =>
            current !== undefined && current !== "pending"
              ? Effect.succeed(current)
              : Effect.fail(new Error("Webhook source setup has not finished")),
          ),
          Effect.retry({
            schedule: Schedule.spaced("200 millis"),
            times: 100,
          }),
        );
        expect(yield* setup, `webhook source setup of app ${index} account ${account}`).toBe(
          "ready",
        );
        const query = (name: string, input: object = {}) =>
          linkLocal(agent, app.id, "service", id)
            .pipe(
              Effect.provideService(Api, api),
              Effect.andThen(setup),
              Effect.andThen(
                api.request(agent, "POST", "/v1/tools/call", {
                  app: app.id,
                  tool: name,
                  input,
                }),
              ),
            )
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

const observe = (selection: Selection, gate?: string) =>
  selection
    .observe(gate)
    .pipe(
      Effect.tap((observation) =>
        Effect.sync(() => expect(observation.token, selection.label).toBe(selection.token)),
      ),
    );

const boundedByConfiguration = (selections: ReadonlyArray<Selection>, workersPerCall = 1) =>
  Effect.gen(function* () {
    expect(selections.length).toBeGreaterThan(limit);
    const first: Observation[] = [];
    for (const selection of selections) first.push(yield* observe(selection));
    expect(new Set(first.map((entry) => entry.isolate)).size).toBe(selections.length);

    const swept: Observation[] = [];
    for (const selection of selections) swept.push(yield* observe(selection));
    const stillLoaded = swept.filter((entry, index) => entry.isolate === first[index]!.isolate);
    expect(
      stillLoaded.length,
      `selections still loaded after calling ${selections.length}: ${stillLoaded.length}`,
    ).toBeLessThanOrEqual(limit);
    for (const [index, entry] of swept.entries())
      if (entry.isolate !== first[index]!.isolate) expect(entry.calls).toBe(1);

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

const inFlight = { apps: 1, accountsPerApp: 3, database: false };

const inFlightKept = (selections: ReadonlyArray<Selection>) =>
  Effect.gen(function* () {
    const [busy, second, third] = selections as [Selection, Selection, Selection];
    const before = yield* observe(busy);
    const gate = yield* requestGate;
    const pending = yield* observe(busy, `${gate.origin}/wait`).pipe(Effect.forkChild);
    yield* gate.arrived;
    const secondFirst = yield* observe(second);
    const thirdFirst = yield* observe(third);
    yield* gate.release;
    const during = yield* Fiber.join(pending);
    expect(during.isolate, "the busy Worker finished its call in the same isolate").toBe(
      before.isolate,
    );
    expect(during.calls).toBe(before.calls + 1);
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

const releaseHeld = { apps: 2, accountsPerApp: 1, database: false };

const releaseKeptPastItsLimit = (selections: ReadonlyArray<Selection>) =>
  Effect.gen(function* () {
    const [refreshing, other] = selections as [Selection, Selection];
    const before = yield* observe(refreshing);
    yield* refreshing.query("seed");
    expect(yield* refreshing.query("chain")).toBe("seed");
    yield* Effect.sleep("12 seconds");
    yield* refreshing.query("flag", { name: "first-flag" });
    yield* Effect.sleep("25 seconds");
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

const replacedFacets = { apps: 1, accountsPerApp: 2, database: true };

const supervisorEvicted = "20 seconds";

const replacedFacetUnloaded = (selections: ReadonlyArray<Selection>) =>
  Effect.gen(function* () {
    const [first, second] = selections as [Selection, Selection];
    const initial = yield* observe(first);
    const again = yield* observe(first);
    expect(again.isolate, "calls of one selection share its facet Worker").toBe(initial.isolate);
    const swapped = yield* observe(second);
    expect(swapped.isolate).not.toBe(initial.isolate);
    const before = yield* observe(first);
    expect(before.isolate, "the replaced facet Worker was unloaded").not.toBe(initial.isolate);
    expect(before.calls).toBe(1);

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

const idleWorkers = { apps: 1, accountsPerApp: 2, database: false };
const idleFacet = { apps: 1, accountsPerApp: 1, database: true };
const idleLongEnough = `${appWorkerIdleSeconds * 2 + 2} seconds` as const;

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

const collectedWorker = { apps: 1, accountsPerApp: 1, database: false };
const collectedFacet = { apps: 1, accountsPerApp: 1, database: true };
const collectionInterval = "11 seconds";

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
  it.effect(scenarios.appDataFacetBudget.title, (context) =>
    withHostedCase(
      context,
      hostedSelections(facetsBeyondLimit).pipe(
        Effect.flatMap((selections) => boundedByConfiguration(selections, facetCallWorkers)),
      ),
    ),
  );
  it.effect(
    scenarios.appDataFacetUnloaded.title,
    (context) =>
      withHostedCase(
        context,
        hostedSelections(replacedFacets).pipe(Effect.flatMap(replacedFacetUnloaded)),
      ),
    { timeout: 180_000 },
  );
});

layer(TestLive, { excludeTestServices: true })("Local app Worker budget", (it) => {
  it.effect(scenarios.localAppWorkerBudget.title, (context) =>
    withCase(context, localSelections(beyondLimit).pipe(Effect.flatMap(boundedByConfiguration))),
  );
});
