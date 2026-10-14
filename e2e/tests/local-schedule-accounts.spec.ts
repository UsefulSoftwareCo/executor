/**
 * Local has one member, so each declared schedule has at most one copy. It runs with the accounts
 * linked to the app: the one of each plain requirement, which linking another replaces.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { TestLive, withCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import {
  callLocalQuery,
  linkLocal,
  localAgent,
  localLinks,
  pairLocalBrowser,
  unlinkLocal,
} from "../support/local-links.ts";
import {
  declaresEachJob,
  declaresOnly,
  failsFor,
  jobFiles,
  plainTickFiles,
} from "../support/schedule-accounts.ts";

const Deployed = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Record(Schema.String, Schema.Struct({ provider: Schema.String })),
    }),
  }),
});
const Settings = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  actor: Schema.String,
  enabled: Schema.Boolean,
  accountRequired: Schema.optional(Schema.String),
});
const Runs = Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String }));

/** The local agent API, with deploy, account and schedule helpers for one app. */
const localApp = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
  Effect.gen(function* () {
    const { api, agent, target } = yield* localAgent;
    const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
      owner: "local",
      name: `${name} ${randomUUID().slice(0, 8)}`,
      files,
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const { app } = yield* body(Deployed, deployed);
    const path = `/v1/apps/${app.id}`;
    const accounts: string[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* api.request(agent, "DELETE", path);
        for (const account of accounts)
          yield* api.request(agent, "DELETE", `/v1/accounts/${account}`);
      }).pipe(Effect.orDie),
    );
    /** Connect an account from the app; it replaces the account linked before. */
    const account = (label: string, fields: Record<string, string>) =>
      Effect.gen(function* () {
        const { id } = yield* connectLocalAccount(agent, {
          app: app.id,
          requirement: "service",
          method: "key",
          label,
          fields,
        });
        accounts.push(id);
        expect(yield* localLinks(agent, app.id)).toEqual([id]);
        return id;
      });
    const settings = api
      .request(agent, "GET", `${path}/schedules`)
      .pipe(Effect.flatMap((response) => body(Schema.Array(Settings), response)));
    const configure = (schedule: string, enabled: boolean) =>
      api.request(agent, "PATCH", `${path}/schedules/${schedule}`, { actor: "local", enabled });
    const runs = api
      .request(agent, "GET", `/v1/scheduled-runs?app=${app.id}`)
      .pipe(Effect.flatMap((response) => body(Runs, response)));
    /** Wait until `count` runs of the schedule have succeeded. */
    const succeeded = (schedule: string, count: number) =>
      runs.pipe(
        Effect.flatMap((rows) =>
          rows.filter((row) => row.name === schedule && row.status === "succeeded").length >= count
            ? Effect.void
            : Effect.fail(
                new Error(`${schedule} has not run ${count} times: ${JSON.stringify(rows)}`),
              ),
        ),
        Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
      );
    const redeploy = (next: ReadonlyArray<{ path: string; content: string }>) =>
      Effect.gen(function* () {
        const response = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner: "local",
          app: app.id,
          files: next,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      });
    return {
      api,
      agent,
      target,
      app,
      path,
      account,
      settings,
      configure,
      runs,
      succeeded,
      redeploy,
    };
  });

/** The schedule's row on the Schedules tab. */
const row = (page: Page, name: string) => page.locator(`[aria-label="${name}"]`);
const badge = (page: Page, name: string, state: string) =>
  row(page, name).getByText(state, { exact: true }).waitFor();

layer(TestLive, { excludeTestServices: true })("Local schedule accounts", (it) => {
  // Declarations can depend on accounts. The local copy is checked against the app evaluated with
  // the account linked to it now.
  it.effect(scenarios.localScheduleReconcileChoices.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { agent, app, account, settings, configure, runs, succeeded, redeploy, path } =
          yield* localApp("Schedule jobs", jobFiles(declaresEachJob));
        const alpha = yield* account("Alpha", { job: "alphaJob" });
        const enabled = yield* configure("alphaJob", true);
        expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
        const copy = yield* body(Settings, enabled);
        expect(copy).toMatchObject({ name: "alphaJob", actor: "local", enabled: true });
        // The account linked to the app declares only its own job.
        const other = yield* configure("betaJob", true);
        expect(other.status, JSON.stringify(other.body)).toBe(404);
        // The alpha schedule has run history that a redeploy must keep.
        const started = yield* agent.send(
          "POST",
          `${path}/schedules/alphaJob/copies/${copy.id}/run`,
          {},
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        yield* succeeded("alphaJob", 1);
        const saved = settings.pipe(Effect.map((rows) => rows.map((row) => row.name).toSorted()));

        yield* redeploy(jobFiles(`${declaresEachJob} /* redeployed */`));
        expect(yield* saved, "The schedule is checked with the linked account").toEqual([
          "alphaJob",
        ]);
        expect((yield* runs).map((row) => [row.name, row.status])).toEqual([
          ["alphaJob", "succeeded"],
        ]);

        // Connecting beta replaces alpha. An evaluation that fails proves nothing about the copy.
        const beta = yield* account("Beta", { job: "betaJob" });
        expect((yield* agent.send("GET", `/v1/accounts/${alpha}`)).status).toBe(200);
        yield* redeploy(jobFiles(failsFor("betaJob")));
        expect(yield* saved).toEqual(["alphaJob"]);

        // Once the linked account's evaluation no longer declares it, it and its history go.
        yield* redeploy(jobFiles(declaresEachJob));
        expect(yield* saved).toEqual([]);
        expect(yield* runs).toEqual([]);

        // With no account linked nothing can be evaluated, so the copy stays and waits for one.
        const betaCopy = yield* configure("betaJob", true);
        expect(betaCopy.status, JSON.stringify(betaCopy.body)).toBe(200);
        yield* unlinkLocal(agent, app.id, "service", beta);
        yield* redeploy(jobFiles(declaresOnly("alphaJob")));
        expect(yield* settings).toMatchObject([
          { name: "betaJob", enabled: true, accountRequired: "service" },
        ]);
        // Linking alpha again lets the next activation remove what alpha does not declare.
        yield* linkLocal(agent, app.id, "service", alpha);
        yield* redeploy(jobFiles(declaresOnly("alphaJob")));
        expect(yield* saved).toEqual([]);
      }),
    ),
  );

  it.effect(scenarios.localScheduleTwoChoices.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const { agent, target, app, account, settings, succeeded } = yield* localApp(
          "Schedule tab",
          plainTickFiles,
        );
        const one = yield* account("Mail one", { token: `synthetic-${randomUUID()}` });
        yield* pairLocalBrowser(agent);
        yield* browser.use("Open the Schedules tab", (page) =>
          page.goto(`${target.metadata.origin}/apps/${app.id}?view=schedules`),
        );
        yield* browser.use("The tab says schedules run with the linked accounts", (page) =>
          page
            .getByText(
              "Your schedules run as you, with the accounts you linked to this app. Change them in the app’s Accounts tab.",
              { exact: true },
            )
            .waitFor(),
        );
        yield* browser.use("The declaration starts paused", (page) =>
          badge(page, "tick", "Paused"),
        );
        const click = (step: string, name: string) =>
          browser.use(step, (page) =>
            row(page, "tick").getByRole("button", { name, exact: true }).click(),
          );
        yield* click("Enable the schedule", "Enable");
        yield* browser.use("The schedule is enabled", (page) => badge(page, "tick", "Enabled"));
        expect(
          yield* browser.use("The local copy has its controls and no copy picker", (page) =>
            Promise.all([
              ...["Pause", "Run now", "Remove"].map((name) =>
                row(page, "tick").getByRole("button", { name, exact: true }).count(),
              ),
              page.getByRole("button", { name: "Add another", exact: true }).count(),
            ]),
          ),
        ).toEqual([1, 1, 1, 0]);
        const [copy] = yield* settings;
        expect(copy).toMatchObject({ name: "tick", actor: "local", enabled: true });
        expect(copy?.accountRequired).toBeUndefined();
        yield* browser.checkpoint("The local copy is enabled");

        yield* click("Run the schedule now", "Run now");
        yield* succeeded("tick", 1);
        expect(yield* callLocalQuery(agent, app.id, "ticks")).toEqual([one]);

        // Connecting another account replaces the one the schedule runs with.
        const two = yield* account("Mail two", { token: `synthetic-${randomUUID()}` });
        yield* browser.use("The finished run leaves the schedule enabled", (page) =>
          badge(page, "tick", "Enabled"),
        );
        yield* click("Run the schedule again", "Run now");
        yield* succeeded("tick", 2);
        expect(yield* callLocalQuery(agent, app.id, "ticks")).toEqual([one, two]);

        yield* click("Pause the schedule", "Pause");
        yield* browser.use("The schedule is paused", (page) => badge(page, "tick", "Paused"));
        expect((yield* settings).map((row) => row.enabled)).toEqual([false]);
        yield* click("Enable the schedule again", "Enable");
        yield* browser.use("The schedule is enabled again", (page) =>
          badge(page, "tick", "Enabled"),
        );

        // With nothing linked, runs are skipped until an account is linked again.
        yield* unlinkLocal(agent, app.id, "service", two);
        expect(yield* settings).toMatchObject([{ enabled: true, accountRequired: "service" }]);
        yield* browser.use("Reload the Schedules tab", (page) => page.reload());
        yield* browser.use("The schedule needs an account", (page) =>
          badge(page, "tick", "Account required"),
        );
        yield* browser.use("The schedule says which account to link", (page) =>
          row(page, "tick")
            .getByText(
              "Runs are skipped until you link a Schedule mail fixture account to this app. View accounts",
              { exact: true },
            )
            .waitFor(),
        );
        yield* browser.checkpoint("A schedule without a linked account");
        const accountsLink = yield* browser.use("Read the accounts link", (page) =>
          row(page, "tick")
            .getByRole("link", { name: "View accounts", exact: true })
            .getAttribute("href"),
        );
        expect(accountsLink).toContain(`/apps/${app.id}`);
        expect(accountsLink).toContain("view=accounts");

        yield* linkLocal(agent, app.id, "service", one);
        yield* browser.use("Reload after linking an account", (page) => page.reload());
        yield* browser.use("The schedule is enabled once an account is linked", (page) =>
          badge(page, "tick", "Enabled"),
        );
        yield* click("Remove the schedule", "Remove");
        yield* browser.use("The removed schedule is paused with nothing saved", (page) =>
          badge(page, "tick", "Paused"),
        );
        expect(yield* settings).toEqual([]);
        expect(yield* callLocalQuery(agent, app.id, "ticks")).toEqual([one, two]);
      }),
    ),
  );
});
