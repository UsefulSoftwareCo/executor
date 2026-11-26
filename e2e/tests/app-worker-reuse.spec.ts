import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { appBuildLoads, latestRequestBuildLoads, unreadableBuild } from "../support/build-loads.ts";
import { Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { connectionsPath, linkAccount, type LinkScope } from "../support/app-accounts.ts";
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

const rounds = 50;
const rotations = 25;
const interleaved = 16;
const App = Schema.Struct({ id: Schema.String });
const Viewer = Schema.Struct({ userId: Schema.String });
const SourceStatus = Schema.Struct({ account: Schema.String, status: Schema.String });
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
  const status = (app: string, account: string, reader: Session = actors.owner) =>
    api.request(reader, "GET", `${prefix}/apps/${app}/webhook-sources`).pipe(
      Effect.flatMap((response) => body(Schema.Array(SourceStatus), response)),
      Effect.map((sources) => sources.find((source) => source.account === account)?.status),
    );
  const settled = (app: string, account: string, reader: Session = actors.owner) =>
    status(app, account, reader).pipe(
      Effect.flatMap((current) =>
        current !== undefined && current !== "pending"
          ? Effect.succeed(current)
          : Effect.fail(new Error("Webhook source setup has not finished")),
      ),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
    );
  const observe = (app: string, actor = actors.owner) =>
    Effect.gen(function* () {
      const response = yield* api.request(actor, "POST", `${prefix}/apps/${app}/tools/call`, {
        tool: "probe",
        input: {},
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return yield* body(Observation, response);
    });
  const removeAccount = (account: string, owner: Session = actors.owner) =>
    Effect.addFinalizer(() =>
      api.request(owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
    );
  const link = (app: string, account: string) =>
    linkAccount(actors.owner, `${prefix}/apps/${app}`, "service", account).pipe(
      Effect.andThen(settled(app, account)),
    );
  return { api, actors, prefix, deploy, settled, observe, removeAccount, link };
});

const observerSource = (
  options: { readonly name: string; readonly database: boolean; readonly resource: string | null },
  scope: LinkScope,
) => {
  const source = observerApp(options);
  if (scope === "user") return source;
  const appScoped = source
    .replace("{ user: { accounts: { service } } }", "{ app: { accounts: { service } } }")
    .replaceAll(".user.accounts.service", ".app.accounts.service");
  expect(appScoped, "the observer app declares its requirement in app scope").toContain(
    "{ app: { accounts: { service } } }",
  );
  expect(appScoped, "the observer app reads only its app requirement").not.toContain(
    "user.accounts",
  );
  return appScoped;
};

const keyApp = (options: {
  readonly database: boolean;
  readonly resource: string | null;
  readonly scope?: LinkScope;
}) =>
  Effect.gen(function* () {
    const { api, actors, prefix, deploy, settled, observe, removeAccount, link } = yield* scenario;
    const name = `Worker reuse ${randomUUID().slice(0, 8)}`;
    const scope = options.scope ?? "user";
    const app = yield* deploy(name, [
      {
        path: "index.ts",
        content: observerSource(
          { name, database: options.database, resource: options.resource },
          scope,
        ),
      },
      appsManifest,
      ...databaseFiles(options.database),
    ]);
    const path = `${prefix}/apps/${app.id}`;
    const submit = (connection: string, token: string, actor: Session = actors.owner) =>
      api
        .request(actor, "POST", `${prefix}/connections/${connection}/submit`, {
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
    const connect = (
      token: string,
      options: { readonly settle?: boolean; readonly actor?: Session } = {},
    ) =>
      Effect.gen(function* () {
        const actor = options.actor ?? actors.owner;
        const pending = yield* api.request(
          actor,
          "POST",
          connectionsPath(path, scope, "service"),
          {},
        );
        expect(pending.status, JSON.stringify(pending.body)).toBe(200);
        const account = (yield* submit((yield* body(Resource, pending)).id, token, actor)).id;
        yield* removeAccount(account, actor);
        if (options.settle !== false) yield* settled(app.id, account, actor);
        return account;
      });
    const rotate = (account: string, token: string) =>
      Effect.gen(function* () {
        const reconnect = yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(path, scope, "service"),
          {
            account,
          },
        );
        expect(reconnect.status, JSON.stringify(reconnect.body)).toBe(200);
        expect((yield* submit((yield* body(Resource, reconnect)).id, token)).id).toBe(account);
      });
    const run = (actor = actors.owner) =>
      Effect.gen(function* () {
        const started = yield* api.request(actor, "POST", `${path}/workflow-runs`, {
          workflow: "probe",
          input: {},
          key: randomUUID(),
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const { id } = yield* body(Run, started);
        const deadline = (yield* Clock.currentTimeMillis) + 30_000;
        while (true) {
          const response = yield* api.request(actor, "GET", `${path}/workflow-runs/${id}`);
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
    const share = Effect.gen(function* () {
      const access = yield* body(
        Schema.Struct({ revision: Schema.String }),
        yield* api.request(actors.owner, "GET", `${path}/access`),
      );
      const shared = yield* api.request(actors.owner, "PATCH", `${path}/access`, {
        revision: access.revision,
        audience: { kind: "everyone" },
      });
      expect(shared.status, JSON.stringify(shared.body)).toBe(200);
      return actors.member;
    });
    const reconfigure = (account: string) =>
      Effect.gen(function* () {
        const saved = yield* api.request(
          actors.owner,
          "PUT",
          `${path}/webhook-sources/${account}/config`,
          { config: {} },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        return yield* settled(app.id, account);
      });
    return { app, name, connect, share, reconfigure, rotate, observe, run, settled, link };
  });

layer(HostedLive, { excludeTestServices: true })("App worker reuse", (it) => {
  it.effect(scenarios.appWorkerCredentialRotation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { app, connect, rotate, observe, link } = yield* keyApp({
          database: true,
          resource: null,
        });
        const first = yield* connect("synthetic-rotation-0");
        const observed = [yield* observe(app.id)];
        expect(observed[0]).toMatchObject({ previous: null, token: "synthetic-rotation-0" });
        for (let round = 1; round <= rotations; round++) {
          const token = `synthetic-rotation-${round}`;
          yield* rotate(first, token);
          const current = yield* observe(app.id);
          expect(current.token).toBe(token);
          observed.push(current);
        }
        expect(new Set(observed.map((entry) => entry.isolate)).size).toBe(1);
        expect(observed.map((entry) => entry.calls)).toEqual(
          observed.map((_, index) => observed[0]!.calls + index),
        );

        yield* connect("synthetic-other-account");
        const other = yield* observe(app.id);
        expect(other).toMatchObject({ previous: null, token: "synthetic-other-account" });
        expect(other.isolate).not.toBe(observed[0]!.isolate);
        yield* link(app.id, first);
        const back = yield* observe(app.id);
        if ((yield* Target).metadata.target === "cloud") {
          expect(back).toMatchObject({
            isolate: observed[0]!.isolate,
            previous: `synthetic-rotation-${rotations}`,
            token: `synthetic-rotation-${rotations}`,
          });
        } else {
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
        yield* connect("synthetic-workflow-token");
        const runs = yield* Effect.forEach(
          Array.from({ length: rounds }, (_, index) => index),
          () => run(),
          { concurrency: 5 },
        );
        for (const run of runs) {
          expect(run.run).toBe(run.id);
          expect(run.token).toBe("synthetic-workflow-token");
        }
        expect(new Set(runs.map((run) => run.isolate)).size).toBe(1);
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
        const { app, connect, share, observe, run } = yield* keyApp({
          database: false,
          resource: `${issuer.origin}/resource`,
        });
        yield* connect("synthetic-shared-first");
        const member = yield* share;
        yield* connect("synthetic-shared-second", { actor: member });
        const { owner } = yield* Actors;
        const alternate = (actor: typeof member, workflowFirst: boolean) =>
          Effect.forEach(
            Array.from({ length: interleaved }, (_, index) => index),
            (index) => ((index % 2 === 0) === workflowFirst ? run(actor) : observe(app.id, actor)),
          );
        const [firstObserved, secondObserved] = yield* Effect.all(
          [alternate(owner, true), alternate(member, false)],
          { concurrency: 2 },
        );
        for (const [observed, token] of [
          [firstObserved, "synthetic-shared-first"],
          [secondObserved, "synthetic-shared-second"],
        ] as const) {
          for (const entry of observed)
            expect(entry).toMatchObject({ token, fetched: `Bearer ${token}` });
          expect(new Set(observed.map((entry) => entry.isolate)).size).toBe(1);
          expect(observed.map((entry) => entry.previous)).toEqual([
            null,
            ...observed.slice(1).map(() => token),
          ]);
        }
        expect(firstObserved[0]!.isolate).not.toBe(secondObserved[0]!.isolate);
      }),
    ),
  );

  it.effect(scenarios.appWorkerOAuthRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, deploy, settled, observe, removeAccount, link } =
          yield* scenario;
        const http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({ refreshTokens: true, rotateRefreshTokens: true, expiresIn: 20 });
        const name = `Worker refresh ${randomUUID().slice(0, 8)}`;
        const app = yield* deploy(name, [
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
${observer(null)}
export default defineApp({ user: { accounts: { service } } }, {
  tools: router({ probe: query({ input: object({}) }, async (ctx) => observe(ctx.user.accounts.service.fields.access_token)) }),
});`,
          },
          appsManifest,
        ]);
        const path = `${prefix}/apps/${app.id}`;
        const connect = (label: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(path, "user", "service"),
                {},
              ),
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
            yield* settled(app.id, account.id);
            return account.id;
          });
        const refreshes = issuer.metrics.pipe(Effect.map((metrics) => metrics.refreshes));

        const first = yield* connect("Synthetic rotating account");
        const observed: Array<typeof Observation.Type> = [];
        for (let round = 0; round < rounds; round++) {
          const generation = (yield* refreshes) + 1;
          const current = yield* observe(app.id);
          expect(yield* refreshes).toBe(generation);
          expect(current.token).toBe(`synthetic-refreshed-token-${generation}`);
          observed.push(current);
        }
        expect(new Set(observed.map((entry) => entry.isolate)).size).toBe(1);
        expect(observed.map((entry) => entry.calls)).toEqual(
          observed.map((_, index) => observed[0]!.calls + index),
        );

        yield* connect("Synthetic other account");
        const other = yield* observe(app.id);
        expect(other.previous).toBeNull();
        expect(other.isolate).not.toBe(observed[0]!.isolate);
        yield* link(app.id, first);
        const back = yield* observe(app.id);
        expect(back.isolate).toBe(observed[0]!.isolate);
        expect(back.previous).toBe(observed.at(-1)!.token);
      }),
    ),
  );
  it.effect(scenarios.appWorkerColdStartFailure.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        for (const database of [true, false]) {
          const { app, name, connect, reconfigure, observe, run, settled } = yield* keyApp({
            database,
            resource: null,
          });
          const token = `synthetic-cold-start-${database}`;
          const restore = yield* unreadableBuild(name);
          const account = yield* connect(token, { settle: false });
          expect(yield* settled(app.id, account)).toBe("failed");
          yield* restore;
          expect(yield* reconfigure(account)).toBe("ready");
          const observed = [yield* observe(app.id)];
          for (let round = 0; round < 3; round++) observed.push(yield* observe(app.id));
          expect(observed[0]).toMatchObject({ previous: null, token });
          expect(new Set(observed.map((entry) => entry.isolate)).size).toBe(1);
          expect(observed.map((entry) => entry.calls)).toEqual(
            observed.map((_, index) => observed[0]!.calls + index),
          );
          if (!database) {
            const workflow = yield* run();
            expect(workflow).toMatchObject({ isolate: observed[0]!.isolate, token });
          }
        }
      }),
    ),
  );

  it.effect(
    scenarios.appBuildLoads.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          for (const database of [true, false]) {
            const { app, connect, share, observe } = yield* keyApp({ database, resource: null });
            yield* connect("synthetic-loads");
            const calls: Array<{ observation: typeof Observation.Type; loads: number }> = [];
            const call = (round: number) =>
              Effect.gen(function* () {
                const observation = yield* observe(app.id);
                calls.push({
                  observation,
                  loads: yield* latestRequestBuildLoads(`${database}-${round}`),
                });
              });
            for (let round = 0; round < loadRounds; round++) yield* call(round);
            expectOneLoadPerColdStart(calls);

            const forEveryone = yield* keyApp({ database, resource: null, scope: "app" });
            yield* forEveryone.connect("synthetic-loads-everyone");
            const member = yield* forEveryone.share;
            const linker = yield* forEveryone.observe(forEveryone.app.id);
            expect(linker).toMatchObject({ token: "synthetic-loads-everyone" });
            const shared = yield* forEveryone.observe(forEveryone.app.id, member);
            expect(shared).toMatchObject({
              isolate: linker.isolate,
              previous: "synthetic-loads-everyone",
              token: "synthetic-loads-everyone",
            });
            expect(yield* latestRequestBuildLoads(`${database}-shared`)).toBe(0);

            yield* share;
            yield* connect("synthetic-loads-other", { actor: member });
            const [firstCalls, secondCalls] = yield* Effect.all(
              [
                Effect.forEach(Array.from({ length: 6 }), () => observe(app.id)),
                Effect.forEach(Array.from({ length: 6 }), () => observe(app.id, member)),
              ],
              { concurrency: 2 },
            );
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
                ...firstCalls,
                ...secondCalls,
              ]);
            else
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
            yield* connect("synthetic-attribution");
            yield* observe(app.id);
            const identities = yield* telemetry
              .spans(
                "runtime.app.invoke",
                { organization: actors.organization.id },
                { "executor.user.id": viewer.userId },
              )
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
