import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { holdQuery, refreshVisiblePage } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

const fixture = `import {defineApp,defineProvider,secrets,query,workflow,object,string} from "apps";
const service=defineProvider({name:"Resources fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const capture=workflow({input:object({body:string()})},async(ctx,input)=>ctx.step.do("capture",async step=>({account:step.accounts.service.id,body:input.body})));
const hold=workflow({input:object({})},async ctx=>{await ctx.step.sleep("hold","5 minutes");return "done";});
const incoming={account:"service",config:object({channel:string()}),state:object({}),register:async()=>({}),unregister:async()=>{},handle:async()=>new Response(null,{status:204})};
export default defineApp({accounts:{service}},{queries:{identity:query({input:object({})},async ctx=>ctx.accounts.service.id)},workflows:{capture,hold},webhooks:{incoming}});`;
const Profile = Schema.Struct({
  id: Schema.String,
  revision: Schema.Number,
  status: Schema.String,
  enabled: Schema.Boolean,
});

layer(HostedLive, { excludeTestServices: true })("Grouped resources", (it) => {
  it.effect(scenarios.groupedResources.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Resources ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: fixture }],
          }),
        );
        const path = `${prefix}/apps/${app.id}`;
        const created: { account: string; profile: string }[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of created)
              yield* api.request(actors.owner, "DELETE", `${path}/profiles/${item.profile}`);
            yield* api.request(actors.owner, "DELETE", path);
            for (const item of created)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${item.account}`);
          }).pipe(Effect.orDie),
        );
        for (const label of ["Personal", "Work"]) {
          const profile = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${path}/profiles`, {
              name: label,
              accounts: {},
              webhookConfig: { incoming: { channel: "updates" } },
              idempotencyKey: randomUUID(),
            }),
          );
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${path}/connections`, {
              profile: profile.id,
              requirement: "service",
            }),
          );
          const account = yield* body(
            Resource,
            yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              { method: "key", label, fields: { token: "synthetic-resource-token" } },
            ),
          );
          created.push({ profile: profile.id, account: account.id });
          const deadline = (yield* Clock.currentTimeMillis) + 30000;
          for (;;) {
            const setup = yield* body(
              Profile,
              yield* api.request(actors.owner, "POST", `${path}/profiles/${profile.id}/reconcile`),
            );
            if (setup.status === "ready") break;
            expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
            expect(setup.status).not.toBe("failed");
            yield* Effect.sleep("100 millis");
          }
        }
        const [personal, work] = created;
        if (!personal || !work) return yield* Effect.die(new Error("Missing fixture accounts"));
        yield* browser.login(actors.owner);
        const choose = (label: string) =>
          Effect.gen(function* () {
            yield* browser.use(`Choose ${label}`, (page) =>
              page.getByRole("button", { name: "Choose profile", exact: true }).click(),
            );
            yield* browser.use(`Choose ${label}`, (page) =>
              page.getByRole("menuitemradio", { name: label, exact: true }).click(),
            );
          });
        yield* browser.use("Open selected workflows", (page) =>
          page.goto(
            `/org/${actors.organization.slug}/apps/${app.id}?view=workflows&profile=${personal.profile}`,
          ),
        );
        yield* browser.use("Open Personal workflow", (page) =>
          page.getByRole("button", { name: "capture", exact: true }).click(),
        );
        yield* browser.use("Edit the selected workflow input", (page) =>
          page
            .getByRole("textbox", { name: "capture input", exact: true })
            .fill('{"body":"kept draft"}'),
        );
        const held = yield* holdQuery(
          [actors.organization.id, actors.organization.slug].map(
            (org) => `/api/organizations/${org}/apps/${app.id}/workflows`,
          ),
          "fail",
          { query: { profile: personal.profile } },
        );
        yield* refreshVisiblePage;
        yield* held.requested;
        yield* held.release;
        yield* browser.use("The selected workflow failure is visible", (page) =>
          page.getByText("Unable to complete this request", { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Workflow draft survives a failed refresh", (page) =>
            page.getByRole("textbox", { name: "capture input", exact: true }).inputValue(),
          ),
        ).toBe('{"body":"kept draft"}');
        yield* browser.use("Retry the selected workflow discovery", (page) =>
          page.getByRole("button", { name: "Retry", exact: true }).click(),
        );
        yield* browser.use("Start Personal workflow", (page) =>
          page.getByRole("button", { name: "Start workflow", exact: true }).click(),
        );
        yield* browser.use("Personal completion appears", (page) =>
          page.getByRole("button", { name: "View capture run: Complete", exact: true }).waitFor(),
        );
        yield* browser.use("Inspect Personal result", (page) =>
          page.getByRole("button", { name: "View capture run: Complete", exact: true }).click(),
        );
        expect(
          yield* browser.use("Run used Personal", (page) =>
            page.getByRole("region", { name: "Workflow run details", exact: true }).textContent(),
          ),
        ).toContain(personal.account);
        yield* choose("Work");
        yield* browser.use("Work workflows are ready", (page) =>
          page.getByRole("button", { name: "capture", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Work does not inherit Personal history", (page) =>
            page.getByRole("button", { name: /^View capture run:/ }).count(),
          ),
        ).toBe(0);
        yield* browser.use("Open waiting Work workflow", (page) =>
          page.getByRole("button", { name: "hold", exact: true }).click(),
        );
        yield* browser.use("Start Work workflow", (page) =>
          page.getByRole("button", { name: "Start workflow", exact: true }).click(),
        );
        yield* browser.use("Open Work run controls", (page) =>
          page.getByRole("button", { name: /^View hold run:/ }).click(),
        );
        yield* browser.use("Terminate Work", (page) =>
          page.getByRole("button", { name: "Terminate run", exact: true }).click(),
        );
        yield* browser.use("Work is terminated", (page) =>
          page.getByRole("button", { name: "View hold run: Terminated", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("Independent workflow starts, results and termination");
        yield* browser.use("Open selected webhooks", (page) =>
          page
            .getByRole("navigation", { name: "App navigation" })
            .getByRole("link", { name: "Webhooks", exact: true })
            .click(),
        );
        for (const label of ["Personal", "Work"]) {
          yield* choose(label);
          yield* browser.use(`${label} webhook is active`, (page) =>
            page.getByText("active", { exact: true }).waitFor(),
          );
        }
        yield* browser.use("Open Work configuration", (page) =>
          page.locator("summary").filter({ hasText: "Webhook configuration" }).click(),
        );
        yield* browser.use("Change Work webhook config", (page) =>
          page
            .getByRole("textbox", { name: "Webhook configuration", exact: true })
            .fill('{"incoming":{"channel":"changed"}}'),
        );
        yield* browser.use("Save Work config", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.url().includes(`/profiles/${work.profile}`) &&
                response.request().method() === "PATCH" &&
                response.status() === 200,
            ),
            page.getByRole("button", { name: "Save webhook configuration", exact: true }).click(),
          ]),
        );
        const personalHooks = yield* api.request(
          actors.owner,
          "GET",
          `${path}/webhooks?profile=${personal.profile}`,
        );
        expect(personalHooks.status).toBe(200);
        const workSetup = yield* body(
          Profile,
          yield* api.request(actors.owner, "GET", `${path}/profiles/${work.profile}`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/profiles/${work.profile}/enabled`, {
            expectedRevision: workSetup.revision,
            enabled: false,
          })).status,
        ).toBe(200);
        yield* browser.use("Reload disabled webhook history", (page) => page.reload());
        yield* Effect.gen(function* () {
          yield* browser.use("Disabled Work stays selected", (page) =>
            page.getByRole("button", { name: "Choose profile", exact: true }).click(),
          );
          expect(
            yield* browser.use("Disabled Work stays selected", (page) =>
              page
                .getByRole("menuitemradio", { name: "Work Disabled", exact: true })
                .getAttribute("aria-checked"),
            ),
          ).toBe("true");
          yield* browser.use("Disabled Work stays selected", (page) =>
            page.getByRole("menuitemradio", { name: "Work Disabled", exact: true }).press("Escape"),
          );
        });
        yield* browser.use("Open disabled workflow history", (page) =>
          page
            .getByRole("navigation", { name: "App navigation" })
            .getByRole("link", { name: "Workflows", exact: true })
            .click(),
        );
        yield* browser.use("Terminated Work history survives disable", (page) =>
          page.getByRole("button", { name: "View hold run: Terminated", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Disabled Work cannot start workflows", (page) =>
            page.getByRole("button", { name: "Start workflow", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Disabled account keeps resource history");
      }),
    ),
  );
});
