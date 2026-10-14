/**
 * An app schedule has one copy, without an actor, which the app's managers control. It runs
 * without a caller, with the accounts linked for everyone only, and waits while a plain requirement
 * has none linked. A workflow it starts runs in the app scope too.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { appLinksFixture, keyProvider, ok, okBody, refused } from "../support/app-links.ts";
import { WorkflowRun } from "../support/workflow-app.ts";
import { scenarios } from "../test-plan.ts";

/**
 * `tick` records the account it ran with and whether it had a caller, then starts `capture`, which
 * sleeps and then reads the account it captured in a step. `observe` records the `capture` runs as
 * the app sees them; an app schedule runs it, since only app-scope work sees runs without an actor.
 */
const appSource = `import { defineApp, defineProvider, secrets, query, mutation, workflow, appInterval, object, string, router,
  type QueryContext, type MutationContext, type WorkflowContext } from "apps";
const team = ${keyProvider("App schedule fixture")};
const requirements = { app: { accounts: { team } } };
const tick = mutation({ input: object({}) }, async (ctx: MutationContext<typeof requirements, "app">) => {
  ctx.sql.exec("INSERT INTO ticks (account, caller) VALUES (?, ?)", ctx.app.accounts.team.id, "user" in ctx ? "caller" : "none");
  await ctx.workflows.start({ workflow: "capture", input: {} });
  return ctx.app.accounts.team.id;
});
const ticks = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) =>
  ctx.sql.exec("SELECT account, caller FROM ticks ORDER BY seq").toArray());
const observe = mutation({ input: object({}) }, async (ctx: MutationContext<typeof requirements, "app">) => {
  for (const run of (await ctx.workflows.list({ workflow: "capture" })).items)
    ctx.sql.exec("INSERT OR REPLACE INTO observed (run, status, error, step) VALUES (?, ?, ?, ?)", run.id, run.status,
      run.status === "errored" ? run.error : null, run.status === "errored" ? run.failure?.step ?? null : null);
  return null;
});
const observed = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) =>
  ctx.sql.exec("SELECT run, status, error, step FROM observed").toArray());
const capture = workflow({ input: object({}) }, async (ctx: WorkflowContext<typeof requirements, "app">) => {
  await ctx.step.sleep("hold", 3000);
  return await ctx.step.do("use", async (step) => ({ caller: "user" in step, account: step.app.accounts.team.id, token: step.app.accounts.team.fields.token }));
});
export default defineApp(requirements, async () => ({
  tools: router({ tick, ticks, observe, observed }),
  workflows: { capture },
  schedules: { tick: appInterval({ minutes: 1 }, tick, {}), observe: appInterval({ minutes: 1 }, observe, {}) },
}));`;
/** The same declaration as a member's schedule, before it became the app's. */
const userSource = `import { defineApp, defineProvider, secrets, query, mutation, userInterval, object, string, router } from "apps";
const team = ${keyProvider("App schedule fixture")};
const tick = mutation({ input: object({}) }, async () => "user tick");
export default defineApp({ app: { accounts: { team } } }, async () => ({
  tools: router({ tick }),
  schedules: { tick: userInterval({ minutes: 1 }, tick, {}) },
}));`;
const migration = {
  path: "migrations/0001_ticks.sql",
  content:
    "CREATE TABLE ticks (seq INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, caller TEXT NOT NULL);\n" +
    "CREATE TABLE observed (run TEXT PRIMARY KEY, status TEXT NOT NULL, error TEXT, step TEXT);\n",
};
const Settings = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  actor: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  accountRequired: Schema.optional(Schema.String),
});
const Runs = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    scheduleId: Schema.String,
    name: Schema.String,
    status: Schema.String,
  }),
);
const Observed = Schema.Array(
  Schema.Struct({
    run: Schema.String,
    status: Schema.String,
    error: Schema.NullOr(Schema.String),
    step: Schema.NullOr(Schema.String),
  }),
);
const Ticks = Schema.Array(Schema.Struct({ account: Schema.String, caller: Schema.String }));
const Page = Schema.Struct({ items: Schema.Array(Resource) });

layer(HostedLive, { excludeTestServices: true })("App schedules", (it) => {
  it.effect(scenarios.hostedAppSchedules.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        // The declaration starts as a member's schedule; the member enables their copy.
        const fixture = yield* appLinksFixture([
          { path: "index.ts", content: userSource },
          migration,
        ]);
        const { api, actors, prefix, app, path, connect, unlink, link } = fixture;
        const schedules = (reader: Session = actors.owner) =>
          api.request(reader, "GET", `${path}/schedules`).pipe(
            Effect.tap(ok),
            Effect.flatMap((response) => body(Schema.Array(Settings), response)),
          );
        const configure = (actor: Session, enabled: boolean, scope?: "app") =>
          api.request(actor, "PATCH", `${path}/schedules/tick`, {
            enabled,
            ...(scope === undefined ? {} : { scope }),
          });
        const copyPath = (id: string) => `${path}/schedules/tick/copies/${id}`;
        const runs = api
          .request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`)
          .pipe(Effect.flatMap((response) => body(Runs, response)));
        const runsWith = (status: string, count: number) =>
          runs.pipe(
            Effect.flatMap((rows) =>
              rows.filter((row) => row.status === status).length >= count
                ? Effect.succeed(rows)
                : Effect.fail(new Error(`No ${status} run yet: ${JSON.stringify(rows)}`)),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );
        const ticks = fixture.call(actors.member, "ticks").pipe(
          Effect.tap(ok),
          Effect.flatMap((response) => body(Ticks, response)),
        );
        // Evaluating the app needs its app link, which a manager connects first.
        const team = yield* connect(actors.owner, "app", "team", "team-key");
        const memberCopy = yield* okBody(Settings, yield* configure(actors.member, true));
        expect(memberCopy.actor).toBe(fixture.ids.member);

        // Deploying the declaration as an app schedule replaces the members' copies with one
        // schedule without an actor, which starts paused.
        const redeployed = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          files: [{ path: "index.ts", content: appSource }, migration, appsManifest],
        });
        expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
        expect(yield* schedules()).toEqual([]);

        // Only the app's managers enable it, and a member cannot make a copy of their own.
        expect((yield* configure(actors.member, true, "app")).status).toBe(403);
        expect((yield* configure(actors.member, true)).status).not.toBe(200);
        expect(yield* schedules()).toEqual([]);
        const enabled = yield* okBody(Settings, yield* configure(actors.admin, true, "app"));
        expect(enabled).toMatchObject({ name: "tick", actor: null, enabled: true });
        expect(enabled.accountRequired).toBeUndefined();
        const appSchedule = copyPath(enabled.id);

        // Members can see it but not run, pause or remove it.
        expect(yield* schedules(actors.member)).toMatchObject([{ id: enabled.id, actor: null }]);
        expect((yield* api.request(actors.member, "POST", `${appSchedule}/run`)).status).toBe(403);
        expect(
          (yield* api.request(actors.member, "PATCH", appSchedule, { enabled: false })).status,
        ).toBe(403);
        expect((yield* api.request(actors.member, "DELETE", appSchedule)).status).toBe(403);

        // A manager runs it: it runs without a caller, with the linked account.
        yield* ok(yield* api.request(actors.owner, "POST", `${appSchedule}/run`));
        yield* runsWith("succeeded", 1);
        expect(yield* ticks).toEqual([{ account: team, caller: "none" }]);

        // Unlinking does not pause it: it waits for an account and refuses to run.
        yield* ok(yield* unlink(actors.owner, "team", team));
        expect(yield* schedules()).toMatchObject([
          { id: enabled.id, enabled: true, accountRequired: "team" },
        ]);
        yield* refused(
          yield* api.request(actors.owner, "POST", `${appSchedule}/run`),
          409,
          "AccountRequired",
        );
        expect((yield* runs).map((run) => run.status)).toEqual(["succeeded"]);

        // Linking an account again resumes it.
        yield* ok(yield* link(actors.owner, "team", team));
        expect((yield* schedules())[0]?.accountRequired).toBeUndefined();
        yield* ok(yield* api.request(actors.admin, "POST", `${appSchedule}/run`));
        yield* runsWith("succeeded", 2);
        expect(yield* ticks).toEqual([
          { account: team, caller: "none" },
          { account: team, caller: "none" },
        ]);

        // Managers pause and remove it.
        expect(
          yield* okBody(
            Settings,
            yield* api.request(actors.admin, "PATCH", appSchedule, { enabled: false }),
          ),
        ).toMatchObject({ enabled: false, actor: null });
        yield* ok(yield* api.request(actors.owner, "DELETE", appSchedule));
        expect(yield* schedules()).toEqual([]);
      }),
    ),
  );
  it.effect(scenarios.hostedAppScopeWorkflows.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, team, start, unlink, link } = yield* appWorkflowFixture;
        // The run the app schedule started has no caller and reads the linked account.
        const first = yield* start([]);
        const completed = yield* waitForRun(api, actors.owner, path, first, "complete");
        expect(completed.output).toEqual({ caller: false, account: team, token: "team-key" });
        // A member may read the app's run while its captured account is linked for everyone.
        const history = `${path}/workflow-runs/${first}`;
        yield* ok(yield* api.request(actors.member, "GET", history));
        // Retained history is checked by the captured app account's current app link, even for
        // the owner, who can still use the account.
        yield* ok(yield* unlink(actors.owner, "team", team));
        expect((yield* api.request(actors.owner, "GET", history)).status).toBe(403);
        expect((yield* api.request(actors.member, "GET", history)).status).toBe(403);
        yield* ok(yield* link(actors.owner, "team", team));
        yield* ok(yield* api.request(actors.member, "GET", history));
      }),
    ),
  );
  it.effect(scenarios.hostedAppScopeWorkflowUnlinked.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appWorkflowFixture;
        const { api, actors, prefix, app, path, team, start, connect, unlink, link } = fixture;
        // The run captures the account as it starts; it is unlinked while the run sleeps, so the
        // run's step fails as a revoked credential would.
        const run = yield* start([]);
        yield* ok(yield* unlink(actors.owner, "team", team));
        // Reading the run needs the captured account linked. Another account linked in its place
        // lets the app's own schedule report the run, which keeps the account it captured.
        const spare = yield* connect(actors.owner, "app", "team", "spare-key");
        const observer = yield* okBody(
          Settings,
          yield* api.request(actors.owner, "PATCH", `${path}/schedules/observe`, {
            enabled: true,
            scope: "app",
          }),
        );
        const observations = api
          .request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`)
          .pipe(
            Effect.flatMap((response) => body(Runs, response)),
            Effect.map(
              (rows) =>
                rows.filter((row) => row.name === "observe" && row.status === "succeeded").length,
            ),
          );
        /** Run `observe` and wait for it, then read what it recorded for the run. */
        const observe = Effect.gen(function* () {
          const before = yield* observations;
          yield* ok(
            yield* api.request(
              actors.owner,
              "POST",
              `${path}/schedules/observe/copies/${observer.id}/run`,
            ),
          );
          yield* observations.pipe(
            Effect.flatMap((count) =>
              count > before ? Effect.void : Effect.fail(new Error("observe has not run")),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );
          const rows = yield* okBody(Observed, yield* fixture.call(actors.owner, "observed"));
          return rows.find((row) => row.run === run);
        });
        const failed = yield* observe.pipe(
          Effect.flatMap((row) =>
            row?.status === "errored"
              ? Effect.succeed(row)
              : row?.status === "complete"
                ? Effect.die(new Error(`The run used an account: ${JSON.stringify(row)}`))
                : Effect.fail(new Error(`The run has not failed: ${JSON.stringify(row)}`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
        );
        expect(failed, JSON.stringify(failed)).toEqual({
          run,
          status: "errored",
          error: "credentials",
          step: "use",
        });
        // Linked again, the captured account makes the failed run readable.
        yield* ok(yield* unlink(actors.owner, "team", spare));
        yield* ok(yield* link(actors.owner, "team", team));
        const read = yield* waitForRun(api, actors.owner, path, run, "errored");
        expect(read).toMatchObject({ error: "credentials", failure: { step: "use" } });
      }),
    ),
  );
});

/** The app with its account linked for everyone and its app schedule enabled. */
const appWorkflowFixture = Effect.gen(function* () {
  const fixture = yield* appLinksFixture([{ path: "index.ts", content: appSource }, migration]);
  const { api, actors, path, connect } = fixture;
  const team = yield* connect(actors.owner, "app", "team", "team-key");
  const enabled = yield* okBody(
    Settings,
    yield* api.request(actors.owner, "PATCH", `${path}/schedules/tick`, {
      enabled: true,
      scope: "app",
    }),
  );
  /** Run the app schedule and return the workflow run it started, beside the `known` ones. */
  const start = (known: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* ok(
        yield* api.request(actors.owner, "POST", `${path}/schedules/tick/copies/${enabled.id}/run`),
      );
      const runs = yield* waitForWorkflows(api, actors.owner, path, known.length + 1);
      const started = runs.find((item) => !known.includes(item.id));
      if (started === undefined) return yield* Effect.die(new Error("No workflow run"));
      return started.id;
    });
  return { ...fixture, team, start };
});

/** Read one workflow run until it reaches `status`; fails after 20 seconds. */
const waitForRun = (
  api: Effect.Success<typeof Api>,
  actor: Session,
  path: string,
  id: string,
  status: string,
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 20_000;
    for (;;) {
      const response = yield* api.request(actor, "GET", `${path}/workflow-runs/${id}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const run = yield* body(WorkflowRun, response);
      if (run.status === status) return run;
      expect(yield* Clock.currentTimeMillis, JSON.stringify(run)).toBeLessThan(deadline);
      yield* Effect.sleep("200 millis");
    }
  });
/** Wait until `actor` sees at least `count` workflow runs of the app, and return them. */
const waitForWorkflows = (
  api: Effect.Success<typeof Api>,
  actor: Session,
  path: string,
  count: number,
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 20_000;
    for (;;) {
      const response = yield* api.request(actor, "GET", `${path}/workflow-runs`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const page = yield* body(Page, response);
      if (page.items.length >= count) return page.items;
      expect(yield* Clock.currentTimeMillis, JSON.stringify(page)).toBeLessThan(deadline);
      yield* Effect.sleep("200 millis");
    }
  });
