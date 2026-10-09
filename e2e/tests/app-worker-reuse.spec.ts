/**
 * An app's runtime Worker is identified by its code and account selection, never by credential
 * values or workflow runs. Each authored module reports a per-isolate identifier from module
 * state, so a Worker that the runtime loaded again shows up as a new identifier.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { appBuildLoads, latestRequestBuildLoads, unreadableBuild } from "../support/build-loads.ts";
import { Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import {
  expectFacetLoadsOnlyAtColdStarts,
  expectIsolatedAccounts,
  expectIsolatedAccountsAcrossReplacedFacets,
  expectOneLoadPerColdStart,
  loadRounds,
  Observation,
  observer,
  observerApp,
  RunObservation,
} from "../support/worker-observer.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest, databaseFiles } from "../support/apps-release.ts";

/** Token renewals and workflow runs, each a single request to the product. */
const rounds = 50;
/** Saved-key replacements take three requests each, so fewer fit the scenario deadline. */
const rotations = 25;
/** Serial, alternating tool calls and workflow runs per account; two accounts run concurrently. */
const interleaved = 16;
const App = Schema.Struct({ id: Schema.String });
const Viewer = Schema.Struct({ userId: Schema.String });
const SetupStatus = Schema.Struct({ status: Schema.String });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Run = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  output: Schema.optionalKey(Schema.Json),
});

const scenario = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
    Effect.gen(function* () {
      const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name,
        files,
      });
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
      const app = yield* body(App, deployed);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      return app;
    });
  /** Wait until background profile setup has resolved the profile's accounts. */
  const settled = (app: string, profile: string) =>
    api.request(actors.owner, "GET", `${prefix}/apps/${app}/profiles/${profile}`).pipe(
      Effect.flatMap((response) => body(SetupStatus, response)),
      Effect.flatMap((current) =>
        current.status !== "pending"
          ? Effect.void
          : Effect.fail(new Error("Profile setup has not finished")),
      ),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
    );
  const observe = (app: string, profile: string) =>
    Effect.gen(function* () {
      const response = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/apps/${app}/tools/call`,
        {
          profile,
          tool: "probe",
          input: {},
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return yield* body(Observation, response);
    });
  const removeAccount = (account: string) =>
    Effect.addFinalizer(() =>
      api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
    );
  return { api, actors, prefix, deploy, settled, observe, removeAccount };
});

/** An observer app with a key account, whose saved credential can be replaced in place. */
const keyApp = (options: { readonly database: boolean; readonly resource: string | null }) =>
  Effect.gen(function* () {
    const { api, actors, prefix, deploy, settled, observe, removeAccount } = yield* scenario;
    const name = `Worker reuse ${randomUUID().slice(0, 8)}`;
    const app = yield* deploy(name, [
      { path: "index.ts", content: observerApp({ name, ...options }) },
      appsManifest,
      ...databaseFiles(options.database),
    ]);
    const path = `${prefix}/apps/${app.id}`;
    const submit = (connection: string, token: string) =>
      api
        .request(actors.owner, "POST", `${prefix}/connections/${connection}/submit`, {
          method: "key",
          label: name,
          fields: { token },
        })
        .pipe(
          Effect.tap((saved) =>
            Effect.sync(() => expect(saved.status, JSON.stringify(saved.body)).toBe(200)),
          ),
          Effect.flatMap((saved) => body(Resource, saved)),
        );
    const connect = (token: string, options: { readonly settle: boolean } = { settle: true }) =>
      Effect.gen(function* () {
        const profile = yield* createProfile(actors.owner, path);
        const pending = yield* api.request(actors.owner, "POST", `${path}/connections`, {
          requirement: "service",
          profile: profile.id,
        });
        expect(pending.status, JSON.stringify(pending.body)).toBe(200);
        const account = (yield* submit((yield* body(Resource, pending)).id, token)).id;
        yield* removeAccount(account);
        if (options.settle) yield* settled(app.id, profile.id);
        return { profile: profile.id, account };
      });
    /** Replace the saved credential of the same account, as a user's key rotation does. */
    const rotate = (
      selected: { readonly profile: string; readonly account: string },
      token: string,
    ) =>
      Effect.gen(function* () {
        const { profile, account } = selected;
        const reconnect = yield* api.request(actors.owner, "POST", `${path}/connections`, {
          requirement: "service",
          profile,
          account,
        });
        expect(reconnect.status, JSON.stringify(reconnect.body)).toBe(200);
        expect((yield* submit((yield* body(Resource, reconnect)).id, token)).id).toBe(account);
      });
    /** Start one workflow run and wait for the observation it returns. */
    const run = (profile: string) =>
      Effect.gen(function* () {
        const started = yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
          profile,
          workflow: "probe",
          input: {},
          key: randomUUID(),
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const { id } = yield* body(Run, started);
        const deadline = (yield* Clock.currentTimeMillis) + 30_000;
        while (true) {
          const response = yield* api.request(actors.owner, "GET", `${path}/workflow-runs/${id}`);
          expect(response.status).toBe(200);
          const current = yield* body(Run, response);
          if (current.status === "complete")
            return { id, ...(yield* Schema.decodeUnknownEffect(RunObservation)(current.output)) };
          expect(["errored", "terminated"].includes(current.status), JSON.stringify(current)).toBe(
            false,
          );
          expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
          yield* Effect.sleep("100 millis");
        }
      });
    /** Another profile that selects an existing account, so both share one app Worker. */
    const share = (account: string) =>
      Effect.gen(function* () {
        const profile = yield* createProfile(actors.owner, path);
        const selected = yield* selectProfileAccounts(actors.owner, path, profile.id, {
          service: account,
        });
        expect(selected.status, JSON.stringify(selected.body)).toBe(200);
        yield* settled(app.id, profile.id);
        return profile.id;
      });
    return { app, name, connect, share, rotate, observe, run, settled };
  });

layer(HostedLive, { excludeTestServices: true })("App worker reuse", (it) => {
  it.effect(scenarios.appWorkerCredentialRotation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { app, connect, rotate, observe } = yield* keyApp({
          database: true,
          resource: null,
        });
        const first = yield* connect("synthetic-rotation-0");
        const observed = [yield* observe(app.id, first.profile)];
        expect(observed[0]).toMatchObject({ previous: null, token: "synthetic-rotation-0" });
        for (let round = 1; round <= rotations; round++) {
          const token = `synthetic-rotation-${round}`;
          yield* rotate(first, token);
          const current = yield* observe(app.id, first.profile);
          // Every call receives the current credential, never one captured by an earlier call.
          expect(current.token).toBe(token);
          observed.push(current);
        }
        // Rotating one account's credential reuses its loaded app Worker.
        expect(new Set(observed.map((entry) => entry.isolate)).size).toBe(1);
        expect(observed.map((entry) => entry.calls)).toEqual(
          observed.map((_, index) => observed[0]!.calls + index),
        );

        // Another account's calls run in another Worker, with no module state from the first.
        const second = yield* connect("synthetic-other-account");
        const other = yield* observe(app.id, second.profile);
        expect(other).toMatchObject({ previous: null, token: "synthetic-other-account" });
        expect(other.isolate).not.toBe(observed[0]!.isolate);
        const back = yield* observe(app.id, first.profile);
        if ((yield* Target).metadata.target === "cloud") {
          // Returning to the first account resumes its loaded Worker and its module state.
          expect(back).toMatchObject({
            isolate: observed[0]!.isolate,
            previous: `synthetic-rotation-${rotations}`,
            token: `synthetic-rotation-${rotations}`,
          });
        } else {
          // Self-host unloads the data facet another account replaced, so memory does not grow
          // with the account selections ever used: the first account loads a fresh one.
          expect(back).toMatchObject({ previous: null, token: `synthetic-rotation-${rotations}` });
          expect(back.isolate).not.toBe(observed[0]!.isolate);
        }
      }),
    ),
  );

  it.effect(scenarios.appWorkerWorkflowRuns.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { app, connect, run } = yield* keyApp({ database: true, resource: null });
        const first = yield* connect("synthetic-workflow-token");
        // Each workflow run receives its own run capability without loading another Worker.
        const runs = yield* Effect.forEach(
          Array.from({ length: rounds }, (_, index) => index),
          () => run(first.profile),
          { concurrency: 5 },
        );
        for (const run of runs) {
          expect(run.run).toBe(run.id);
          expect(run.token).toBe("synthetic-workflow-token");
        }
        expect(new Set(runs.map((run) => run.isolate)).size).toBe(1);
        // The runs share one app Worker, and profile setup starts the data facet; each loaded the
        // build once. A workflow cold start records its load under the Worker name the runtime
        // loads it by, so it adds no second Worker runtime.
        const loads = yield* appBuildLoads(app.id);
        expect(
          Object.values(loads).every((count) => count === 1),
          JSON.stringify(loads),
        ).toBe(true);
        expect(
          Object.keys(loads).filter((runtime) => runtime.startsWith("worker ")),
          JSON.stringify(loads),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect(scenarios.appWorkerSharedContexts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const issuer = yield* oauthSetupIssuer;
        const { app, connect, observe, run } = yield* keyApp({
          database: false,
          resource: `${issuer.origin}/resource`,
        });
        const [first, second] = yield* Effect.all(
          [connect("synthetic-shared-first"), connect("synthetic-shared-second")],
          { concurrency: 2 },
        );
        // Each self-host call has its own session context and each run its own workflow instance,
        // so every observation after an account's first uses a Worker loaded by a finished context.
        const alternate = (profile: string, workflowFirst: boolean) =>
          Effect.forEach(
            Array.from({ length: interleaved }, (_, index) => index),
            (index) =>
              (index % 2 === 0) === workflowFirst ? run(profile) : observe(app.id, profile),
          );
        const [firstObserved, secondObserved] = yield* Effect.all(
          [alternate(first.profile, true), alternate(second.profile, false)],
          { concurrency: 2 },
        );
        for (const [observed, token] of [
          [firstObserved, "synthetic-shared-first"],
          [secondObserved, "synthetic-shared-second"],
        ] as const) {
          // Outbound fetch works from a reused Worker and carries this account's credential.
          for (const entry of observed)
            expect(entry).toMatchObject({ token, fetched: `Bearer ${token}` });
          // One account's calls and runs share one Worker and its module state.
          expect(new Set(observed.map((entry) => entry.isolate)).size).toBe(1);
          expect(observed.map((entry) => entry.previous)).toEqual([
            null,
            ...observed.slice(1).map(() => token),
          ]);
        }
        // Another account's calls and runs use another Worker.
        expect(firstObserved[0]!.isolate).not.toBe(secondObserved[0]!.isolate);
      }),
    ),
  );

  it.effect(scenarios.appWorkerOAuthRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, deploy, settled, observe, removeAccount } = yield* scenario;
        const http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        // Tokens issued inside the host's 30-second renewal window renew on every call. As with
        // rotating providers, each renewal replaces the refresh token and refuses the old one.
        yield* issuer.configure({ refreshTokens: true, rotateRefreshTokens: true, expiresIn: 20 });
        const name = `Worker refresh ${randomUUID().slice(0, 8)}`;
        const app = yield* deploy(name, [
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
${observer(null)}
export default defineApp({ accounts: { service } }, {
  tools: router({ probe: query({ input: object({}) }, async (ctx) => observe(ctx.accounts.service.fields.access_token)) }),
});`,
          },
          appsManifest,
        ]);
        const path = `${prefix}/apps/${app.id}`;
        const connect = (label: string) =>
          Effect.gen(function* () {
            const profile = yield* createProfile(actors.owner, path);
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${path}/connections`, {
                requirement: "service",
                profile: profile.id,
              }),
            );
            const started = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/start`,
              { method: "oauth", label },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const { authorizationUrl } = yield* body(SignIn, started);
            const callbackUrl = yield* Effect.scoped(
              Effect.gen(function* () {
                const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
                expect(consent.status).toBe(302);
                const location = consent.headers.location;
                if (location === undefined)
                  return yield* Effect.die("Issuer did not return a callback");
                return location;
              }),
            ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
            const completed = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/complete`,
              { callbackUrl },
            );
            expect(completed.status, JSON.stringify(completed.body)).toBe(200);
            const account = yield* body(Resource, completed);
            yield* removeAccount(account.id);
            yield* settled(app.id, profile.id);
            return { profile: profile.id, account: account.id };
          });
        const refreshes = issuer.metrics.pipe(Effect.map((metrics) => metrics.refreshes));

        const first = yield* connect("Synthetic rotating account");
        const observed: Array<typeof Observation.Type> = [];
        for (let round = 0; round < rounds; round++) {
          const generation = (yield* refreshes) + 1;
          const current = yield* observe(app.id, first.profile);
          // Each call renews the grant once, with the latest refresh token, and presents the result.
          expect(yield* refreshes).toBe(generation);
          expect(current.token).toBe(`synthetic-refreshed-token-${generation}`);
          observed.push(current);
        }
        // Renewing the account's token reuses its loaded app Worker.
        expect(new Set(observed.map((entry) => entry.isolate)).size).toBe(1);
        expect(observed.map((entry) => entry.calls)).toEqual(
          observed.map((_, index) => observed[0]!.calls + index),
        );

        // A different account's grant never reaches the first account's module state.
        const second = yield* connect("Synthetic other account");
        const other = yield* observe(app.id, second.profile);
        expect(other.previous).toBeNull();
        expect(other.isolate).not.toBe(observed[0]!.isolate);
        const back = yield* observe(app.id, first.profile);
        expect(back.isolate).toBe(observed[0]!.isolate);
        expect(back.previous).toBe(observed.at(-1)!.token);
      }),
    ),
  );
  it.effect(scenarios.appWorkerColdStartFailure.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix } = yield* scenario;
        for (const database of [true, false]) {
          const { app, name, connect, share, observe, run, settled } = yield* keyApp({
            database,
            resource: null,
          });
          const path = `${prefix}/apps/${app.id}`;
          const status = (profile: string) =>
            api
              .request(actors.owner, "GET", `${path}/profiles/${profile}`)
              .pipe(Effect.flatMap((response) => body(SetupStatus, response)));
          // Profile setup reads the app's webhook definitions, which cold-starts the data facet of
          // an app with a database and the app Worker otherwise. The account is selected while the
          // build is unreadable, so that first cold start of its runtime cannot load the build.
          const token = `synthetic-cold-start-${database}`;
          const restore = yield* unreadableBuild(name);
          const failed = yield* connect(token, { settle: false });
          yield* settled(app.id, failed.profile);
          expect((yield* status(failed.profile)).status).toBe("failed");
          yield* restore;
          // Once the build is readable, another profile selecting the same account is set up. Its
          // setup cold-starts the same runtime by the same name, which loads the build rather than
          // keeping the failed cold start for the rest of the runtime's life.
          const profile = yield* share(failed.account);
          expect((yield* status(profile)).status).toBe("ready");
          const observed = [yield* observe(app.id, profile)];
          for (let round = 0; round < 3; round++) observed.push(yield* observe(app.id, profile));
          expect(observed[0]).toMatchObject({ previous: null, token });
          expect(new Set(observed.map((entry) => entry.isolate)).size).toBe(1);
          expect(observed.map((entry) => entry.calls)).toEqual(
            observed.map((_, index) => observed[0]!.calls + index),
          );
          if (!database) {
            // Workflow runs share the recovered Worker.
            const workflow = yield* run(profile);
            expect(workflow).toMatchObject({ isolate: observed[0]!.isolate, token });
          }
        }
      }),
    ),
  );

  // Twenty serial calls per app wait for each call's delivered trace, and on hosts that unload
  // replaced data facets every switch between the two accounts cold-starts a facet.
  it.effect(
    scenarios.appBuildLoads.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          for (const database of [true, false]) {
            const { app, connect, share, observe } = yield* keyApp({ database, resource: null });
            const first = yield* connect("synthetic-loads");
            const calls: Array<{ observation: typeof Observation.Type; loads: number }> = [];
            const call = (round: number) =>
              Effect.gen(function* () {
                const observation = yield* observe(app.id, first.profile);
                calls.push({
                  observation,
                  loads: yield* latestRequestBuildLoads(`${database}-${round}`),
                });
              });
            for (let round = 0; round < loadRounds; round++) yield* call(round);
            expectOneLoadPerColdStart(calls);

            // A profile that selects the same account shares its loaded Worker and loads nothing.
            const shared = yield* observe(app.id, yield* share(first.account));
            expect(shared).toMatchObject({
              isolate: calls[0]!.observation.isolate,
              previous: "synthetic-loads",
              token: "synthetic-loads",
            });
            expect(yield* latestRequestBuildLoads(`${database}-shared`)).toBe(0);

            // Another account's Worker never sees the first account's credential.
            const second = yield* connect("synthetic-loads-other");
            const [firstCalls, secondCalls] = yield* Effect.all(
              [
                Effect.forEach(Array.from({ length: 6 }), () => observe(app.id, first.profile)),
                Effect.forEach(Array.from({ length: 6 }), () => observe(app.id, second.profile)),
              ],
              { concurrency: 2 },
            );
            // Self-host unloads the data facet a call of the other account replaced, so memory does
            // not grow with the account selections ever used: alternating calls start fresh facets.
            // Cloud keeps each account's facet Worker loaded.
            const replacesFacets = database && (yield* Target).metadata.target !== "cloud";
            if (replacesFacets)
              expectIsolatedAccountsAcrossReplacedFacets(
                { observed: firstCalls, token: "synthetic-loads" },
                { observed: secondCalls, token: "synthetic-loads-other" },
              );
            else
              expectIsolatedAccounts(
                { observed: firstCalls, token: "synthetic-loads" },
                { observed: secondCalls, token: "synthetic-loads-other" },
                calls[0]!.observation.isolate,
              );
            const loads = yield* appBuildLoads(app.id);
            expect(Object.keys(loads).length).toBeGreaterThan(0);
            if (replacesFacets)
              expectFacetLoadsOnlyAtColdStarts(loads, [
                ...calls.map((call) => call.observation),
                shared,
                ...firstCalls,
                ...secondCalls,
              ]);
            else
              // Each app Worker and data facet loaded the build once, at its cold start, whichever
              // call or background discovery started it.
              expect(loads, "one build load per runtime").toEqual(
                Object.fromEntries(Object.keys(loads).map((runtime) => [runtime, 1])),
              );
          }
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect(
    scenarios.appWorkerAttribution.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const { api, actors } = yield* scenario;
          const telemetry = yield* Telemetry;
          const viewer = yield* api
            .request(actors.owner, "GET", "/api/viewer")
            .pipe(Effect.flatMap((response) => body(Viewer, response)));
          for (const database of [true, false]) {
            const { app, connect, observe } = yield* keyApp({ database, resource: null });
            const { profile } = yield* connect("synthetic-attribution");
            yield* observe(app.id, profile);
            // Each call's invocation names the Worker it ran in and the caller it ran for.
            const identities = yield* telemetry
              .spans("runtime.app.invoke", {
                "executor.organization.id": actors.organization.id,
                "executor.user.id": viewer.userId,
              })
              .pipe(
                Effect.map((spans) =>
                  spans
                    .map((tags) => tags["executor.worker.identity"])
                    .filter((identity) => identity?.startsWith(`${app.id}:`)),
                ),
                Effect.flatMap((matched) =>
                  matched.length > 0
                    ? Effect.succeed(matched)
                    : Effect.fail(new Error("No attributed invocation has arrived")),
                ),
                Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
              );
            expect(identities.length).toBeGreaterThan(0);
          }
        }),
      ),
    { timeout: 120_000 },
  );
});
