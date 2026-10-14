/**
 * Each member has at most one copy of a declared schedule. It runs as that member, with the
 * accounts they link to the app when it runs: the one link of each plain requirement and every
 * link of a many() requirement.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App, Resource } from "../support/contracts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import {
  Access,
  appAccountsFixture,
  sharedAccountFixture,
} from "../support/hosted-app-accounts.ts";
import {
  connectionsPath,
  linkAccount,
  linkedAccountIds,
  unlinkAccount,
} from "../support/app-accounts.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import {
  declaresEachJob,
  declaresOnly,
  failsFor,
  jobFiles,
  plainTickFiles,
} from "../support/schedule-accounts.ts";

const Settings = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  actor: Schema.String,
  enabled: Schema.Boolean,
  nextAt: Schema.NullOr(Schema.String),
  activeRun: Schema.NullOr(Schema.String),
  revision: Schema.String,
  accountRequired: Schema.optional(Schema.String),
});
type Settings = typeof Settings.Type;
const Runs = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    scheduleId: Schema.String,
    name: Schema.String,
    status: Schema.String,
    failure: Schema.NullOr(Schema.String),
  }),
);
const Failure = Schema.Struct({ _tag: Schema.String });
const Ticks = Schema.Array(Schema.String);
/** More than the schedule's one-minute interval, so each restart makes it due once. */
const occurrence = 61_000;
const introduction =
  "Your schedules run as you, with the accounts you linked to this app. Change them in the app’s Accounts tab.";

/** Schedule reads and controls for an app's `tick` schedule and its copies. */
const tickSchedule = (fixture: {
  readonly api: Effect.Success<typeof Api>;
  readonly actors: typeof Actors.Service;
  readonly prefix: string;
  readonly app: { readonly id: string };
  readonly path: string;
}) => {
  const { api, actors, prefix, app, path } = fixture;
  /** Every member's copies of `tick`, as `reader` lists them. */
  const copies = (reader: Session) =>
    api.request(reader, "GET", `${path}/schedules`).pipe(
      Effect.flatMap((response) => body(Schema.Array(Settings), response)),
      Effect.map((rows) => rows.filter((row) => row.name === "tick")),
    );
  /** One copy, as `reader` lists it. */
  const copy = (reader: Session, id: string) =>
    copies(reader).pipe(Effect.map((rows) => rows.find((row) => row.id === id)));
  const runs = api
    .request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`)
    .pipe(Effect.flatMap((response) => body(Runs, response)));
  /** Wait until the scheduler records this many runs with this outcome. */
  const runsWith = (status: string, count: number) =>
    runs.pipe(
      Effect.flatMap((rows) =>
        rows.filter((row) => row.status === status).length >= count
          ? Effect.succeed(rows)
          : Effect.fail(new Error(`No ${status} run yet: ${JSON.stringify(rows)}`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
    );
  /** The accounts the schedule's runs wrote, read as `reader` with the accounts they link. */
  const ticks = (reader: Session) =>
    api
      .request(reader, "POST", `${path}/tools/call`, { tool: "ticks", kind: "query", input: {} })
      .pipe(
        Effect.tap((response) =>
          Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
        ),
        Effect.flatMap((response) => body(Ticks, response)),
      );
  /** Configure the caller's own copy, adding it when they have none. */
  const configure = (actor: Session, payload: { enabled: boolean }) =>
    api.request(actor, "PATCH", `${path}/schedules/tick`, payload);
  /** Run the caller's own copy. */
  const runNow = (actor: Session) => api.request(actor, "POST", `${path}/schedules/tick/run`);
  /** Control one copy by its address. */
  const pause = (actor: Session, id: string, enabled = false) =>
    api.request(actor, "PATCH", `${path}/schedules/tick/copies/${id}`, { enabled });
  const runCopy = (actor: Session, id: string) =>
    api.request(actor, "POST", `${path}/schedules/tick/copies/${id}/run`);
  const remove = (actor: Session, id: string) =>
    api.request(actor, "DELETE", `${path}/schedules/tick/copies/${id}`);
  /** Require a successful response and decode the copy it returns. */
  const saved = (response: Effect.Success<ReturnType<typeof configure>>) =>
    Effect.gen(function* () {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return yield* body(Settings, response);
    });
  return {
    copies,
    copy,
    runs,
    runsWith,
    ticks,
    configure,
    runNow,
    pause,
    runCopy,
    remove,
    saved,
  };
};
/** An app everyone may use with one plain requirement, so a member's newer link replaces their older one. */
const plainTickApp = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Schedule links ${randomUUID().slice(0, 8)}`,
    files: plainTickFiles,
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed),
    path = `${prefix}/apps/${app.id}`;
  const accounts: { actor: Session; id: string }[] = [];
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* api.request(actors.owner, "DELETE", path);
      for (const item of accounts)
        yield* api.request(item.actor, "DELETE", `${prefix}/accounts/${item.id}`);
    }).pipe(Effect.orDie),
  );
  const access = yield* body(Access, yield* api.request(actors.owner, "GET", `${path}/access`));
  expect(
    (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
      revision: access.revision,
      audience: { kind: "everyone" },
    })).status,
  ).toBe(200);
  /** Connect a personal account from the app, which links it for `actor`. */
  const connect = (actor: Session, label: string) =>
    Effect.gen(function* () {
      const connection = yield* api.request(
        actor,
        "POST",
        connectionsPath(path, "user", "service"),
        {
          destination: { kind: "personal" },
        },
      );
      expect(connection.status, JSON.stringify(connection.body)).toBe(200);
      const submitted = yield* api.request(
        actor,
        "POST",
        `${prefix}/connections/${(yield* body(Resource, connection)).id}/submit`,
        { method: "key", label, fields: { token: `synthetic-${randomUUID()}` } },
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      const account = (yield* body(Resource, submitted)).id;
      accounts.push({ actor, id: account });
      return account;
    });
  return { api, actors, prefix, app, path, connect };
});
/** Let one occurrence fall due while the product is stopped, then start it again. */
const nextOccurrence = Effect.gen(function* () {
  yield* serverControl("stop");
  yield* serverControl("clock/advance", 200, { milliseconds: occurrence });
  yield* serverControl("start");
});
/** Wait until `read` reports a copy whose due occurrence was handled since `before`. */
const handled = (read: Effect.Effect<Settings | undefined, unknown>, before: Settings) =>
  read.pipe(
    Effect.flatMap((current) =>
      current !== undefined &&
      current.activeRun === null &&
      current.nextAt !== null &&
      current.nextAt !== before.nextAt
        ? Effect.succeed(current)
        : Effect.fail(new Error("The occurrence has not been handled")),
    ),
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
  );
/** The signed-in member's row for `tick` on the Schedules tab. */
const row = (page: Page) => page.locator('[aria-label="tick"]');

layer(HostedLive, { excludeTestServices: true })("Hosted account scheduling", (it) => {
  it.effect(scenarios.hostedAccountScheduling.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* sharedAccountFixture;
        const { api, actors, path, aliceId, bobId, shared } = fixture;
        const { copies, runsWith, ticks, configure, pause, runCopy, remove, saved } =
          tickSchedule(fixture);
        // Bob connected the shared account for the plain requirement, which replaced his personal
        // one there. His copy runs as Bob, with that link.
        const bob = yield* saved(yield* configure(actors.admin, { enabled: true }));
        expect(bob).toMatchObject({ actor: bobId, enabled: true });
        expect(bob.accountRequired).toBeUndefined();
        // Alice can neither control Bob's copy nor reach it by name: by name she configures her own.
        expect((yield* pause(actors.member, bob.id)).status).toBe(403);
        expect((yield* runCopy(actors.member, bob.id)).status).toBe(403);
        expect((yield* remove(actors.member, bob.id)).status).toBe(403);
        const alice = yield* saved(yield* configure(actors.member, { enabled: false }));
        expect(alice).toMatchObject({ actor: aliceId, enabled: false });
        expect(alice.id).not.toBe(bob.id);
        expect(
          (yield* copies(actors.owner)).map((row) => [row.actor, row.enabled]).toSorted(),
        ).toEqual(
          [
            [aliceId, false],
            [bobId, true],
          ].toSorted(),
        );
        const started = yield* runCopy(actors.admin, bob.id);
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        yield* runsWith("succeeded", 1);
        expect(yield* ticks(actors.admin)).toEqual([shared]);

        const run = yield* Effect.acquireRelease(
          api
            .request(actors.admin, "POST", `${path}/workflow-runs`, {
              workflow: "capture",
              input: {},
              key: "shared-context",
            })
            .pipe(
              Effect.tap((response) =>
                Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
              ),
              Effect.flatMap((response) => body(Resource, response)),
            ),
          // The forbidden termination below must leave the run untouched. Its
          // actual actor releases it before accounts and the app.
          (run) =>
            Effect.gen(function* () {
              const stopped = yield* api.request(
                actors.admin,
                "POST",
                `${path}/workflow-runs/${run.id}/terminate`,
              );
              expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
              expect(stopped.body).toMatchObject({ id: run.id });
            }).pipe(Effect.orDie),
        );
        // Alice links the same shared account, yet Bob's run stays Bob's.
        expect(
          (yield* api.request(actors.member, "GET", `${path}/workflow-runs/${run.id}`)).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.member, "POST", `${path}/workflow-runs/${run.id}/terminate`))
            .status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.admin, "GET", `${path}/workflow-runs/${run.id}`)).status,
        ).toBe(200);
      }),
    ),
  );
  // Schedules only target declared mutations. Schedule controls must not wait on, or fail with,
  // a dynamic catalog that is slow or unavailable.
  it.effect(scenarios.hostedStaticSchedules.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Static schedules ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, dynamicRouter, mutation, object, userInterval, router } from "apps";
const tick = mutation({ input: object({}) }, async () => "ticked");
export default defineApp({}, async () => ({
  tools: router({
    tick,
    catalog: dynamicRouter({
      list: async () => { throw new Error("Dynamic catalog unavailable"); },
      resolve: async () => undefined,
    }),
  }),
  schedules: { tick: userInterval({ minutes: 1 }, tick, {}) },
}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const path = `${prefix}/${(yield* body(App, deployed)).id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        // The dynamic catalog really fails. Its router reports the failure while the declared
        // mutation still lists.
        const catalog = yield* api.request(actors.owner, "GET", `${path}/tools`);
        expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);
        expect(catalog.body).toMatchObject({
          items: [{ name: "tick" }],
          routers: [{ path: "catalog", error: { _tag: "HostEvaluationFailed" } }],
        });
        const definitions = yield* api.request(
          actors.owner,
          "GET",
          `${path}/schedules/definitions`,
        );
        expect(definitions.status, JSON.stringify(definitions.body)).toBe(200);
        expect(definitions.body).toMatchObject([{ name: "tick", tool: "tick" }]);
        const enabled = yield* api.request(actors.owner, "PATCH", `${path}/schedules/tick`, {
          enabled: true,
        });
        expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
        expect(enabled.body).toMatchObject({ name: "tick", enabled: true });
        const started = yield* api.request(actors.owner, "POST", `${path}/schedules/tick/run`);
        expect(started.status, JSON.stringify(started.body)).toBe(200);
      }),
    ),
  );
  it.effect(scenarios.hostedScheduleMemberCopies.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appAccountsFixture;
        const { actors, app, aliceId, bobId, mailA, mailB } = fixture;
        const {
          copies,
          copy,
          runs,
          runsWith,
          ticks,
          configure,
          runNow,
          pause,
          runCopy,
          remove,
          saved,
        } = tickSchedule(fixture);
        const browser = yield* Browser,
          evidence = yield* Evidence;
        // Alice and Bob each link one personal account. Each enables the same declaration and gets
        // their own copy, which runs as them.
        const alice = yield* saved(yield* configure(actors.member, { enabled: true }));
        const bob = yield* saved(yield* configure(actors.admin, { enabled: true }));
        expect(alice).toMatchObject({ actor: aliceId, enabled: true });
        expect(bob).toMatchObject({ actor: bobId, enabled: true });
        expect([alice.accountRequired, bob.accountRequired]).toEqual([undefined, undefined]);
        expect(alice.id).not.toBe(bob.id);
        // Configuring again updates the member's one copy; it never adds a second.
        const again = yield* saved(yield* configure(actors.member, { enabled: true }));
        expect(again.id).toBe(alice.id);
        expect((yield* copies(actors.owner)).map((row) => [row.id, row.actor]).toSorted()).toEqual(
          [
            [alice.id, aliceId],
            [bob.id, bobId],
          ].toSorted(),
        );

        // Each copy runs with its own member's account: only Alice links mailA, only Bob mailB.
        expect((yield* runNow(actors.member)).status).toBe(200);
        yield* runsWith("succeeded", 1);
        expect(yield* ticks(actors.member)).toEqual([mailA]);
        expect((yield* runCopy(actors.admin, bob.id)).status).toBe(200);
        yield* runsWith("succeeded", 2);
        expect(yield* ticks(actors.member)).toEqual([mailA, mailB]);

        // Alice's Schedules tab shows only her own copy, with its controls and no account choice.
        yield* browser.login(actors.member);
        yield* browser.use("Open Alice's schedules", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=schedules`),
        );
        yield* browser.use("The tab says schedules run with the linked accounts", (page) =>
          page.getByText(introduction, { exact: true }).waitFor(),
        );
        yield* browser.use("Alice's copy is enabled", (page) =>
          row(page).getByText("Enabled", { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("One row with the copy's controls and no account choice", (page) =>
            Promise.all([
              row(page).count(),
              ...["Pause", "Run now", "Remove"].map((name) =>
                row(page).getByRole("button", { name, exact: true }).count(),
              ),
              page.getByRole("button", { name: "Add another", exact: true }).count(),
              page.getByRole("combobox", { name: /account/i }).count(),
            ]),
          ),
        ).toEqual([1, 1, 1, 1, 0, 0]);
        const single = yield* browser.use("Capture Alice's schedule", (page) => page.screenshot());
        yield* evidence.attach("schedule-member-copy.png", "image/png", single);

        // Bob manages the app: he may pause Alice's copy, but only Alice may make it run again.
        expect((yield* pause(actors.admin, alice.id)).status).toBe(200);
        expect((yield* pause(actors.admin, alice.id, true)).status).toBe(403);
        expect((yield* copy(actors.owner, alice.id))?.enabled).toBe(false);
        expect((yield* pause(actors.member, alice.id, true)).status).toBe(200);
        // Pausing her copy by name leaves Bob's enabled and runnable; hers no longer runs.
        expect((yield* configure(actors.member, { enabled: false })).status).toBe(200);
        expect(
          (yield* copies(actors.owner)).map((row) => [row.actor, row.enabled]).toSorted(),
        ).toEqual(
          [
            [aliceId, false],
            [bobId, true],
          ].toSorted(),
        );
        const paused = yield* runCopy(actors.member, alice.id);
        expect(paused.status, JSON.stringify(paused.body)).toBe(409);
        expect((yield* runCopy(actors.admin, bob.id)).status).toBe(200);
        yield* runsWith("succeeded", 3);
        expect(yield* ticks(actors.member)).toEqual([mailA, mailB, mailB]);

        // Alice removes her copy in the dashboard. Only it goes, with its run history.
        yield* browser.use("Reload Alice's schedules", (page) => page.reload());
        yield* browser.use("Alice's copy is paused", (page) =>
          row(page).getByRole("button", { name: "Enable", exact: true }).waitFor(),
        );
        const removed = yield* browser.use("Remove Alice's copy", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "DELETE" &&
                response.url().endsWith(`/schedules/tick/copies/${alice.id}`),
            ),
            row(page).getByRole("button", { name: "Remove", exact: true }).click(),
          ]).then(([response]) => response.status()),
        );
        expect(removed).toBe(200);
        yield* browser.use("Without a copy, Alice can enable the schedule again", (page) =>
          row(page)
            .getByRole("button", { name: "Remove", exact: true })
            .waitFor({ state: "detached" }),
        );
        yield* browser.checkpoint("Alice's copy removed");
        expect(yield* copies(actors.owner)).toMatchObject([{ id: bob.id, enabled: true }]);
        expect((yield* runs).map((run) => [run.scheduleId, run.status])).toEqual([
          [bob.id, "succeeded"],
          [bob.id, "succeeded"],
        ]);
        // The owner manages the app and may remove Bob's copy too.
        expect((yield* remove(actors.owner, bob.id)).status).toBe(200);
        expect(yield* copies(actors.owner)).toEqual([]);
      }),
    ),
  );
  it.effect(scenarios.hostedScheduleFollowsLinks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* plainTickApp;
        const { api, actors, prefix, app, path, connect } = fixture;
        const { copies, copy, runs, runsWith, ticks, configure, runNow, runCopy, saved } =
          tickSchedule(fixture);
        const browser = yield* Browser;
        const one = yield* connect(actors.member, "Mail one");
        const enabled = yield* saved(yield* configure(actors.member, { enabled: true }));
        expect(enabled.accountRequired).toBeUndefined();
        expect((yield* runNow(actors.member)).status).toBe(200);
        yield* runsWith("succeeded", 1);
        expect(yield* ticks(actors.member)).toEqual([one]);

        // Alice connects another account from the app, which replaces `one` there; `one` stays
        // saved. Her copy saved no account: its next run uses the one she links now.
        const two = yield* connect(actors.member, "Mail two");
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([two]);
        expect((yield* api.request(actors.member, "GET", `${prefix}/accounts/${one}`)).status).toBe(
          200,
        );
        expect(yield* copies(actors.member)).toMatchObject([{ id: enabled.id, enabled: true }]);
        expect((yield* copy(actors.member, enabled.id))?.accountRequired).toBeUndefined();
        expect((yield* runCopy(actors.member, enabled.id)).status).toBe(200);
        yield* runsWith("succeeded", 2);
        expect(yield* ticks(actors.member)).toEqual([one, two]);

        // With no account linked, the copy stays enabled but reports which requirement needs one.
        // It does not run.
        yield* unlinkAccount(actors.member, path, "service", two);
        expect(yield* copy(actors.member, enabled.id)).toMatchObject({
          enabled: true,
          accountRequired: "service",
        });
        const blocked = yield* runCopy(actors.member, enabled.id);
        expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
        expect((yield* body(Failure, blocked))._tag).toBe("AccountRequired");
        expect((yield* runs).map((run) => run.status)).toEqual(["succeeded", "succeeded"]);

        yield* browser.login(actors.member);
        yield* browser.use("Open the copy without a linked account", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=schedules`),
        );
        yield* browser.use("The copy needs an account", (page) =>
          row(page).getByText("Account required", { exact: true }).waitFor(),
        );
        yield* browser.use("The copy says which account to link", (page) =>
          row(page)
            .getByText(
              "Runs are skipped until you link a Schedule mail fixture account to this app. View accounts",
              { exact: true },
            )
            .waitFor(),
        );
        const accountsLink = yield* browser.use("Read the accounts link", (page) =>
          row(page).getByRole("link", { name: "View accounts", exact: true }).getAttribute("href"),
        );
        expect(accountsLink).toContain(`/apps/${app.id}`);
        expect(accountsLink).toContain("view=accounts");
        yield* browser.checkpoint("Schedule copy without a linked account");

        // Linking `one` again: the same copy runs with it.
        yield* linkAccount(actors.member, path, "service", one);
        expect((yield* copy(actors.member, enabled.id))?.accountRequired).toBeUndefined();
        expect((yield* runCopy(actors.member, enabled.id)).status).toBe(200);
        yield* runsWith("succeeded", 3);
        expect(yield* ticks(actors.member)).toEqual([one, two, one]);
      }),
    ),
  );
  it.effect(scenarios.hostedScheduleAccountRequiredSkips.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appAccountsFixture;
        const { actors, path, mailA } = fixture;
        const { copy, runs, runsWith, ticks, configure, saved } = tickSchedule(fixture);
        const enabled = yield* saved(yield* configure(actors.member, { enabled: true }));
        const read = copy(actors.member, enabled.id);
        yield* nextOccurrence;
        yield* runsWith("succeeded", 1);
        expect(yield* ticks(actors.member)).toEqual([mailA]);

        // Alice unlinks her only account. Her copy stays enabled and reports the requirement.
        yield* unlinkAccount(actors.member, path, "service", mailA);
        const before = yield* read;
        expect(before).toMatchObject({ enabled: true, accountRequired: "service" });
        if (before?.nextAt == null) return yield* Effect.die("The schedule has no next run");
        // A due occurrence is skipped: no run is recorded and nothing is written.
        yield* nextOccurrence;
        const skipped = yield* handled(read, before);
        expect(skipped).toMatchObject({ enabled: true, accountRequired: "service" });
        expect(skipped.revision, "A skipped occurrence consumes its scanned revision").not.toBe(
          before.revision,
        );
        expect((yield* runs).map((run) => run.status)).toEqual(["succeeded"]);
        expect(yield* ticks(actors.admin)).toEqual([mailA]);

        // Once she links an account again, the next occurrence runs with it.
        yield* linkAccount(actors.member, path, "service", mailA);
        expect((yield* read)?.accountRequired).toBeUndefined();
        yield* nextOccurrence;
        yield* runsWith("succeeded", 2);
        expect(yield* ticks(actors.member)).toEqual([mailA, mailA]);
        expect((yield* runs).every((run) => run.status === "succeeded")).toBe(true);
      }),
    ),
  );
  it.effect(scenarios.hostedScheduleActorLosesApp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appAccountsFixture;
        const { api, actors, path, mailA } = fixture;
        const { runs, runsWith, ticks, configure } = tickSchedule(fixture);
        const audience = (kind: "everyone" | "private") =>
          Effect.gen(function* () {
            const access = yield* body(
              Access,
              yield* api.request(actors.owner, "GET", `${path}/access`),
            );
            const changed = yield* api.request(actors.owner, "PATCH", `${path}/access`, {
              revision: access.revision,
              audience: { kind },
            });
            expect(changed.status, JSON.stringify(changed.body)).toBe(200);
          });
        // Alice enables the schedule; its first due occurrence runs as her.
        expect((yield* configure(actors.member, { enabled: true })).status).toBe(200);
        yield* nextOccurrence;
        yield* runsWith("succeeded", 1);
        expect(yield* ticks(actors.member)).toEqual([mailA]);

        // The owner makes the app private: Alice, the saved actor, can no longer use it. The
        // dispatcher refuses her next due occurrence and records why, without running the tool.
        yield* audience("private");
        yield* nextOccurrence;
        const recorded = yield* runsWith("failed", 1);
        const refused = recorded.filter((run) => run.status === "failed");
        expect(refused, JSON.stringify(recorded)).toHaveLength(1);
        expect(refused[0]?.failure).toBe("OrganizationForbidden");
        expect(recorded.filter((run) => run.status === "succeeded")).toHaveLength(1);

        // Once Alice can read the app again, its data shows only the first run's write.
        yield* audience("everyone");
        expect((yield* configure(actors.member, { enabled: false })).status).toBe(200);
        expect(yield* ticks(actors.member)).toEqual([mailA]);
        expect((yield* runs).map((run) => run.status).toSorted()).toEqual(["failed", "succeeded"]);
      }),
    ),
  );
  it.effect(scenarios.hostedScheduleConcurrentOwners.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const organization = actors.organization.id,
          prefix = `/api/organizations/${organization}`;
        const names = ["s0", "s1", "s2", "s3", "s4", "s5"];
        const source = `import { defineApp, mutation, userInterval, object, router } from "apps";
const tick = mutation({ input: object({}) }, async () => "tick");
export default defineApp({}, async () => ({ tools: router({ tick }),
  schedules: { ${names.map((name) => `${name}: userInterval({ minutes: 1 }, tick, {})`).join(", ")} } }));`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Schedule owners ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const identity = (actor: Session) =>
          api
            .request(actor, "GET", "/api/viewer")
            .pipe(
              Effect.flatMap((response) =>
                body(Schema.Struct({ userId: Schema.String }), response),
              ),
            );
        const member = (yield* identity(actors.member)).userId,
          admin = (yield* identity(actors.admin)).userId;
        const saved = (name: string) =>
          api.request(actors.owner, "GET", `${path}/schedules`).pipe(
            Effect.flatMap((response) => body(Schema.Array(Settings), response)),
            Effect.map((rows) => rows.filter((row) => row.name === name)),
          );
        const configure = (actor: Session, name: string) =>
          api
            .request(actor, "PATCH", `${path}/schedules/${name}`, { enabled: false })
            .pipe(
              Effect.tap((response) =>
                Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
              ),
            );
        for (const name of names) {
          // Two members configure the same schedule at once: each gets their own copy.
          yield* Effect.all([configure(actors.member, name), configure(actors.admin, name)], {
            concurrency: 2,
          });
          expect(
            (yield* saved(name)).map((row) => row.actor).toSorted(),
            `${name}: one copy for each member`,
          ).toEqual([member, admin].toSorted());
          // One member's concurrent requests share their one copy.
          const [first, second] = yield* Effect.all(
            [configure(actors.member, name), configure(actors.member, name)],
            { concurrency: 2 },
          );
          expect((yield* body(Settings, first)).id).toBe((yield* body(Settings, second)).id);
          expect((yield* saved(name)).length, `${name}: still one copy each`).toBe(2);
        }
      }),
    ),
  );
  // Declarations can depend on accounts. An activation checks each saved schedule against the
  // app evaluated as its own actor, so one member's evaluation never removes another's schedule.
  it.effect(scenarios.hostedScheduleReconcilePerActor.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Schedule jobs ${randomUUID().slice(0, 8)}`,
          files: jobFiles(declaresEachJob),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        const accounts: { actor: Session; id: string }[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            for (const item of accounts)
              yield* api.request(item.actor, "DELETE", `${prefix}/accounts/${item.id}`);
          }).pipe(Effect.orDie),
        );
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        /** Connect an account from the app, which links it for `actor`. */
        const connect = (actor: Session, job: string) =>
          Effect.gen(function* () {
            const connection = yield* api.request(
              actor,
              "POST",
              connectionsPath(path, "user", "service"),
              { destination: { kind: "personal" } },
            );
            expect(connection.status, JSON.stringify(connection.body)).toBe(200);
            const submitted = yield* api.request(
              actor,
              "POST",
              `${prefix}/connections/${(yield* body(Resource, connection)).id}/submit`,
              { method: "key", label: job, fields: { job } },
            );
            expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
            const account = (yield* body(Resource, submitted)).id;
            accounts.push({ actor, id: account });
            return account;
          });
        yield* connect(actors.member, "aliceJob");
        yield* connect(actors.admin, "bobJob");
        // Each member sees, and enables, the schedule their own account declares.
        for (const [actor, job] of [
          [actors.member, "aliceJob"],
          [actors.admin, "bobJob"],
        ] as const) {
          const definitions = yield* api.request(actor, "GET", `${path}/schedules/definitions`);
          expect(definitions.status, JSON.stringify(definitions.body)).toBe(200);
          expect(definitions.body).toMatchObject([{ name: job }]);
          const enabled = yield* api.request(actor, "PATCH", `${path}/schedules/${job}`, {
            enabled: true,
          });
          expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
        }
        const runs = api
          .request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`)
          .pipe(Effect.flatMap((response) => body(Runs, response)));
        // Bob's schedule has run history that a redeploy must keep.
        expect(
          (yield* api.request(actors.admin, "POST", `${path}/schedules/bobJob/run`)).status,
        ).toBe(200);
        yield* runs.pipe(
          Effect.flatMap((rows) =>
            rows.some((row) => row.name === "bobJob" && row.status === "succeeded")
              ? Effect.void
              : Effect.fail(new Error(`bobJob has not run: ${JSON.stringify(rows)}`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
        );
        const saved = api.request(actors.owner, "GET", `${path}/schedules`).pipe(
          Effect.flatMap((response) => body(Schema.Array(Settings), response)),
          Effect.map((rows) => rows.map((row) => row.name).toSorted()),
        );
        const redeploy = (files: ReturnType<typeof jobFiles>) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${path}/deploy`, { files });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
          });

        // Redeploying the same declarations keeps both members' schedules and Bob's history.
        yield* redeploy(jobFiles(`${declaresEachJob} /* redeployed */`));
        expect(yield* saved, "Each schedule is checked with its own actor's accounts").toEqual([
          "aliceJob",
          "bobJob",
        ]);
        expect((yield* runs).map((row) => [row.name, row.status])).toEqual([
          ["bobJob", "succeeded"],
        ]);

        // An evaluation that fails for Bob's accounts proves nothing about his schedule.
        yield* redeploy(jobFiles(failsFor("bobJob")));
        expect(yield* saved).toEqual(["aliceJob", "bobJob"]);

        // Once Bob's own evaluation no longer declares it, his schedule and history go.
        yield* redeploy(jobFiles(declaresOnly("aliceJob")));
        expect(yield* saved).toEqual(["aliceJob"]);
        expect(yield* runs).toEqual([]);
      }),
    ),
  );
});
