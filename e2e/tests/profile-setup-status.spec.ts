/** Normal background setup is silent; provider failures remain actionable. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { webhookRegistrationFixture } from "../support/webhook-registration.ts";
import { scenarios } from "../test-plan.ts";
layer(HostedLive, { excludeTestServices: true })("Account setup status", (it) => {
  it.effect(scenarios.profileSetupStatus.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          provider = yield* webhookRegistrationFixture;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Setup status ${randomUUID().slice(0, 6)}`,
          files: [
            {
              path: "index.ts",
              content: `import {defineApp,defineProvider,secrets,query,object,string} from "apps";
const service=defineProvider({name:"Setup fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const incoming={account:"service",config:object({}),state:object({}),register:async ctx=>{const response=await ctx.fetch(${JSON.stringify(provider.url)},{method:"POST"});if(!response.ok)throw new Error("Registration failed");return {};},unregister:async()=>{},handle:async()=>new Response(null,{status:204})};
export default defineApp({accounts:{service}},{queries:{ready:query({input:object({})},async ctx=>ctx.accounts.service.id)},webhooks:{incoming}});`,
            },
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        const profile = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/profiles`, {
            accounts: {},
            idempotencyKey: "setup",
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* provider.recover;
            yield* provider.fail;
            const deadline = (yield* Clock.currentTimeMillis) + 15000;
            for (;;) {
              const removed = yield* api.request(
                actors.owner,
                "DELETE",
                `${path}/profiles/${profile.id}`,
              );
              if (
                removed.status !== 200 ||
                (yield* body(Schema.Struct({ status: Schema.String }), removed)).status ===
                  "removed"
              )
                break;
              if ((yield* Clock.currentTimeMillis) > deadline) break;
              yield* Effect.sleep("100 millis");
            }
            yield* api.request(actors.owner, "DELETE", path);
          }).pipe(Effect.orDie),
        );
        // Exercise a new account selection after the first setup attempt failed.
        // It must not inherit that attempt's provider retry delay.
        yield* Effect.gen(function* () {
          for (;;) {
            const current = yield* body(
              Schema.Struct({ status: Schema.String }),
              yield* api.request(actors.owner, "GET", `${path}/profiles/${profile.id}`),
            );
            if (current.status === "needs-setup") break;
            yield* Effect.sleep("50 millis");
          }
        }).pipe(Effect.timeout("10 seconds"));
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/connections`, {
            profile: profile.id,
            requirement: "service",
          }),
        );
        expect(
          (yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            { method: "key", label: "My account", fields: { token: "synthetic" } },
          )).status,
        ).toBe(200);
        yield* browser.login(actors.owner);
        yield* browser.use("Open tools while registration is pending", (page) =>
          page.goto(
            `/org/${actors.organization.slug}/apps/${app.id}?view=tools&profile=${profile.id}`,
          ),
        );
        yield* provider.requested.pipe(Effect.timeout("10 seconds"));
        yield* browser.use("Tools remain usable during setup", (page) =>
          page.getByRole("button", { name: "queries.ready", exact: true }).waitFor(),
        );
        const pending = yield* body(
          Schema.Struct({ status: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/profiles/${profile.id}`),
        );
        expect(pending.status).toBe("pending");
        expect(
          yield* browser.use("No setup progress banner appears", (page) =>
            page.getByText("Setting up accounts…", { exact: true }).count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("No retry control appears before a failure", (page) =>
            page.getByRole("button", { name: "Retry setup", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Pending provider setup stays invisible");
        yield* provider.fail;
        yield* browser.use("The provider failure is shown", (page) =>
          page
            .getByRole("alert")
            .filter({ hasText: "Background setup failed. Retry setup." })
            .waitFor(),
        );
        yield* browser.use("Retry is available after failure", (page) =>
          page.getByRole("button", { name: "Retry setup", exact: true }).waitFor(),
        );
        yield* provider.recover;
        yield* browser.use("Retry after provider recovery", (page) =>
          page.getByRole("button", { name: "Retry setup", exact: true }).click(),
        );
        yield* browser.use("The error disappears after successful setup", (page) =>
          page
            .getByRole("alert")
            .filter({ hasText: "Background setup failed. Retry setup." })
            .waitFor({ state: "hidden" }),
        );
        yield* browser.use("Successful setup has no status controls", (page) =>
          page
            .getByRole("button", { name: "Retry setup", exact: true })
            .waitFor({ state: "hidden" }),
        );
        expect(
          (yield* body(
            Schema.Struct({ status: Schema.String }),
            yield* api.request(actors.owner, "GET", `${path}/profiles/${profile.id}`),
          )).status,
        ).toBe("ready");
        yield* browser.checkpoint("Recovered setup is silent again");
      }),
    ),
  );
});
