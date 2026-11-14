import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { holdQuery, refreshVisiblePage } from "../support/query-transition.ts";
import {
  connectionsPath,
  linkedAccountIds,
  unlinkAccount,
  unlinkAccountResponse,
} from "../support/app-accounts.ts";
import {
  removeAppWhenStopped,
  settleWebhookSources,
  settleWebhookSubscriptions,
  sourcesAre,
  webhookSubscriptions,
} from "../support/webhook-sources.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

// Each fixture's `service` requirement is plain, so the caller links one account and a new link
// replaces it.
const provider = `const service=defineProvider({name:"Resources fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});`;
const identity = `tools: router({
  identity:query({input:object({})},async ctx=>ctx.user.accounts.service.id),
})`;
const workflowsFixture = `import {defineApp,defineProvider,secrets,query,workflow,object,string, router} from "apps";
${provider}
const capture=workflow({input:object({body:string()})},async(ctx,input)=>ctx.step.do("capture",async step=>({account:step.user.accounts.service.id,body:input.body})));
const hold=workflow({input:object({})},async ctx=>{await ctx.step.sleep("hold","5 minutes");return "done";});
export default defineApp({user: { accounts:{service} }},{${identity},workflows:{capture,hold}});`;
const webhooksFixture = `import {defineApp,defineProvider,secrets,query,object,string, router} from "apps";
${provider}
const incoming={account:{ user: "service" },config:object({channel:string()}),state:object({}),register:async()=>({}),unregister:async()=>{},handle:async()=>new Response(null,{status:204})};
export default defineApp({user: { accounts:{service} }},{${identity},webhooks:{incoming}});`;
const Run = Schema.Struct({
  id: Schema.String,
  workflow: Schema.String,
  status: Schema.String,
  output: Schema.optional(Schema.Unknown),
});

/**
 * Deploy `fixture` as a new app and connect accounts to its `service` requirement. Cleanup unlinks
 * them, removes the app once its webhooks have stopped and deletes the accounts. Workflows and
 * webhook sources are separate cases, each with its own app. On a deployed Cloud stage, each
 * workflow run waits seconds for its instance to start, and each webhook source change waits for
 * background registration; together they took up to 56 of the 60 seconds.
 */
const linkedApp = (fixture: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const app = yield* body(
      App,
      yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: `Resources ${randomUUID().slice(0, 8)}`,
        files: [{ path: "index.ts", content: fixture }, appsManifest],
      }),
    );
    const path = `${prefix}/apps/${app.id}`;
    const created: string[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const account of created)
          yield* unlinkAccountResponse(actors.owner, path, "service", account);
        yield* removeAppWhenStopped(actors.owner, path);
        for (const account of created)
          yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
      }).pipe(Effect.orDie),
    );
    const connect = (label: string) =>
      Effect.gen(function* () {
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {}),
        );
        const account = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            {
              method: "key",
              label,
              fields: { token: "synthetic-resource-token" },
            },
          ),
        );
        created.push(account.id);
        return account.id;
      });
    const accountStatus = (account: string) =>
      Effect.map(
        api.request(actors.owner, "GET", `${prefix}/accounts/${account}`),
        (response) => response.status,
      );
    return { app, path, connect, accountStatus };
  });

layer(HostedLive, { excludeTestServices: true })("Grouped resources", (it) => {
  it.effect(scenarios.groupedResources.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const { app, path, connect, accountStatus } = yield* linkedApp(workflowsFixture);
        const personal = yield* connect("Personal");
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([personal]);
        const waitForRun = (id: string) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + 30000;
            for (;;) {
              const run = yield* body(
                Run,
                yield* api.request(actors.owner, "GET", `${path}/workflow-runs/${id}`),
              );
              if (run.status !== "queued" && run.status !== "running") return run;
              expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
              yield* Effect.sleep("100 millis");
            }
          });
        const startCapture = (input: string, extra: Record<string, unknown> = {}) =>
          api.request(actors.owner, "POST", `${path}/workflow-runs`, {
            workflow: "capture",
            input: { body: input },
            key: randomUUID(),
            ...extra,
          });
        const workflows = `/org/${actors.organization.slug}/apps/${app.id}?view=workflows`;
        yield* browser.login(actors.owner);
        yield* browser.use("Open workflows", (page) => page.goto(workflows));
        yield* browser.use("Open the capture workflow", (page) =>
          page.getByRole("button", { name: "capture", exact: true }).click(),
        );
        yield* browser.use("Edit the workflow input", (page) =>
          page
            .getByRole("textbox", { name: "capture input", exact: true })
            .fill('{"body":"kept draft"}'),
        );
        const held = yield* holdQuery(
          [actors.organization.id, actors.organization.slug].map(
            (org) => `/api/organizations/${org}/apps/${app.id}/workflows`,
          ),
          "undeclared",
        );
        yield* refreshVisiblePage;
        yield* held.requested;
        yield* held.release;
        yield* browser.use("The workflow discovery failure is visible", (page) =>
          page.getByText("Unable to complete this request", { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Workflow draft survives a failed refresh", (page) =>
            page.getByRole("textbox", { name: "capture input", exact: true }).inputValue(),
          ),
        ).toBe('{"body":"kept draft"}');
        yield* browser.use("Retry the workflow discovery", (page) =>
          page.getByRole("button", { name: "Retry", exact: true }).click(),
        );
        yield* browser.use("Start the capture workflow", (page) =>
          page.getByRole("button", { name: "Start workflow", exact: true }).click(),
        );
        yield* browser.use("Personal completion appears", (page) =>
          page.getByRole("button", { name: "View capture run: Complete", exact: true }).waitFor(),
        );
        yield* browser.use("Inspect Personal result", (page) =>
          page.getByRole("button", { name: "View capture run: Complete", exact: true }).click(),
        );
        expect(
          yield* browser.use("Run used the linked Personal account", (page) =>
            page.getByRole("region", { name: "Workflow run details", exact: true }).textContent(),
          ),
        ).toContain(personal);
        yield* browser.use("Open the waiting hold workflow", (page) =>
          page.getByRole("button", { name: "hold", exact: true }).click(),
        );
        yield* browser.use("Start the hold workflow", (page) =>
          page.getByRole("button", { name: "Start workflow", exact: true }).click(),
        );
        yield* browser.use("Open hold run controls", (page) =>
          page.getByRole("button", { name: /^View hold run:/ }).click(),
        );
        yield* browser.use("Terminate the hold run", (page) =>
          page.getByRole("button", { name: "Terminate run", exact: true }).click(),
        );
        yield* browser.use("The hold run is terminated", (page) =>
          page.getByRole("button", { name: "View hold run: Terminated", exact: true }).waitFor(),
        );
        yield* browser.checkpoint(
          "Workflow starts, results and termination with the linked account",
        );
        // Connecting Work replaces Personal in the app, and Personal stays saved.
        const work = yield* connect("Work");
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([work]);
        expect(yield* accountStatus(personal)).toBe(200);
        // Starts run with the linked account. An `accounts` field chooses nothing: the start still
        // runs as Work, never as the unlinked Personal account.
        const workCapture = yield* startCapture("work", { accounts: { service: [personal] } });
        expect(workCapture.status, JSON.stringify(workCapture.body)).toBe(200);
        expect(yield* waitForRun((yield* body(Run, workCapture)).id)).toMatchObject({
          status: "complete",
          output: { account: work, body: "work" },
        });
        // Runs started with the replaced Personal account stay in the history.
        yield* browser.use("Open workflow history after replacing", (page) => page.goto(workflows));
        yield* browser.use("Terminated history survives replacing", (page) =>
          page.getByRole("button", { name: "View hold run: Terminated", exact: true }).waitFor(),
        );
        yield* browser.use("Completed history survives replacing", (page) =>
          page
            .getByRole("button", { name: "View capture run: Complete", exact: true })
            .first()
            .waitFor(),
        );
        yield* browser.checkpoint("Replaced account keeps resource history");
        const runs = Effect.gen(function* () {
          const listed = yield* api.request(actors.owner, "GET", `${path}/workflow-runs`);
          expect(listed.status, JSON.stringify(listed.body)).toBe(200);
          return (yield* body(Schema.Struct({ items: Schema.Array(Run) }), listed)).items;
        });
        const history = (yield* runs).map((run) => [run.workflow, run.status]).sort();
        expect(history).toEqual(
          [
            ["capture", "complete"],
            ["capture", "complete"],
            ["hold", "terminated"],
          ].sort(),
        );
        // Unlinking keeps the account and its history; starts then need an account linked again.
        yield* unlinkAccount(actors.owner, path, "service", work);
        expect(yield* accountStatus(work)).toBe(200);
        const unlinkedStart = yield* startCapture("unlinked");
        expect(unlinkedStart.status, JSON.stringify(unlinkedStart.body)).toBe(409);
        expect(unlinkedStart.body).toMatchObject({ _tag: "AccountRequired", slot: "service" });
        expect((yield* runs).map((run) => [run.workflow, run.status]).sort()).toEqual(history);
        // The unlink happened through the API, so the open page reloads to read the links again.
        yield* browser.use("Open workflows after unlinking", (page) => page.goto(workflows));
        yield* browser.use("Workflows ask for an account to be linked", (page) =>
          page
            .getByText("Link an account in Accounts to start using this app.", { exact: true })
            .waitFor(),
        );
        yield* browser.checkpoint("Unlinked app asks for an account");
      }),
    ),
  );

  it.effect(scenarios.groupedWebhookSources.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser;
        const { app, path, connect, accountStatus } = yield* linkedApp(webhooksFixture);
        const personal = yield* connect("Personal");
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([personal]);
        const settle = (expected: Parameters<typeof sourcesAre>[0]) =>
          settleWebhookSources(actors.owner, path, sourcesAre(expected));
        const subscriptions = webhookSubscriptions(actors.owner, path);
        // The linked account becomes the app's webhook source; registration waits for configuration.
        const needsConfiguration = { status: "needs-setup", failure: "configuration" };
        const ready = { status: "ready", failure: null };
        yield* settle({ [personal]: needsConfiguration });
        yield* browser.login(actors.owner);
        yield* browser.use("Open webhooks", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=webhooks`),
        );
        const configure = (label: string, config: string) =>
          Effect.gen(function* () {
            const editor = `Webhook configuration for ${label}`;
            yield* browser.use(`A missing ${label} configuration opens its editor`, (page) =>
              page.getByRole("textbox", { name: editor, exact: true }).waitFor(),
            );
            yield* browser.use(`Change ${label} webhook config`, (page) =>
              page.getByRole("textbox", { name: editor, exact: true }).fill(config),
            );
            yield* browser.use(`Save ${label} config`, (page) =>
              Promise.all([
                page.waitForResponse(
                  (response) =>
                    response.url().includes("/webhook-sources/") &&
                    response.url().endsWith("/config") &&
                    response.request().method() === "PUT" &&
                    response.status() === 200,
                ),
                page
                  .getByRole("textbox", { name: editor, exact: true })
                  .locator("xpath=ancestor::form")
                  .getByRole("button", { name: "Save webhook configuration", exact: true })
                  .click(),
              ]),
            );
          });
        yield* configure("Personal", '{"incoming":{"channel":"updates"}}');
        yield* settle({ [personal]: ready });
        expect(
          (yield* subscriptions)
            .filter((hook) => hook.status === "active")
            .map((hook) => [hook.name, hook.sourceAccount]),
        ).toEqual([["incoming", personal]]);
        yield* browser.checkpoint("The linked account configures its own webhook");
        // Connecting Work replaces Personal in the app. Personal stays saved; its webhook source
        // stops and Work's waits for configuration.
        const work = yield* connect("Work");
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([work]);
        expect(yield* accountStatus(personal)).toBe(200);
        yield* settle({ [work]: needsConfiguration });
        const replaced = yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.every((hook) => hook.sourceAccount !== personal || hook.status === "stopped"),
        );
        expect(replaced.filter((hook) => hook.status === "active")).toEqual([]);
        yield* browser.use("Reload webhooks for the new link", (page) => page.reload());
        yield* configure("Work", '{"incoming":{"channel":"changed"}}');
        yield* settle({ [work]: ready });
        const active = (yield* subscriptions).filter((hook) => hook.status === "active");
        expect(active.map((hook) => [hook.name, hook.sourceAccount])).toEqual([["incoming", work]]);
        expect(
          yield* browser.use("The replaced Personal source is no longer listed", (page) =>
            page
              .locator("summary")
              .filter({ hasText: "Webhook configuration for Personal" })
              .count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("The replacing account configures its own webhook");
        // Unlinking keeps the account but stops its webhook source.
        yield* unlinkAccount(actors.owner, path, "service", work);
        yield* settle({});
        const after = yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.every((hook) => hook.status === "stopped"),
        );
        expect([...new Set(after.map((hook) => hook.sourceAccount))].sort()).toEqual(
          [personal, work].sort(),
        );
        expect(yield* accountStatus(work)).toBe(200);
      }),
    ),
  );
});
