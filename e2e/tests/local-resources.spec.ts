import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
const ProviderApp = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
layer(TestLive, { excludeTestServices: true })("Local resources", (it) => {
  it.effect(scenarios.localResources.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          target = yield* Target,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const send = (method: "GET" | "POST" | "DELETE", path: string, data?: unknown) =>
          session.send(method, path, data, headers);
        const files = [
          {
            path: "index.ts",
            content: `import {defineApp,defineProvider,secrets,query,workflow,object,string} from "apps";
const service=defineProvider({name:"Local resources",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const identity=query({input:object({})},async ctx=>ctx.accounts.service.id);
const capture=workflow({input:object({})},async ctx=>ctx.step.do("identity",async step=>step.accounts.service.id));
export default defineApp({accounts:{service}},{queries:{identity},workflows:{capture}});`,
          },
        ];
        const { app } = yield* body(
          ProviderApp,
          yield* send("POST", "/v1/apps/deploy", {
            owner: "local",
            name: `Local resources ${randomUUID().slice(0, 8)}`,
            files,
          }),
        );
        const owned = [`/v1/apps/${app.id}`];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(owned, (path) => send("DELETE", path)).pipe(Effect.orDie),
        );
        for (const label of ["Personal", "Work"]) {
          const account = yield* body(
            Resource,
            yield* send("POST", "/v1/accounts", {
              owner: "local",
              provider: app.requirements.accounts.service.provider,
              method: "key",
              label,
              fields: { token: "synthetic-local-resource-key" },
            }),
          );
          owned.push(`/v1/accounts/${account.id}`);
          expect(
            (yield* send("POST", `/v1/apps/${app.id}/profiles`, {
              owner: "local",
              subject: "local",
              name: label,
              accounts: { service: account.id },
              idempotencyKey: randomUUID(),
            })).status,
          ).toBe(200);
        }
        const { url } = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* send("POST", "/auth/pair"),
        );
        yield* browser.use("Pair local resource browser", (page) => page.goto(url));
        yield* browser.use("Local dashboard ready", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor(),
        );
        yield* browser.use("Open local tools", (page) => page.goto(`/apps/${app.id}?view=tools`));
        const choose = (label: string) =>
          Effect.gen(function* () {
            yield* browser.use(`Choose ${label}`, (page) =>
              page.getByRole("button", { name: "Choose profile", exact: true }).click(),
            );
            yield* browser.use(`Choose ${label}`, (page) =>
              page.getByRole("menuitemradio", { name: label, exact: true }).click(),
            );
          });
        for (const label of ["Personal", "Work"]) {
          yield* choose(label);
          yield* browser.use(`${label} local tools load`, (page) =>
            page.getByRole("button", { name: "queries.identity", exact: true }).waitFor(),
          );
        }
        yield* browser.use("Open local workflows", (page) =>
          page
            .getByRole("navigation", { name: "App navigation" })
            .getByRole("link", { name: "Workflows", exact: true })
            .click(),
        );
        yield* browser.use("Expand local Work workflow", (page) =>
          page.getByRole("button", { name: "capture", exact: true }).click(),
        );
        yield* browser.use("Start local Work workflow", (page) =>
          page.getByRole("button", { name: "Start workflow", exact: true }).click(),
        );
        yield* browser.use("Local workflow completes", (page) =>
          page.getByRole("button", { name: "View capture run: Complete", exact: true }).waitFor(),
        );
        yield* choose("Personal");
        yield* browser.use("Personal workflows are ready", (page) =>
          page.getByRole("button", { name: "capture", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Local Personal has separate history", (page) =>
            page.getByRole("button", { name: /^View capture run:/ }).count(),
          ),
        ).toBe(0);
        const simple = yield* body(
          Schema.Struct({ app: Resource }),
          yield* send("POST", "/v1/apps/deploy", {
            owner: "local",
            name: `Plain workflow ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import {defineApp,workflow,query,object} from "apps";export default defineApp({accounts:{}}, {queries:{hello:query({input:object({})},async()=>"hello")},workflows:{capture:workflow({input:object({})},async ctx=>ctx.step.do("plain",async()=>"No account required"))}});`,
              },
            ],
          }),
        );
        owned.unshift(`/v1/apps/${simple.app.id}`);
        yield* browser.use("Open no-provider workflow", (page) =>
          page.goto(`/apps/${simple.app.id}?view=workflows`),
        );
        yield* browser.use("Inspect no-provider definition", (page) =>
          page.getByRole("button", { name: "capture", exact: true }).click(),
        );
        yield* browser.use("Run without installing an account", (page) =>
          page.getByRole("button", { name: "Start workflow", exact: true }).click(),
        );
        yield* browser.use("No-provider run completes", (page) =>
          page.getByRole("button", { name: "View capture run: Complete", exact: true }).waitFor(),
        );
        expect((yield* send("GET", `/v1/apps/${simple.app.id}/profiles`)).body).toEqual([]);
        yield* browser.checkpoint("Local profile selection and no-provider workflows");
      }),
    ),
  );
});
